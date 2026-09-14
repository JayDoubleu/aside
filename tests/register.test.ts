import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

import { MAX_CHARS_PER_ANSWER } from '../hooks/register.ts'
import { ASIDE_RUN, CHANGE, PANE, PRESS, SESSION, SUBMIT, USAGE, deferred, elementsOf, fakeEngine, textsOf } from './harness.ts'

const started = async (opts: Parameters<typeof fakeEngine>[0] = {}) => {
  const engine = fakeEngine(opts)
  await engine.dispatch('session.start', SESSION)
  return engine
}

const drawn = async (engine: Awaited<ReturnType<typeof started>>) => textsOf(await engine.dispatch('ui.render', PANE)).join('\n')

describe('registration', () => {
  test('session.start registers /aside as an immediate command', async () => {
    const engine = await started()
    assert.deepEqual(engine.of('command.register').map(c => c.args[0]), [
      { name: 'aside', description: 'Read-only side chat about this session (opens a pane; Tab focuses its input)', argumentHint: '[question]', immediate: true },
    ])
  })

  test('the module only ever reads and draws: no fs, process, http, store, tool or prompt verbs', async () => {
    const engine = await started({ fork: () => ({ text: 'A', usage: USAGE }) })
    await engine.dispatch('command.run', ASIDE_RUN('q'))
    await engine.dispatch('ui.render', PANE)
    await engine.dispatch('ui.press', PRESS('close'))
    await engine.flush()
    const allowed = ['command.register', 'model.complete', 'model.fork', 'session.messages', 'ui.close', 'ui.invalidate', 'ui.open', 'ui.resolve']
    for (const verb of engine.verbs()) assert.ok(allowed.includes(verb), `unexpected verb ${verb}`)
    assert.deepEqual(engine.registrations.map(r => r.event), ['session.start', 'command.run', 'turn.complete', 'ui.render', 'ui.input', 'ui.press'])
  })
})

describe('/aside', () => {
  test('opens the pane focused, answers with a fork, and puts no text in the transcript', async () => {
    const prompts: string[] = []
    const reply = deferred<{ text: string; usage: typeof USAGE }>()
    const engine = await started({ fork: prompt => { prompts.push(prompt); return reply.promise } })

    const result = await engine.dispatch('command.run', ASIDE_RUN('what did I ask?'), () => { throw new Error('core must not run: the hook answers') })
    assert.deepEqual(result, {}, 'a { text } answer would land in the transcript as user messages')
    assert.deepEqual(engine.of('ui.open').map(c => c.args[0]), [{ id: 'aside', title: 'aside', focus: true }])
    assert.match(await drawn(engine), /1 question · 1 pending\nyou: what did I ask\?\naside: thinking…/)

    engine.tick(1250)
    reply.resolve({ text: 'You asked about 2+2.', usage: USAGE })
    await engine.flush()
    assert.equal(prompts.length, 1)
    assert.match(prompts[0]!, /read-only side question/)
    assert.match(prompts[0]!, /Side question: what did I ask\?$/)
    assert.doesNotMatch(prompts[0]!, /Earlier side questions/)
    const text = await drawn(engine)
    assert.match(text, /1 question/)
    assert.match(text, /aside: You asked about 2\+2\./)
    assert.match(text, /fork · 1250 ms · read 72848 · new 242 · out 100/)
    assert.ok(engine.of('ui.invalidate').length >= 2, 'invalidated when asked and when answered')
  })

  test('/aside with no question only opens the pane', async () => {
    const engine = await started()
    await engine.dispatch('command.run', ASIDE_RUN('   '))
    await engine.flush()
    assert.equal(engine.of('model.fork').length, 0)
    assert.match(await drawn(engine), /Ask about the session so far\. Read-only/)
  })

  test('threads its own history into the next question', async () => {
    const prompts: string[] = []
    let n = 0
    const engine = await started({ fork: prompt => { prompts.push(prompt); n += 1; return { text: `answer ${n}`, usage: USAGE } } })
    await engine.dispatch('command.run', ASIDE_RUN('first?'))
    await engine.flush()
    await engine.dispatch('ui.input', SUBMIT('second?'))
    await engine.flush()
    assert.equal(prompts.length, 2)
    assert.match(prompts[1]!, /Earlier side questions and their answers:\n\nQ: first\?\nA: answer 1\n\nSide question: second\?$/)
    assert.match(await drawn(engine), /2 questions/)
  })

  test('caps the history carried in a prompt at maxHistory and the answer at MAX_CHARS_PER_ANSWER', async () => {
    const prompts: string[] = []
    const engine = await started({ options: { maxHistory: 2 }, fork: prompt => { prompts.push(prompt); return { text: 'x'.repeat(5000), usage: USAGE } } })
    for (const q of ['a', 'b', 'c', 'd']) { await engine.dispatch('ui.input', SUBMIT(q)); await engine.flush() }
    const last = prompts[3]!
    assert.doesNotMatch(last, /Q: a\n/)
    assert.match(last, /Q: b\n/)
    assert.match(last, /Q: c\n/)
    const answers = textsOf(await engine.dispatch('ui.render', PANE)).filter(t => t.startsWith('aside: x'))
    assert.ok(answers.length > 0)
    for (const a of answers) assert.equal(a.length, 'aside: '.length + MAX_CHARS_PER_ANSWER + 1, 'clipped with an ellipsis')
  })
})

