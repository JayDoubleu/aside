# Changelog

## 0.1.0

First release, validated on Claude Code 2.1.270 with `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`.

- `/aside [question]` opens a read-only side-chat pane beside the transcript.
- Answers come from `$.model.fork` over the session's own transcript as of the last completed turn, also while a later turn is running. Before the first turn has completed there is nothing to fork: a plain completion over the transcript text answers (`liveFallback`, on by default) or the question waits for the turn to end (off).
- Nothing is written into the main thread: the command answers `{}`, the fork cannot use tools and is kept off the transcript.
- Options: `liveFallback`, `liveModel`, `maxHistory`.
- Tests on Node's own runner, an eval suite for `claude plugin eval`, CI that validates the manifests offline.
- `docs/investigation/`: the measured findings the design rests on.
