import type { On } from 'claude-code'
export function register(on: On) {
  const stamp = () => new Date().toISOString().slice(11, 23)
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'aside', description: 'probe side chat', argumentHint: '[question]', immediate: true })
    return next(e)
  })
  on('command.run', { command: 'aside' }, async ($, e, next) => {
    const t0 = Date.now()
    const r = await $.model.fork({ prompt: `Side question, answer in one sentence without tools: ${e.args}` })
    $.ui.log(`[pcost ${stamp()}] fork(${JSON.stringify(e.args)}) -> ${r === null ? 'null' : `usage input=${r.usage.input_tokens} output=${r.usage.output_tokens} cacheRead=${r.usage.cache_read_input_tokens} cacheCreate=${r.usage.cache_creation_input_tokens} len=${r.text.length} head=${JSON.stringify(r.text.slice(0, 120))}`} in ${Date.now() - t0}ms`)
    return { text: r === null ? 'aside: (null)' : `aside: ${r.text.slice(0, 200)}` }
  })
  on('turn.complete', async ($, e, next) => {
    const msgs = await $.session.messages()
    $.ui.log(`[pcost ${stamp()}] turn.complete messages n=${msgs.length} ${JSON.stringify(msgs.map(m => [m.role, m.text.length, m.text.slice(0, 50)]))}`)
    return next(e)
  })
}
