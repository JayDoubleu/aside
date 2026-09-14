import type { On } from 'claude-code'
export function register(on: On) {
  const stamp = () => new Date().toISOString().slice(11, 23)
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'aside', description: 'probe', argumentHint: '[q]', immediate: true })
    return next(e)
  })
  on('command.run', { command: 'aside' }, async ($, e, next) => {
    const log = (t: string) => $.ui.log(`[p6 ${stamp()}] ${t}`)
    const t0 = Date.now()
    const fork = await $.model.fork({ prompt: `One sentence: ${e.args}` })
    log(`fork -> ${fork === null ? 'null' : 'text ' + fork.text.length} in ${Date.now() - t0}ms`)
    const t1 = Date.now()
    const msgs = await $.session.messages()
    log(`session.messages n=${msgs.length} in ${Date.now() - t1}ms last=${JSON.stringify(msgs.map(m => [m.role, m.text.length]))}`)
    const rendered = msgs.map(m => `${m.role.toUpperCase()}: ${m.text.slice(0, 4000)}`).join('\n\n')
    const t2 = Date.now()
    void $.model.complete({ model: 'haiku', maxTokens: 200, system: 'You answer read-only side questions about a transcript. No tools.', prompt: `Transcript so far:\n\n${rendered}\n\nSide question: ${e.args}` })
      .then(text => log(`model.complete(haiku) -> ${JSON.stringify(text.slice(0, 160))} in ${Date.now() - t2}ms (transcript ${rendered.length} chars)`), err => log(`model.complete rejected ${String(err)}`))
    return {}
  })
  on('turn.complete', async ($, e, next) => {
    const t0 = Date.now()
    const fork = await $.model.fork({ prompt: 'One word: what was the last user message about?' })
    $.ui.log(`[p6 ${stamp()}] turn.complete fork -> ${fork === null ? 'null' : 'text ' + fork.text.length} in ${Date.now() - t0}ms`)
    return next(e)
  })
}
