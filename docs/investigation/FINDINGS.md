# aside: investigation findings

Everything below was measured on this machine unless a line says otherwise.

| | |
|---|---|
| Claude Code | **2.1.270** (native binary, `/opt/claude-code/bin/claude`; `claude --version`). A leftover npm `cli.js` on the same box reports 2.1.42 and contains no function-hook code at all: every `model.fork` / `ui.render` string count is 0 there. |
| Flag | `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` on every run; debug log line `hooks module <name> loaded (worker, environment 1, tier user)` confirms the module ran. |
| Declarations | `/plugin-types` works headlessly (`claude -p "/plugin-types"` wrote `.claude/types/claude-code.d.ts`, first line `Written by Claude Code 2.1.270`). Regenerate it with `/plugin-types` in a session on your build. The copy published at `anthropics/claude-code@f4ceeec` (`mods/types/`) is from **2.1.271** and differed from 2.1.270's by 3,134 diff lines. |
| Surface drift, concrete | The published built-in `diff` mod does not validate on 2.1.270: `"ui.focus" is not an event` (`evidence/validate-builtin-diff-mod-on-2.1.270.json`). 2.1.271 also adds `Button.autoFocus`, `Button.action`, `Button.dimColor`, hover `scope`. |
| Model used for probes | `claude-haiku-4-5-20251001` for the session and therefore for forks (a fork always uses the session's model). Token counts are model-independent; dollar figures are haiku's. |

What I could not get, stated up front:

- **The issue comments.** `api.github.com` answers 403 through this container's GitHub proxy ("sessions are bound to their configured repositories"), the GitHub HTML page loads comments client-side and WebFetch saw "There was an error while loading", and attaching the repo with API credentials was denied by the permission classifier. I read the original post and the Sep 9 update (they rendered), the architecture PDF (`evidence/architecture-pdf-extracted.txt`, via a signed redirect and pypdf), and the `mods/` source at HEAD. Nothing below leans on a comment.
- **Claude Code Desktop.** No desktop surface here. Everything about `desktop` is from the declarations, marked as such.
- **Changing a terminal `Select`.** It raises `ui.select`, but in the band the arrow keys are bound to pane scrolling, so I never managed to pick a different option; unmeasured.

Evidence files: `evidence/logs/*.debug-excerpt.log` are the `--debug-file` lines that matter (probe `$.ui.log` lines, engine fork/hook lines); `evidence/screens/*.screens.txt` are the pty captures replayed through a terminal emulator; `probes/` are the throwaway plugins and drivers.

---

## 1. What `$.model.fork` accepts and returns

**Accepts exactly `{ prompt: string }`, non-empty. Not a message list.** Host-side check, before anything runs (`evidence/logs/p1.debug-excerpt.log`):

```
fork({"messages":[{"role":"user","content":"hi"}]}) -> rejected: HooksError: p1: model.fork: takes { prompt } (a non-empty prompt) (host check)
fork({"prompt":""})                                  -> rejected: HooksError: p1: model.fork: takes { prompt } (a non-empty prompt) (host check)
fork("str")                                          -> rejected: HooksError: p1: model.fork: takes { prompt } (a non-empty prompt) (host check)
fork({"prompt":"x","system":"y","maxTokens":5})      -> resolved null   (extra keys ignored; null only because the snapshot was cold)
```

The validator in the binary is the same check: `typeof n?.prompt!=="string"||n.prompt.trim()===""?"takes { prompt } (a non-empty prompt)"`.

**Returns** `Promise<{ text, usage: { input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens } } | null>`. The implementation (`VEr` in the binary) runs the engine's own fork machinery with `promptMessages: [user(prompt)]`, `maxTurns: 2`, `canUseTool` fixed to deny (`"A model fork cannot use tools"`), `skipTranscript: true`, `skipCacheWrite: true`, and trailing `tool_use` blocks stripped from the forked context. It reserves 24,000 tokens against a per-plugin session budget of 2,000,000 (`$.model.complete: the session's model budget for this plugin is spent` is the error when that runs out) and settles to the real `input + output` count afterwards.

**Consequence for a multi-turn side chat:** yes, you render your own history into each prompt. The mod does that (`../../hooks/register.ts`, `promptOf`), and the second question in `evidence/screens/e2e.screens.txt` ("and what did you answer") was answered from the first exchange.

## 2. Real cost of a fork on a substantial transcript

Session with a 160,000-character paste (`probes/pcost`, `evidence/logs/pcost.*`). Numbers are the API's own usage counts as the engine logged them (`Forked agent [plugin_model_fork] finished ... totalUsage`):

| event | input | cache read | cache creation | output | wall |
|---|---:|---:|---:|---:|---:|
| main turn 1 (paste + "LOADED") | 10 | 22,366 | 50,482 | 205 | |
| `/aside` fork #1 | 35 | **72,848** | 212 | 104 | 1,445 ms |
| `/aside` fork #2 | 30 | **73,060** | 0 | 136 | 2,176 ms |
| `/compact` (engine's own) | 1,650 | 73,060 | 0 | 1,140 | |
| `/aside` fork #3, first thing after compaction | **2,951** | 22,366 | 0 | 145 | 2,007 ms |
| main turn "WARM" | 10 | 22,366 | 3,323 | 62 | |
| `/aside` fork #4 | 34 | 25,689 | 69 | 123 | 1,396 ms |

So a fork is billed as **one cache read of the whole main-thread prefix plus a few dozen new tokens**. The prefix here was ~73k tokens (system prompt and tools are the 22,366 you see cached on every request). `total_cost_usd` in the stream-json results moved from $0.15137 to $0.15948 for fork #1: **$0.0081 on haiku** for a 73k-token cache read; scale by the session model's cache-read price for Sonnet/Opus.

**The "null after compaction" claim is false on 2.1.270.** Fork #3 ran immediately after `/compact`; it was not null. Its shape is different: the compaction summary (2,951 tokens) went in as uncached input with nothing cache-created, and only the system prompt was read from cache. After the next real turn, forks were back to cheap (#4).

Two smaller sessions for reference (`p1`, `p2`): cache read 26,678 / creation 122 on the first fork, 26,800 / 0 on the second; forks answer in 1.2 to 2.2 s.

## 3. Can a fork be fired without `await` and land later?

**Yes.** `evidence/logs/p1.debug-excerpt.log`, turn 1:

```
19:17:24.904 turn 1 hook returning without awaiting detached fork (1903ms in hook)
19:17:26.528 detached fork settled after 1624ms -> {"text":"DETACHED", ...}; store.set from continuation...
19:17:26.532 store.set from continuation ok
19:17:29.906 clock.every tick        (every 5 s, four ticks logged)
19:17:44.906 clock.after(20000) fired; signal.aborted=false
19:17:44.908 clock.after store.get p1.detached={"at":1789413446528,"text":"DETACHED"}
```

The hook had returned 1.6 s before the fork settled; the continuation wrote `$.store`; a timer 20 s later read it back. `next.signal` was still not aborted at that point (the signal is per dispatch; the plugin's environment lives on).

**The budget is 10,000 ms per dispatch**, and the `.catch` handler gets a 1,000 ms grace:

```
19:18:00.223 turn 2 sleeping 15s to overrun the budget
19:18:10.226 turn.complete CATCH kind=timeout budget=1000 message=undefined called=false
19:18:10.227 sleep rejected: HooksError: p1: exceeded 10000ms budget aborted=true
engine:      [WARN] hook failed closed: p1: exceeded 10000ms budget (turn.complete; its .catch answered)
engine:      [WARN] hooks module p1: next() after it settled; refused
```

A `$.clock.sleep(ms, { signal: next.signal })` inside the hook is aborted at the budget; `next()` after settlement is refused. Fail-open wording from the engine for a skipped hook: `(ui.input; skipped; what is below it ran in its place)` (from probe 4). Timer callbacks (`$.clock.after` / `$.clock.every`) ran outside any dispatch and did store I/O and further `$` calls without a budget error; I did not find a separate budget for them.

**When a fork is null.** Before the session's first main-thread request has completed, a fork resolves `null` in under 10 ms (`$.model.fork (p2): no warm main-thread transcript to fork`: at `session.start`, and during the first turn in `p5`, `p6` and `e2e2`, where the count prompt was the first turn). Once one turn has completed, a fork fired **during a later turn answers**, from the last completed request's snapshot: in `p7` two band questions submitted 6 s and 10 s into a 24 s turn were answered in 1,474 and 1,997 ms with `cacheRead=27732`, the prefix of the previous turn, and the same in `e2e3`. The snapshot is the last completed main-thread request's cache-safe parameters (`GEr` stores them for `querySource` `repl_main_thread*`, `rI()` reads `last.params`); it is not cleared when the next request starts, it is simply absent until the first one completes (and after the engine disposes it on a plugin reload). So a fork mid-turn does not see the turn in flight, which is the right behaviour for a side chat.

## 4. Does `$.ui.invalidate` redraw from state written by an async continuation?

**Yes, within about 20 ms.** `evidence/logs/p2.debug-excerpt.log`:

```
19:23:47.966 band fork settled in 2081ms -> {...}; store.set + invalidate
19:23:47.984 render AbovePrompt #6 ...            (18 ms later; the band now shows the answer)
19:23:53.565 pane fork settled in 1605ms -> ...
19:23:53.581 render Pane #3 ...                   (16 ms later)
```

The rendered screens (`evidence/screens/p2.screens.txt`) show `ASIDE BAND r6 ... | answer(2081ms): I'm ready! What's your band question?` under the prompt. Render hooks themselves settle in 1 to 10 ms (`hooks module p2 ui.render settled in 2.6ms`). The plugin's own memory is the state that renders; `$.store` is only needed across reloads/sessions. Note for anyone reading the debug log: it redacts numbers inside JSON-looking text (`"input_tokens":[REDACTED]`), so log usage as plain words.

## 5. What `ui.render` can draw

**A constrained vocabulary, not React.** From the 2.1.270 declarations (and the p2 screens):

- Elements come from `$.ui.resolve(e)`, per surface. Terminal: `Box, Text, Button, Input, Select, Link, Code, Client`. Desktop adds `Svg`. Mobile: `Box, Text, Button, Svg, Link, Code` only ("the control protocol carries presses (ui_press) but no ui_input or ui_select yet").
- Props are an allowlisted subset of Ink's Box/Text props (flex layout, margins, padding, `borderStyle`, colours, `wrap`, `dimColor`, `bold`, ...). "A tree with any other prop fails validation as a whole and the engine's own component is drawn." This is why the mod cannot pass `autoFocus` on 2.1.270.
- Render sites (`RenderComponent`): `AskUserQuestion, UserMessage, AssistantMessage, ToolUse, ToolResult, ToolGroup, Spinner, TurnDuration, InfoNotice, SessionMode, PromptHint, AbovePrompt, Pane`. `AbovePrompt` is a band above the composer (terminal only; 16 rows max here); `Pane` is the only component a plugin opens itself (`$.ui.open`), docked at 140 columns with a 62-column body, inline under 110.
- JSX compiles against globals `h`/`Fragment` into plain-data trees; calling the constructors directly (`Box({ ..., children: [...] })`) works and is what the probes do.

What the terminal drew for the probe (from the emulator replay):

```
╭──────────────────────────────────────────────────────────────────────[-]
│ ASIDE BAND r4 working=false | idle
│ ask> : band question while working  ⏎ ask
│ [ Open pane ] [ Ping ] mode: short ▾
╰──────────────────────────────────────────────────────────────────────────╯
```

## 6. `ui.input` and `ui.select`: can keystrokes reach a panel while the main turn runs?

**Mostly yes, with two leak modes and one race, all measured.**

Keybindings (defaults extracted from the binary): `ctrl+x tab` = `abovePrompt:focus` (focus the band, or a pane), `tab`/`right` next element, `shift+tab`/`left` previous, `enter`/`space` press or submit, `esc` leave; in a pane also `ctrl+x x` close and `ctrl+x arrows` grow/shrink. Arrow up/down scroll the pane, they do not move the focus ring.

Events, as received (`evidence/logs/p3.debug-excerpt.log`):

```
ui.input  {"plugin":"p2","element":"bandq","component":"AbovePrompt","requestId":"above-prompt","surface":"terminal","kind":"change","value":"band q during turn"}
ui.input  {... "kind":"submit","value":"band q during turn"}
ui.press  {"plugin":"p2","element":"ping","component":"AbovePrompt","requestId":"above-prompt","surface":"terminal"}   ->  onPress ran; next settled in 12 ms; redraw 20 ms after
ui.select {"plugin":"p2","element":"mode",... "value":"short"}
```

- **Mid-turn, band:** in `p5` the main turn ran 19:30:29.2 to 19:30:53.9. `ctrl+x tab`, typing, Enter at 35.8 / 37.2 produced `ui.input change` and `submit` on the band's Input while `isWorking=true`, and `prompt.submit` shows nothing but the original prompt. No leak.
- **Mid-turn, pane:** `/aside` (`immediate: true`) opened the pane during that same turn; one Tab put the ring on the pane's Input; typing and Enter produced `ui.input` on `paneq`; the witness transcript at turn end is `n=3` (user, assistant, assistant). No leak.
- **Leak mode 1 (measured, p2):** pane opened with `focus: true` shows `isFocused=true`, but the ring is on no element. The first printable key un-focused the pane and went to the composer, and Enter submitted it as a real prompt: `prompt.submit origin={"kind":"composer"} text="typed after aside"`, then the model answered it. On 2.1.270 the user must press Tab once after the pane opens. 2.1.271's `autoFocus` prop is the fix; it is not accepted by 2.1.270's validator.
- **Leak mode 2 (measured, e2e2):** after Esc the composer has the keys again, so typing goes to the main thread. Obvious, but it is the failure users will hit; the pane's placeholder says `ctrl+x tab focuses the pane`.
- **Race (measured, p4):** a submit that arrived 20 ms after the turn-end redraw failed in core: `ui.press/ui.input/ui.select: no handler is held under handle 9 (ui.input; skipped; what is below it ran in its place)`. The element closures are handles tied to one drawing; a redraw (here `isWorking` flipping) invalidates them. The `ui.input` hook still received the event with its value before core failed, so the mod answers `submit` in the hook and returns `{ element, value }` without calling `next`. That closes the race.
- `ui.select`: fires on Enter with the current value. I could not change the selection with the keyboard in the band (arrows scroll), so "how a person picks another option" is unmeasured.
- Desktop/mobile: unmeasured. The declarations say desktop has `Input`/`Select` and mobile does not.

Latency: a `ui.input` dispatch settles in 6 ms (`ui.input aside/q (change) in Pane from terminal: settled in 5.9ms`); the press chain settles in 12 ms; redraw after `invalidate` 16 to 20 ms. Keystroke-to-event latency itself was not instrumented. The "13 ms press, 150 to 190 ms redraw" report is right on the press and pessimistic on the redraw.

## 7. Registering `/aside`

`$.command.register({ name, description, argumentHint, immediate })` from `session.start`; serve it with `on('command.run', { command: 'aside' }, ...)`. Debug log: `$.command.register (aside): /aside listed`; it appears in the typeahead and in `system/commands_changed` in stream-json. `immediate: true` is what lets it run mid-turn (`command.run aside` at 19:36:51 inside a turn that ran 44.8 to 69.5 in `e2e2`).

**What the hook returns decides whether the main transcript is touched.** With `return { text }` (p1, pcost) the transcript gained two *user* messages per run, which the model sees on the next turn:

```
["user",177,"<command-name>/aside</command-name>\n ..."], ["user",165,"<local-command-stdout>aside: ...</local-command-stdout>"]
```

With `return {}` and the answer drawn in the pane (the mod), `$.session.messages()` at every later turn end lists only the person's real prompts (`e2e`: n=3 then n=6; `e2e2`: n=3, 6, 9). The `❯ /aside ...` echo you see in the terminal is display only.

## 8. `$.session.messages` versus the fork's prefix

`$.session.messages()` returns `{ role, text, toolUses, toolResults }[]` in 3 ms. Mid-turn it returns what has been committed so far: in `p6` the in-flight assistant message is present with `text.length 0`. It is text, not the API request: no system prompt, no cache, tool results as summaries.

The fork's prefix is the real request: system prompt, tools, every block, and the cache, as of the last completed turn. It is the right primitive whenever it answers, which is any time after the session's first turn has completed. The mod uses `$.session.messages()` plus `$.model.complete` (haiku, 400-token cap) only when the fork is null: the first turn of a session. Measured fallback: 712 ms (p6), 800 and 934 ms (e2e2), uncached; the mod caps the transcript it sends at 60,000 characters and labels the answer `live`.

## 9. The read-only guarantee, structurally

Four layers, each observed:

1. **Static listing.** `claude plugin validate` prints exactly what a module hooks and calls (`evidence/validate-aside.json`): calls `$.clock.now, $.command.register, $.model.complete, $.model.fork, $.session.messages, $.ui.close, $.ui.invalidate, $.ui.open, $.ui.resolve`; no `fs.*`, `process.*`, `http.*`, `store.*`, `tool.*`, `prompt.*`, `session.compact`, `command.run`. The scanner enforces the spelling: my first probe was refused for `Object.keys($)` with `$ itself is passed as an argument (bound, passed, spread, returned or read); $ is always spelled $.noun.event(...)`. So the listing cannot be evaded by aliasing `$`.
2. **Load-time gate.** The engine raises `plugin.register` with that same listing; a plugin seated above can refuse. The witness hook saw `uses={"events":[...],"calls":["clock.now","command.register","model.complete","model.fork","session.messages","ui.close","ui.invalidate","ui.open","ui.resolve"]}` and the log then says `plugin.register: aside (user, aside@inline), judged by witness: admitted`. An organization's prepended mod (the pattern `sec-default` uses) can also withhold nouns in `engine.create`.
3. **Fork cannot reach tools or the transcript.** In the binary the fork's `canUseTool` is a constant deny (`A model fork cannot use tools`) and the run is `skipTranscript: true`, `maxTurns: 2`. In every probe the message count after forks was unchanged.
4. **The command writes nothing.** `command.run` returns `{}`; verified by the witness's `$.session.messages()` listings after each turn.

What is *not* structural: the `live` fallback sends transcript text to the model as a fresh request (still a read; nothing comes back into the thread), and the pane's `Clear`/`Close` buttons are the only state changes, both plugin-local.

---

## Corrections to the hypotheses you listed

| claim | verdict |
|---|---|
| fork runs over the session's transcript sharing its cache | true, from the last completed turn's snapshot; it answers during a later turn too, and does not see the turn in flight |
| billed as a full cache read of the prefix per call | true (72.8k read for 73k prefix), plus ~30 to 200 new tokens |
| null on a cold snapshot; first turn after compaction gives nothing | half: null until the session's first turn has completed (so during that first turn); **after compaction it answers**, with the summary as ~3k uncached input |
| 10,000 ms budget, overrun logged and fail-open | true; plus a 1,000 ms `.catch` grace and `next()` refused after settle |
| AbovePrompt hook with Button works; press ~13 ms; redraw 150 to 190 ms | press 12 ms confirmed; redraw measured at 16 to 20 ms |
| `ui.press` same on terminal and desktop; `$.session.surface` tells them apart | `surface` returned `"terminal"` interactively and `null` headlessly; desktop unmeasured |
| `$.store` persists across dispatches | true: written from a continuation, read back from a timer 18 s later and from the next turn's hook. Across sessions it is declared (a JSON file under the config dir) but I did not run a second session to check |

## What would have to change in the engine

1. Seed the fork snapshot at session start (from the resumed transcript, or an empty one) so `$.model.fork` answers during the first turn too. Today the mod falls back to an uncached completion there.
2. Accept `autoFocus` (shipped in 2.1.271) so a pane opened with `focus: true` types into its Input at once instead of leaking the first keystroke into the composer.
3. Resolve element handles by key rather than by drawing, so a press or submit racing a redraw is not dropped (the mod works around it in the hook).
4. Optionally let `fork` take `system` or a message list; today history has to be rendered into one user message.
