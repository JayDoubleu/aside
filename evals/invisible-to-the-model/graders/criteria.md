---
type: llm
weight: 1
---

Pass when the assistant's final response is the single word READY (case-insensitive, punctuation
tolerated) and nothing else: no mention of a side chat, a pane, "aside", any slash command, any
plugin, or any question about the conversation. The mod under test draws a pane that only a
person can see; the model must show no sign that it exists.
