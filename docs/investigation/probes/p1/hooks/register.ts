import type { On } from 'claude-code'

export function register(on: On) {
  let turns = 0
  let pendingFork: Promise<unknown> | null = null
  const stamp = () => new Date().toISOString().slice(11, 23)

  on('session.start', async ($, e, next) => {
    const log = (t: string) => $.ui.log(`[p1 ${stamp()}] ${t}`)
    log(`session.start surface=${JSON.stringify(await $.session.surface().catch(String))} isInteractive=${e.isInteractive}`)
    log(`$.plugin.name=${$.plugin.name} root=${$.plugin.root}`)
    // fork before any turn: expect null (cold)
    const t0 = Date.now()
    const cold = await $.model.fork({ prompt: 'Say COLD.' }).catch(err => `THREW ${String(err)}`)
    log(`fork@session.start -> ${cold === null ? 'null' : JSON.stringify(cold).slice(0, 200)} in ${Date.now() - t0}ms`)
    // shape rejections
    for (const bad of [{ messages: [{ role: 'user', content: 'hi' }] }, { prompt: '' }, { prompt: 'x', system: 'y', maxTokens: 5 }, 'str']) {
      const r = await $.model.fork(bad as any).then((v: unknown) => `resolved ${v === null ? 'null' : JSON.stringify(v).slice(0, 120)}`).catch((err: unknown) => `rejected: ${String(err)}`)
      log(`fork(${JSON.stringify(bad).slice(0, 60)}) -> ${r}`)
    }
    try {
      const reg = await $.command.register({ name: 'aside', description: 'probe side chat', argumentHint: '[question]', immediate: true })
      log(`command.register -> ${JSON.stringify(reg)}`)
    } catch (err) { log(`command.register threw ${String(err)}`) }
    const prev = await $.store.get('p1.runs').catch(String)
    await $.store.set('p1.runs', Number(prev ?? 0) + 1)
    log(`store p1.runs prev=${JSON.stringify(prev)} keys=${JSON.stringify(await $.store.keys())}`)
    return next(e)
  })

  on('command.run', { command: 'aside' }, async ($, e, next) => {
    const log = (t: string) => $.ui.log(`[p1 ${stamp()}] ${t}`)
    log(`command.run aside args=${JSON.stringify(e.args)} origin=${JSON.stringify(e.origin)}`)
    const t0 = Date.now()
    const r = await $.model.fork({ prompt: `Side question (answer in one short sentence, do not use tools): ${e.args}` })
    log(`fork@command.run -> ${r === null ? 'null' : JSON.stringify({ len: r.text.length, usage: r.usage, head: r.text.slice(0, 80) })} in ${Date.now() - t0}ms`)
    return { text: `aside answered: ${r?.text ?? '(null)'}` }
  })

  on('turn.complete', async ($, e, next) => {
    const log = (t: string) => $.ui.log(`[p1 ${stamp()}] ${t}`)
    turns += 1
    const n = turns
    const msgs = await $.session.messages().catch(err => `THREW ${String(err)}`)
    if (typeof msgs === 'string') log(`turn ${n} session.messages ${msgs}`)
    else log(`turn ${n} session.messages n=${msgs.length} ${JSON.stringify(msgs.map(m => ({ role: m.role, text: m.text.length, tu: m.toolUses.length, tr: m.toolResults?.length })))}`)
    if (n === 1) {
      // awaited fork after first turn
      const t0 = Date.now()
      const r = await $.model.fork({ prompt: 'In one short sentence: what did the user ask in this conversation? Do not use tools.' })
      log(`turn ${n} awaited fork -> ${r === null ? 'null' : JSON.stringify({ len: r.text.length, usage: r.usage, head: r.text.slice(0, 100) })} in ${Date.now() - t0}ms signal.aborted=${next.signal?.aborted}`)
      // un-awaited fork: return immediately, observe later from a clock callback
      const t1 = Date.now()
      pendingFork = $.model.fork({ prompt: 'Reply with the single word DETACHED.' }).then(
        v => { log(`detached fork settled after ${Date.now() - t1}ms -> ${v === null ? 'null' : JSON.stringify({ text: v.text.slice(0, 40), usage: v.usage })}; store.set from continuation...`); return $.store.set('p1.detached', { at: Date.now(), text: v?.text ?? null }).then(() => log('store.set from continuation ok'), err => log(`store.set from continuation threw ${String(err)}`)) },
        err => log(`detached fork rejected after ${Date.now() - t1}ms: ${String(err)}`))
      $.clock.after(20000, () => { log(`clock.after(20000) fired; signal.aborted=${next.signal?.aborted}`); void $.store.get('p1.detached').then(v => log(`clock.after store.get p1.detached=${JSON.stringify(v)}`), err => log(`clock.after store.get threw ${String(err)}`)) })
      const tick = $.clock.every(5000, () => { log(`clock.every tick`) })
      $.clock.after(21000, () => tick.cancel())
      log(`turn ${n} hook returning without awaiting detached fork (${Date.now() - t0}ms in hook)`)
    }
    if (n === 2) {
      log(`turn ${n} store.get p1.detached=${JSON.stringify(await $.store.get('p1.detached'))}`)
      // overrun on purpose to learn the budget
      log(`turn ${n} sleeping 15s to overrun the budget`)
      await $.clock.sleep(15000, { signal: next.signal }).catch(err => log(`sleep rejected: ${String(err)} aborted=${next.signal?.aborted}`))
      log(`turn ${n} after sleep; returning next(e)`)
    }
    return next(e)
  }).catch(($, e, next) => {
    $.ui.log(`[p1 ${stamp()}] turn.complete CATCH kind=${next.error.kind} budget=${next.error.budget} message=${JSON.stringify(next.error.message)} called=${next.called}`)
    return next(e)
  })
}
