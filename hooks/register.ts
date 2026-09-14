import type { On, PluginOptions } from 'claude-code'

/**
 * aside: a read-only side chat beside the transcript.
 *
 * `/aside [question]` opens the pane (focused when the composer is empty);
 * Tab puts the focus ring on the pane's input, Enter asks, Esc hands the keys
 * back to the composer, ctrl+x tab focuses the pane again.
 *
 * Each question is one `$.model.fork` over the session's own transcript as
 * of the last completed turn: tool-less, off the transcript, sharing the
 * main thread's prompt cache; it answers during a later turn too, without
 * seeing the turn in flight. A fork takes exactly one user message, so the
 * side chat's own history is rendered into each prompt.
 *
 * Until the session's first turn has completed there is no snapshot to fork
 * (`$.model.fork` resolves null at once). Then, with `liveFallback` on, the
 * question is answered by `$.model.complete` over the text of
 * `$.session.messages()`: immediate, uncached, without the session's system
 * prompt, and marked "live" in the pane. With it off, the question queues
 * and a fork answers it when the turn ends.
 *
 * What this module calls on `$` (the static listing `claude plugin validate`
 * prints): clock.now, command.register, model.complete, model.fork,
 * session.messages, ui.close, ui.invalidate, ui.open, ui.resolve. All reads
 * and drawing: no fs, process, http, store, tool or prompt verbs, so the mod
 * cannot reach the working tree, the network, or the main thread's prompt.
 */

type Usage = { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }

type Exchange = {
  q: string
  a: string | null
  askedAt: number
  ms?: number
  note?: string
  kind?: 'fork' | 'live'
  queued?: true
}

type Host = {
  fork: (prompt: string) => Promise<{ text: string; usage: Usage } | null>
  messages: () => Promise<readonly { role: 'user' | 'assistant'; text: string }[]>
  complete: (prompt: string) => Promise<string>
  invalidate: () => void
  open: () => Promise<void>
  close: () => Promise<void>
  now: () => number
}

export const PANE_ID = 'aside'
export const DEFAULTS = { liveFallback: true, liveModel: 'haiku', maxHistory: 8 } as const
export const MAX_CHARS_PER_ANSWER = 1200
export const LIVE_TRANSCRIPT_CHARS = 60000
const LIVE_SYSTEM =
  'You answer read-only side questions about a Claude Code session from its transcript. No tools; do not continue the task; answer briefly in plain prose.'

const clip = (text: string): string =>
  text.length > MAX_CHARS_PER_ANSWER ? `${text.slice(0, MAX_CHARS_PER_ANSWER)}…` : text

