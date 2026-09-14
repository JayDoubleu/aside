import type { On } from 'claude-code'
export function register(on: On) {
  const stamp = () => new Date().toISOString().slice(11, 23)
  on('prompt.submit', ($, e, next) => { $.ui.log(`[witness ${stamp()}] prompt.submit origin=${JSON.stringify(e.origin)} text=${JSON.stringify(e.text?.slice(0, 100))}`); return next(e) })
  on('turn.complete', async ($, e, next) => {
    const msgs = await $.session.messages()
    $.ui.log(`[witness ${stamp()}] turn.complete messages n=${msgs.length} ${JSON.stringify(msgs.map(m => [m.role, m.text.slice(0, 70)]))}`)
    return next(e)
  })
  on('plugin.register', ($, e, next) => { $.ui.log(`[witness ${stamp()}] plugin.register name=${e.name} tier=${e.tier} provenance=${e.provenance} uses=${JSON.stringify(e.uses)}`); return next(e) })
  on('ui.render', { component: 'Pane' }, ($, e, next) => { $.ui.log(`[witness ${stamp()}] Pane render id=${e.requestId} focused=${e.props.isFocused} placement=${e.props.placement}`); return next(e) })
}
