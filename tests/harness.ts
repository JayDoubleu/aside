// A small fake engine for the hooks module: registers its hooks through `on`,
// hands them a `$` whose nouns are stubs that record every call, and
// dispatches events through the registered hooks in registration order with a
// `next` that falls through to a core answer, the way the engine does.
//
// It stands in for `claude-code/testing`, which is 2.1.271+; the mod targets
// 2.1.270 where `claude plugin test` does not exist yet.
import { register } from '../hooks/register.ts'

type AnyHook = ($: unknown, e: Record<string, unknown>, next: Next) => unknown
type Next = ((e?: Record<string, unknown>) => Promise<unknown>) & { signal: AbortSignal }
type Registration = { event: string; matcher: Record<string, unknown> | null; fn: AnyHook }
type Message = { role: 'user' | 'assistant'; text: string; toolUses: unknown[] }
type ForkResult = { text: string; usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number } } | null

export type Call = { verb: string; args: unknown[] }
export type Node = { type: string; children?: unknown; [prop: string]: unknown }

export type FakeOptions = {
  fork?: (prompt: string) => ForkResult | Promise<ForkResult>
  complete?: (request: { model: string; prompt: string; system?: string; maxTokens?: number }) => string | Promise<string>
  messages?: () => Message[]
  options?: Record<string, string | number | boolean | readonly string[]>
}

function matches(matcher: Record<string, unknown>, e: Record<string, unknown>): boolean {
  return Object.entries(matcher).every(([key, want]) => {
    const have = e[key]
    if (Array.isArray(want)) return want.includes(have)
    if (want !== null && typeof want === 'object') return typeof have === 'object' && have !== null && matches(want as Record<string, unknown>, have as Record<string, unknown>)
    return want === have
  })
}

export function fakeEngine(opts: FakeOptions = {}) {
  const registrations: Registration[] = []
  const calls: Call[] = []
  let now = 1_000_000
  const record = (verb: string, ...args: unknown[]) => calls.push({ verb, args })

  const on = (event: string, a: unknown, b?: unknown) => {
    registrations.push(b === undefined ? { event, matcher: null, fn: a as AnyHook } : { event, matcher: a as Record<string, unknown>, fn: b as AnyHook })
    return { catch: () => undefined }
  }

  const element = (type: string) => (props: Record<string, unknown>): Node => ({ type, ...props })
  const table = Object.freeze({
    Box: element('Box'), Text: element('Text'), Button: element('Button'), Input: element('Input'),
    Select: element('Select'), Link: element('Link'), Code: element('Code'), Client: element('Client'),
  })

  const $ = {
    clock: { now: () => now },
    command: { register: async (spec: { name: string }) => { record('command.register', spec); return { command: spec.name } } },
    model: {
      fork: async (request: { prompt: string }) => { record('model.fork', request); return opts.fork ? opts.fork(request.prompt) : null },
      complete: async (request: { model: string; prompt: string; system?: string; maxTokens?: number }) => { record('model.complete', request); return opts.complete ? opts.complete(request) : 'live answer' },
    },
    session: { messages: async () => { record('session.messages'); return opts.messages ? opts.messages() : [] } },
    ui: {
      open: async (pane: unknown) => { record('ui.open', pane) },
      close: async (pane: unknown) => { record('ui.close', pane) },
      invalidate: (event: string) => { record('ui.invalidate', event) },
      resolve: (e: unknown) => { record('ui.resolve', e); return table },
    },
  }

  async function dispatch(event: string, e: Record<string, unknown>, core: (e: Record<string, unknown>) => unknown = () => ({})): Promise<unknown> {
    const chain = registrations.filter(r => r.event === event && (r.matcher === null || matches(r.matcher, e)))
    const controller = new AbortController()
    const run = (i: number, input: Record<string, unknown>): Promise<unknown> => {
      const reg = chain[i]
      if (!reg) return Promise.resolve(core(input))
      const next = Object.assign((arg?: Record<string, unknown>) => run(i + 1, arg ?? input), { signal: controller.signal }) as Next
      return Promise.resolve(reg.fn($, input, next))
    }
    try { return await run(0, e) } finally { controller.abort() }
  }

  // Lets un-awaited continuations (the fork's `.then` chain) settle.
  const flush = async () => { for (let i = 0; i < 8; i += 1) await new Promise(resolve => setImmediate(resolve)) }
  const tick = (ms: number) => { now += ms }
  const verbs = () => [...new Set(calls.map(c => c.verb))].sort()
  const of = (verb: string) => calls.filter(c => c.verb === verb)

  register(on as never, opts.options ?? {})
  return { $, on, dispatch, calls, flush, tick, verbs, of, registrations }
}

export const SESSION = { surface: 'terminal', isInteractive: true, cwd: '/work' }
export const ASIDE_RUN = (args: string) => ({ command: 'aside', args, origin: { kind: 'composer' } })
export const PANE = { component: 'Pane', surface: 'terminal', requestId: 'aside', props: { title: 'aside', isFocused: true, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 } } }
export const SUBMIT = (value: string) => ({ plugin: 'aside', element: 'q', component: 'Pane', requestId: 'aside', surface: 'terminal', kind: 'submit', value })
export const CHANGE = (value: string) => ({ ...SUBMIT(value), kind: 'change' })
export const PRESS = (element: string) => ({ plugin: 'aside', element, component: 'Pane', requestId: 'aside', surface: 'terminal' })
export const USAGE = { input_tokens: 30, output_tokens: 100, cache_read_input_tokens: 72_848, cache_creation_input_tokens: 212 }

/** A promise settled by hand, for a fork that must stay pending until the test says. */
export function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

/** Every string drawn by a tree, in order. */
export function textsOf(node: unknown): string[] {
  if (node === null || node === undefined || typeof node === 'boolean' || typeof node === 'number') return []
  if (typeof node === 'string') return [node]
  if (Array.isArray(node)) return node.flatMap(textsOf)
  const n = node as Node
  return textsOf(n.children)
}

/** Every element of a type in a tree, in order. */
export function elementsOf(node: unknown, type: string): Node[] {
  if (node === null || node === undefined || typeof node !== 'object') return []
  if (Array.isArray(node)) return node.flatMap(child => elementsOf(child, type))
  const n = node as Node
  return [...(n.type === type ? [n] : []), ...elementsOf(n.children, type)]
}