export function register(on: On, options: PluginOptions = {}) {
  const liveFallback = typeof options.liveFallback === 'boolean' ? options.liveFallback : DEFAULTS.liveFallback
  const liveModel = typeof options.liveModel === 'string' && options.liveModel !== '' ? options.liveModel : DEFAULTS.liveModel
  const maxHistory =
    typeof options.maxHistory === 'number' && options.maxHistory >= 1 ? Math.floor(options.maxHistory) : DEFAULTS.maxHistory

  let host: Host | null = null
  let history: Exchange[] = []
  let queued: Exchange[] = []
  let inFlight = 0

  const promptOf = (question: string): string => {
    const prior = history
      .filter(x => x.a !== null && x.kind !== undefined)
      .slice(-maxHistory)
      .map(x => `Q: ${x.q}\nA: ${x.a}`)
      .join('\n\n')
    return [
      'This is a read-only side question about the conversation above. Answer from the transcript so far.',
      'Do not use tools, do not propose edits, do not continue the main task; answer briefly in plain prose.',
      prior === '' ? '' : `Earlier side questions and their answers:\n\n${prior}`,
      `Side question: ${question}`,
    ]
      .filter(part => part !== '')
      .join('\n\n')
  }

  async function answerLive(h: Host, entry: Exchange): Promise<void> {
    const messages = await h.messages()
    if (messages.length === 0) {
      entry.a = '(nothing to ask about yet: the transcript is empty)'
      return
    }
    let rendered = messages.map(m => `${m.role.toUpperCase()}: ${m.text}`).join('\n\n')
    if (rendered.length > LIVE_TRANSCRIPT_CHARS) rendered = `…${rendered.slice(-LIVE_TRANSCRIPT_CHARS)}`
    const text = await h.complete(`Transcript so far:\n\n${rendered}\n\n${promptOf(entry.q)}`)
    entry.a = clip(text)
    entry.kind = 'live'
    entry.note = `${rendered.length} chars of transcript sent uncached`
  }

  function run(h: Host, entry: Exchange): void {
    inFlight += 1
    void h
      .fork(promptOf(entry.q))
      .then(async r => {
        if (r !== null) {
          entry.a = clip(r.text)
          entry.kind = 'fork'
          entry.note = `read ${r.usage.cache_read_input_tokens} · new ${r.usage.input_tokens + r.usage.cache_creation_input_tokens} · out ${r.usage.output_tokens}`
          return
        }
        if (liveFallback) {
          await answerLive(h, entry)
          return
        }
        entry.queued = true
        queued.push(entry)
      })
      .catch((err: unknown) => {
        entry.a = `(no answer: ${err instanceof Error ? err.message : String(err)})`
      })
      .then(() => {
        if (entry.a !== null) entry.ms = h.now() - entry.askedAt
        inFlight -= 1
        h.invalidate()
      })
  }

  function ask(question: string): void {
    const h = host
    const q = question.trim()
    if (!h || q === '') return
    const entry: Exchange = { q, a: null, askedAt: h.now() }
    history = [...history, entry]
    h.invalidate()
    run(h, entry)
  }

  on('session.start', async ($, e, next) => {
    host = {
      fork: prompt => $.model.fork({ prompt }),
      messages: () => $.session.messages(),
      complete: prompt => $.model.complete({ model: liveModel, maxTokens: 400, system: LIVE_SYSTEM, prompt }),
      invalidate: () => $.ui.invalidate('ui.render'),
      open: () => $.ui.open({ id: PANE_ID, title: 'aside', focus: true }),
      close: () => $.ui.close({ id: PANE_ID }),
      now: () => $.clock.now(),
    }
    await $.command.register({
      name: 'aside',
      description: 'Read-only side chat about this session (opens a pane; Tab focuses its input)',
      argumentHint: '[question]',
      immediate: true,
    })
    return next(e)
  })

  on('command.run', { command: 'aside' }, async ($, e, next) => {
    if (!host) return next(e)
    await host.open()
    ask(e.args)
    return {}
  })

  // Questions that found no snapshot (liveFallback off) are answered by a
  // fork as soon as the turn in flight ends.
  on('turn.complete', ($, e, next) => {
    const h = host
    const waiting = queued
    queued = []
    if (h) {
      for (const entry of waiting) {
        entry.queued = undefined
        run(h, entry)
      }
    }
    return next(e)
  })

  on('ui.render', { component: 'Pane' }, ($, e, next) => {
    if (e.requestId !== PANE_ID) return next(e)
    const { Box, Text, Input, Button } = $.ui.resolve(e)
    const width = Math.max(20, e.props.bodyColumns - 1)
    const shown = history.slice(-maxHistory)
    const rows = shown.map((x, i) =>
      Box({
        key: `x${i}`,
        flexDirection: 'column',
        marginTop: i === 0 ? 0 : 1,
        width,
        children: [
          Text({ bold: true, color: 'cyan', wrap: 'wrap', children: `you: ${x.q}` }),
          x.a === null
            ? Text({ dimColor: true, children: x.queued ? 'aside: waiting for this turn to end…' : 'aside: thinking…' })
            : Text({ wrap: 'wrap', children: `aside: ${x.a}` }),
          x.a !== null && x.ms !== undefined
            ? Text({ dimColor: true, children: `${x.kind ?? 'error'} · ${x.ms} ms${x.note ? ` · ${x.note}` : ''}` })
            : null,
        ],
      }),
    )
    const header =
      history.length === 0
        ? 'Ask about the session so far. Read-only: no tools, nothing goes into the main thread.'
        : `${history.length} question${history.length === 1 ? '' : 's'}${inFlight ? ` · ${inFlight} pending` : ''}`
    return Box({
      flexDirection: 'column',
      width,
      children: [
        Text({ dimColor: true, children: header }),
        ...rows,
        Box({
          marginTop: 1,
          flexDirection: 'column',
          children: [
            Input({
              key: 'q',
              label: '> ',
              placeholder: e.props.isFocused ? 'Tab to focus, type, Enter to ask, Esc to leave' : 'ctrl+x tab focuses the pane',
              submitLabel: 'ask',
              onSubmit: () => undefined,
            }),
            Box({
              flexDirection: 'row',
              gap: 1,
              children: [
                Button({ key: 'clear', label: 'Clear', onPress: () => undefined }),
                Button({ key: 'close', label: 'Close', onPress: () => undefined }),
              ],
            }),
          ],
        }),
      ],
    })
  })

  // The pane's events are answered here rather than in the element closures:
  // a closure handle belongs to one drawing, and a submit that lands during a
  // redraw is dropped by core ("no handler is held under handle N"), while the
  // hook still sees the event and its value.
  on('ui.input', { plugin: 'aside', element: 'q' }, ($, e, next) => {
    if (e.kind !== 'submit') return next(e)
    ask(e.value)
    return { element: e.element, value: e.value }
  })

  on('ui.press', { plugin: 'aside' }, ($, e, next) => {
    if (e.element === 'clear') {
      history = []
      host?.invalidate()
      return { element: e.element }
    }
    if (e.element === 'close') {
      void host?.close()
      return { element: e.element }
    }
    return next(e)
  })
}
