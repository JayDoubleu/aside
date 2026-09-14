import type { On } from 'claude-code'

type Host = {
  log: (t: string) => void
  fork: (prompt: string) => Promise<{ text: string; usage: unknown } | null>
  invalidate: () => void
  storeSet: (k: string, v: unknown) => Promise<void>
  storeGet: (k: string) => Promise<unknown>
  open: (id: string, title: string, focus: boolean) => Promise<void>
  close: (id: string) => Promise<void>
  now: () => number
}

export function register(on: On) {
  let host: Host | null = null
  let state = { band: 'idle', pane: 'idle', renders: 0, paneRenders: 0, mode: 'short' }
  const stamp = () => new Date().toISOString().slice(11, 23)

  on('session.start', async ($, e, next) => {
    host = {
      log: t => $.ui.log(`[p2 ${stamp()}] ${t}`),
      fork: prompt => $.model.fork({ prompt }),
      invalidate: () => $.ui.invalidate('ui.render'),
      storeSet: (k, v) => $.store.set(k, v),
      storeGet: k => $.store.get(k),
      open: (id, title, focus) => $.ui.open(focus ? { id, title, focus: true } : { id, title }),
      close: id => $.ui.close({ id }),
      now: () => $.clock.now(),
    }
    host.log(`session.start isInteractive=${e.isInteractive} surface=${JSON.stringify(await $.session.surface().catch(String))}`)
    await $.command.register({ name: 'aside', description: 'probe side chat pane', argumentHint: '[question]', immediate: true })
    return next(e)
  })

  function ask(site: 'band' | 'pane', value: string) {
    const h = host
    if (!h) return
    const t0 = h.now()
    state = { ...state, [site]: `asked: ${value}` }
    h.invalidate()
    void h.fork(`Side question from the ${site} (one sentence, no tools): ${value}`).then(r => {
      state = { ...state, [site]: `answer(${h.now() - t0}ms): ${r === null ? '(null: cold)' : r.text.slice(0, 160)}` }
      h.log(`${site} fork settled in ${h.now() - t0}ms -> ${r === null ? 'null' : JSON.stringify(r.usage)}; store.set + invalidate`)
      return h.storeSet(`p2.${site}`, state[site]).then(() => h.invalidate())
    }, err => h.log(`${site} fork rejected ${String(err)}`))
  }

  on('ui.render', { component: 'AbovePrompt' }, ($, e, next) => {
    state.renders += 1
    host?.log(`render AbovePrompt #${state.renders} surface=${e.surface} isWorking=${e.props.isWorking} hasSurvey=${e.props.hasSurvey} maxRows=${e.props.maxRows} viewport=${JSON.stringify(e.viewport)}`)
    if (e.surface !== 'terminal') return next(e)
    const { Box, Text, Input, Button, Select } = $.ui.resolve(e)
    return Box({
      flexDirection: 'column', borderStyle: 'round', borderColor: 'cyan', paddingX: 1,
      children: [
        Text({ bold: true, children: `ASIDE BAND r${state.renders} working=${e.props.isWorking} | ${state.band}` }),
        Input({ key: 'bandq', label: 'ask> ', placeholder: 'type a side question', submitLabel: 'ask', onInput: (v, ev) => host?.log(`onInput change value=${JSON.stringify(v)}`), onSubmit: (v, ev) => { host?.log(`onSubmit value=${JSON.stringify(v)} e=${JSON.stringify(ev)}`); ask('band', v) } }),
        Box({ flexDirection: 'row', gap: 1, children: [
          Button({ key: 'open', label: 'Open pane', hotkey: 'o', onPress: () => { host?.log('onPress open'); void host?.open('aside', 'aside', true) } }),
          Button({ key: 'ping', label: 'Ping', hotkey: 'p', onPress: () => { host?.log('onPress ping'); state = { ...state, band: `pinged at ${stamp()}` }; host?.invalidate() } }),
          Select({ key: 'mode', label: 'mode', value: state.mode, options: [{ value: 'short', label: 'short' }, { value: 'long', label: 'long' }], onSelect: (v, ev) => { host?.log(`onSelect value=${v}`); state = { ...state, mode: v }; host?.invalidate() } }),
        ] }),
      ],
    })
  })

  on('ui.render', { component: 'Pane' }, ($, e, next) => {
    if (e.requestId !== 'aside') return next(e)
    state.paneRenders += 1
    host?.log(`render Pane #${state.paneRenders} placement=${e.props.placement} isFocused=${e.props.isFocused} bodyColumns=${e.props.bodyColumns} scroll=${JSON.stringify(e.props.scroll)}`)
    const { Box, Text, Input, Button } = $.ui.resolve(e)
    return Box({ flexDirection: 'column', children: [
      Text({ children: `ASIDE PANE r${state.paneRenders} focused=${e.props.isFocused} | ${state.pane}` }),
      Input({ key: 'paneq', label: 'pane> ', placeholder: 'ask in pane', onSubmit: v => { host?.log(`pane onSubmit value=${JSON.stringify(v)}`); ask('pane', v) } }),
      Button({ key: 'closepane', label: 'Close', onPress: () => { host?.log('onPress closepane'); void host?.close('aside') } }),
    ] })
  })

  on('ui.press', { plugin: 'p2' }, ($, e, next) => { host?.log(`ui.press ${JSON.stringify(e)}`); const t = Date.now(); return next(e).then(r => { host?.log(`ui.press next settled ${Date.now() - t}ms -> ${JSON.stringify(r)}`); return r }) })
  on('ui.input', { plugin: 'p2' }, ($, e, next) => { host?.log(`ui.input ${JSON.stringify(e)}`); return next(e) })
  on('ui.select', { plugin: 'p2' }, ($, e, next) => { host?.log(`ui.select ${JSON.stringify(e)}`); return next(e) })
  on('ui.open', ($, e, next) => { host?.log(`ui.open ${JSON.stringify(e)}`); return next(e) })
  on('ui.close', ($, e, next) => { host?.log(`ui.close ${JSON.stringify(e)}`); return next(e) })

  on('command.run', { command: 'aside' }, async ($, e, next) => {
    host?.log(`command.run aside args=${JSON.stringify(e.args)} origin=${JSON.stringify(e.origin)} presentation=${JSON.stringify((e as any).presentation)}`)
    await $.ui.open({ id: 'aside', title: 'aside', focus: true })
    if (e.args.trim()) ask('pane', e.args.trim())
    return {}
  })

  on('prompt.submit', ($, e, next) => { host?.log(`prompt.submit origin=${JSON.stringify(e.origin)} text=${JSON.stringify(e.text?.slice(0, 120))}`); return next(e) })
  on('turn.complete', async ($, e, next) => {
    const msgs = await $.session.messages()
    host?.log(`turn.complete messages n=${msgs.length} ${JSON.stringify(msgs.map(m => [m.role, m.text.slice(0, 60)]))}`)
    return next(e)
  })
}
