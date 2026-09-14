# aside

A read-only side chat for [Claude Code](https://code.claude.com), as a mod (a plugin built on function hooks).

`/aside` opens a pane beside the transcript. You ask questions about the session so far; a tool-less fork of the session's own transcript answers, sharing the main thread's prompt cache. Nothing is written back into the main thread: the model in the main session never sees your side questions or their answers, and the side chat cannot call tools, edit files, or submit prompts.

```
┌ transcript ─────────────────────────┬ aside ──────────────────────────────────┐
│ ❯ refactor the auth middleware      │ 2 questions                              │
│ ● Reading src/auth/*.ts ...         │ you: which files has it touched so far?  │
│   Edit(src/auth/session.ts)         │ aside: src/auth/session.ts and           │
│   ...                               │ src/auth/index.ts; tests are untouched.  │
│                                     │ fork · 1244 ms · read 72848 · new 242    │
│                                     │                                          │
│                                     │ you: is it planning to change the tests? │
│                                     │ aside: thinking…                         │
│                                     │ > _                                      │
│                                     │ [ Clear ] [ Close ]                      │
└─────────────────────────────────────┴──────────────────────────────────────────┘
```

## Requirements

- Claude Code **2.1.270** or newer with function hooks enabled: `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`. Without the flag the module is not loaded and `/aside` does not exist. Function hooks are early access and the API changes between releases; this mod is validated and tested against 2.1.270 (see `docs/investigation/`).
- A terminal at least 110 columns wide for the pane to dock beside the transcript; narrower, it opens inline above the prompt.

## Install

From the marketplace in this repository:

```
/plugin marketplace add JayDoubleu/aside
/plugin install aside@aside
```

Or straight from a checkout:

```sh
git clone https://github.com/JayDoubleu/aside
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude --plugin-dir ./aside
```

## Use

| | |
|---|---|
| `/aside` | open the pane |
| `/aside what has changed so far?` | open it and ask |
| **Tab** | put the cursor in the pane's input (the pane opens focused, but the cursor is not in the field yet on 2.1.270) |
| **Enter** | ask |
| **Esc** | give the keys back to the composer |
| **ctrl+x tab** | focus the pane again |
| **ctrl+x x** | close the pane |

Every answer's footer says where it came from and what it cost:

- `fork · 1244 ms · read 72848 · new 242 · out 100`: a fork over the transcript. `read` is the prompt-cache read of the whole session prefix, billed at the cache-read rate; `new` is what was added; `out` the reply.
- `live · 800 ms · 5120 chars of transcript sent uncached`: asked before the session's first turn had completed, when there is no transcript snapshot to fork yet, so the question was answered by a plain completion over the transcript's text (see `liveFallback`).

Asked while a later turn is running, a fork answers from the last completed turn: you get the state as of Claude's previous reply, not the half-finished one.

## Options

Set under `/config` or in `settings.json` as `pluginConfigs["aside@aside"].options`:

| option | default | |
|---|---|---|
| `liveFallback` | `true` | When no turn has completed yet (the session's first turn): **on** answers at once through `$.model.complete` over `$.session.messages()` (uncached, capped at 60,000 characters of transcript, marked `live`); **off** queues the question and a fork answers it when the turn ends. |
| `liveModel` | `haiku` | Model for live answers (a `--model` value). Forks always use the session's model. |
| `maxHistory` | `8` | Earlier side exchanges carried in each question's prompt. |

## What "read-only" means here

`claude plugin validate . --strict` prints the module's complete static surface:

```
hooks: session.start, command.run{command=aside}, turn.complete, ui.render{component=Pane}, ui.input{plugin=aside, element=q}, ui.press{plugin=aside}
calls: $.clock.now, $.command.register, $.model.complete, $.model.fork, $.session.messages, $.ui.close, $.ui.invalidate, $.ui.open, $.ui.resolve
```

No `fs`, `process`, `http`, `store`, `tool` or `prompt` verbs, so the module cannot reach the working tree, the network, or the main thread's prompt. The engine's fork denies every tool call and never writes to the transcript. The `/aside` command answers `{}` (a `{ text }` answer would become transcript messages the model reads). An organization can refuse the module on that listing in a `plugin.register` hook.

## Cost

A fork costs one prompt-cache read of the whole session prefix plus a few dozen new tokens: measured at 72,848 cache-read tokens on a 73k-token session, about $0.008 on Haiku and proportionally more on the session's model. Right after `/compact` the summary goes in uncached (~3k tokens). Live answers send the transcript text as fresh input to `liveModel`.

## Development

```sh
npm run validate     # claude plugin validate, offline, no API key
npm test             # node --test, no API key
npm run eval         # claude plugin eval: real sessions, needs credentials, spends a few cents
```

The eval (`evals/`) checks the mod is invisible to the model: a trivial prompt gets the same reply with and without the plugin loaded. It passed 2/2 runs on each arm on 2.1.270 (`docs/investigation/evidence/eval-invisible-to-the-model.json`).

Tests run on Node 22's native TypeScript support against a small fake engine (`tests/harness.ts`) that dispatches events through the registered hooks the way Claude Code does. `claude plugin test` is 2.1.271+ and not used yet.

Typing: run `/plugin-types` in a session to write `.claude/types/claude-code.d.ts` next to `tsconfig.json`.

`docs/investigation/` holds the measurements this design rests on: `FINDINGS.md` (nine questions, each answered with debug-log lines and rendered screens), `DESIGN.md`, the throwaway probe plugins, and the evidence.

## License

MIT