describe('pane events', () => {
  test('a submit is answered in the hook itself, never through the drawing\'s closure', async () => {
    const engine = await started({ fork: () => ({ text: 'ok', usage: USAGE }) })
    const result = await engine.dispatch('ui.input', SUBMIT('why?'), () => { throw new Error('core reached: the redraw race would drop this') })
    assert.deepEqual(result, { element: 'q', value: 'why?' })
    await engine.flush()
    assert.equal(engine.of('model.fork').length, 1)
  })

  test('a change passes through untouched', async () => {
    const engine = await started()
    let reached = false
    const result = await engine.dispatch('ui.input', CHANGE('wh'), e => { reached = true; return { element: e.element, value: e.value } })
    assert.ok(reached)
    assert.deepEqual(result, { element: 'q', value: 'wh' })
    assert.equal(engine.of('model.fork').length, 0)
  })

  test('an empty submit asks nothing', async () => {
    const engine = await started()
    await engine.dispatch('ui.input', SUBMIT('   '))
    await engine.flush()
    assert.equal(engine.of('model.fork').length, 0)
  })

  test('Clear empties the history and Close closes the pane', async () => {
    const engine = await started({ fork: () => ({ text: 'ok', usage: USAGE }) })
    await engine.dispatch('ui.input', SUBMIT('q'))
    await engine.flush()
    assert.deepEqual(await engine.dispatch('ui.press', PRESS('clear')), { element: 'clear' })
    assert.match(await drawn(engine), /Ask about the session so far/)
    assert.deepEqual(await engine.dispatch('ui.press', PRESS('close')), { element: 'close' })
    await engine.flush()
    assert.deepEqual(engine.of('ui.close').map(c => c.args[0]), [{ id: 'aside' }])
  })

  test('presses on other plugins\' buttons pass through', async () => {
    const engine = await started()
    let reached = false
    await engine.dispatch('ui.press', { ...PRESS('x'), plugin: 'someone-else' }, () => { reached = true; return { element: 'x' } })
    assert.ok(reached)
  })

  test('draws the input, the two buttons and every exchange', async () => {
    const engine = await started({ fork: () => ({ text: 'A', usage: USAGE }) })
    await engine.dispatch('ui.input', SUBMIT('Q'))
    await engine.flush()
    const tree = await engine.dispatch('ui.render', PANE)
    assert.deepEqual(elementsOf(tree, 'Input').map(n => n.key), ['q'])
    assert.deepEqual(elementsOf(tree, 'Button').map(n => [n.key, n.label]), [['clear', 'Clear'], ['close', 'Close']])
    assert.deepEqual(textsOf(tree).slice(0, 3), ['1 question', 'you: Q', 'aside: A'])
  })

  test('leaves other panes to their owners', async () => {
    const engine = await started()
    let reached = false
    await engine.dispatch('ui.render', { ...PANE, requestId: 'diff' }, () => { reached = true; return { type: 'engine', ref: 0 } })
    assert.ok(reached)
    assert.equal(engine.of('ui.resolve').length, 0)
  })
})

describe('while a turn is running (fork resolves null)', () => {
  const transcript = () => [
    { role: 'user' as const, text: 'Count to 1500.', toolUses: [] },
    { role: 'assistant' as const, text: '', toolUses: [] },
  ]

  test('liveFallback (default on) answers from session.messages through model.complete', async () => {
    const requests: { model: string; prompt: string; system?: string }[] = []
    const engine = await started({ fork: () => null, messages: transcript, complete: r => { requests.push(r); return 'They asked for a count.' } })
    await engine.dispatch('command.run', ASIDE_RUN('what is asked?'))
    engine.tick(800)
    await engine.flush()
    assert.equal(requests.length, 1)
    assert.equal(requests[0]!.model, 'haiku')
    assert.match(requests[0]!.system ?? '', /No tools/)
    assert.match(requests[0]!.prompt, /^Transcript so far:\n\nUSER: Count to 1500\.\n\nASSISTANT: \n\n/)
    assert.match(requests[0]!.prompt, /Side question: what is asked\?$/)
    const text = await drawn(engine)
    assert.match(text, /aside: They asked for a count\./)
    assert.match(text, /live · 800 ms · 33 chars of transcript sent uncached/)
  })

  test('liveModel is honoured', async () => {
    const requests: { model: string }[] = []
    const engine = await started({ options: { liveModel: 'sonnet' }, fork: () => null, messages: transcript, complete: r => { requests.push(r); return 'x' } })
    await engine.dispatch('ui.input', SUBMIT('q'))
    await engine.flush()
    assert.equal(requests[0]!.model, 'sonnet')
  })

  test('an empty transcript is said so, without a completion', async () => {
    const engine = await started({ fork: () => null, messages: () => [] })
    await engine.dispatch('ui.input', SUBMIT('q'))
    await engine.flush()
    assert.equal(engine.of('model.complete').length, 0)
    assert.match(await drawn(engine), /nothing to ask about yet/)
  })

  test('liveFallback off: the question waits and a fork answers it at turn.complete', async () => {
    let warm = false
    const engine = await started({ options: { liveFallback: false }, fork: () => (warm ? { text: 'now answered', usage: USAGE } : null) })
    await engine.dispatch('ui.input', SUBMIT('later?'))
    await engine.flush()
    assert.equal(engine.of('model.complete').length, 0)
    assert.match(await drawn(engine), /aside: waiting for this turn to end…/)
    warm = true
    let reached = false
    await engine.dispatch('turn.complete', { durationMs: 1 }, () => { reached = true; return {} })
    assert.ok(reached, 'turn.complete passes through')
    await engine.flush()
    assert.equal(engine.of('model.fork').length, 2)
    assert.match(await drawn(engine), /aside: now answered/)
  })
})

describe('failures', () => {
  test('a rejected fork shows an error row instead of throwing', async () => {
    const engine = await started({ fork: () => { throw new Error('the session\'s model budget for this plugin is spent') } })
    await engine.dispatch('ui.input', SUBMIT('q'))
    await engine.flush()
    assert.match(await drawn(engine), /aside: \(no answer: the session's model budget for this plugin is spent\)/)
  })
})
