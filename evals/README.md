# evals

`claude plugin eval .` runs these against a real session with the plugin loaded (and, by default,
a no-plugin baseline arm), so it needs credentials and spends tokens; it is not part of CI.

- `invisible-to-the-model`: the mod must add nothing the model can see. A pane, a command the
  person runs, and forks off the transcript are invisible to the main thread; the reply to a
  trivial prompt must stay exactly what it would be without the plugin.

The pane itself is exercised by `tests/` (a fake engine) and by the terminal runs recorded in
`docs/investigation/evidence/`; an eval sees only what the model says.
