# aside: design

Read `FINDINGS.md` first; every choice here points at a measurement there.

## Shape

One hooks module (`../../hooks/register.ts`), one pane, one command. No band: a pane is the one component a plugin opens on its own, it docks beside the transcript at 110+ columns and sits inline below that, and it keeps its own scroll and focus.

```
/aside [question]        command.run (immediate)  ->  $.ui.open({ id: "aside", focus: true }); ask(args); return {}
Tab, type, Enter         ui.input submit          ->  ask(value); return { element, value }    (no next: closes the redraw race)
ask(q)                   history.push({q, a: null}); invalidate()
                         fork(promptOf(q)) ---------------- non-null --> a = text, tokens = usage
                                            \-- null (no completed turn yet) --> live(): session.messages() -> model.complete   or queue for turn.complete
                         then: ms, inFlight--, invalidate()
ui.render Pane           draws history + Input + [Clear] [Close] from plugin memory
ui.press                 clear / close, answered in the hook
```

## Why each piece

- **Fork is the primary path** (F1, F2): one cache read of the prefix, ~1.2 to 2.2 s, no tools, off the transcript. History is rendered into the single `prompt` (F1). Capped at the last 8 exchanges and 1,200 characters per answer to keep the extra prompt small next to the 24,000-token reservation.
- **Un-awaited, always** (F3): `ask()` returns before the model does, so the `command.run` and `ui.input` hooks settle in tens of milliseconds and never approach the 10,000 ms budget. The continuation only touches plugin memory and calls `invalidate`, which redraws in ~20 ms (F4).
- **Live fallback** (F3, F8): fork is null until the session's first turn has completed (and until the next turn completes after a plugin reload). With `liveFallback` on (the default) the mod answers such a question now from `$.session.messages()` through `$.model.complete` on `liveModel`, labels the row `live`, and says how many characters went uncached; the transcript sent is capped at 60,000 characters. With it off, the question queues and a fork answers it on `turn.complete`. During any later turn the fork answers from the last completed turn's snapshot, so a question asked while Claude is working is answered by a fork that does not see the turn in flight.
- **The command returns `{}`** (F7): a `{ text }` answer becomes two user messages the model reads next turn. The pane is the output.
- **Events are answered in hooks, not closures** (F6 race): element closures are handles bound to one drawing and a redraw during a submit drops them; the `ui.input` hook sees the same event first.
- **Focus and keys** (F6): on 2.1.270 the pane opens focused but with the ring on nothing; the placeholder tells the person to press Tab. When you run 2.1.271+, add `autoFocus: true` to the Input (unknown props fail the whole tree on 2.1.270, so it cannot be unconditional). Esc hands the keys back to the composer; from then on typing is the main thread's, which is the engine's behaviour, not the mod's.
- **Read-only by listing** (F9): the module's `$` calls are all reads and drawing. Anyone can check with `claude plugin validate .`; an organization can refuse it in `plugin.register` on that listing.

## State

All in module memory; nothing in `$.store`. Options (`liveFallback`, `liveModel`, `maxHistory`) come from the manifest's `userConfig` through `register(on, options)`. Rationale: a side chat about *this* session has no reason to outlive it, and dropping `store.*` keeps the static listing to reads plus drawing. If you want history to survive a plugin hot reload, add `$.store.set('history', …)` in `ask()` and a `$.store.get` in `session.start`; measured to work from a continuation (F3).

## Failure modes and what the pane shows

| condition | what happens |
|---|---|
| fork null before the first turn | `live()` runs; with an empty transcript the row says there is nothing to ask about yet |
| fork null during the first turn | `live()` answers in ~0.8 s from the committed messages (the in-flight assistant text is not visible yet), or the question waits for `turn.complete` |
| asked during a later turn | a fork answers from the last completed turn's snapshot in 1.5 to 3 s; it does not see the turn in flight |
| right after `/compact` | fork answers, ~3k uncached tokens (F2) |
| plugin model budget spent (2,000,000 tokens/session) | fork rejects; the row shows `(no answer: …)` |
| hook overrun | cannot happen on the model path (nothing is awaited); `command.run` and `ui.input` settle in <50 ms |
| pane closed by the person | `ui.close` observed; history kept until `Clear` |

## Cost guardrails

A fork costs one cache read of the whole prefix (F2). At a 150k-token context on Opus that is a real number per question; the pane prints `read N · new M · out K` per answer so the person sees it. Reasonable additions, not built: a per-session question cap, and refusing `live()` above a transcript size.

## Testing

- `claude plugin validate . --strict` must pass with the listing in `FINDINGS.md` §9.
- End-to-end in a terminal: `probes/drive2.py` replays keystrokes into a pty (`evidence/logs/e2e*.script.json`), `probes/screens.py` replays the capture through a terminal emulator; `probes/witness` logs `$.session.messages()` at every turn end so "the transcript is untouched" is checked, not assumed.
- `claude plugin test` and the `claude-code/testing` mock kit are 2.1.271+ (`claude plugin --help` on 2.1.270 has no `test`), so `tests/` runs on Node's own test runner with a small fake engine (`tests/harness.ts`) that dispatches events through the registered hooks the way the engine does.

## Open items

- Desktop and mobile surfaces (mobile has no `Input`).
- Streaming: `fork` returns the whole reply; the pane shows "thinking…" then the text. Fine at 1 to 2 s.
- Pane height and scrolling with long histories: the engine scrolls a tall tree; not tuned.
