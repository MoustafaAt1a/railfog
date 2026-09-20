# Model Configuration

This harness routes by *role*, not by a single global model setting — see
`AGENTS.md` §7 for why (the model that plans is never the model that
implements or does the final review). The literal model strings live in each
agent file's frontmatter, not in one central config, because that's what
Antigravity CLI's agent format requires.

## Where the strings live

```
.agents/agents/architect.md          model: gemini-3.8-flash-high
.agents/agents/task-decomposer.md    model: gemini-3.8-flash-high
.agents/agents/test-writer.md        model: claude-opus-4-6-thinking
.agents/agents/implementer.md        model: claude-opus-4-6-thinking
.agents/agents/reviewer.md           model: claude-opus-4-6-thinking
.agents/agents/security-auditor.md   model: claude-opus-4-6-thinking
```

These are written as I understood the names you gave me ("Gemini 3.8 Flash
High" and "Claude Opus 4.6 (Thinking)") — I can't verify third-party model ID
strings from here, so treat them as placeholders until confirmed.

## Check what your CLI actually calls them

```bash
# exact command name varies by Antigravity CLI version — try:
agy models list
# or check the model picker in an interactive session
```

## Swap every occurrence at once

```bash
# from the repo root, after confirming the real strings:
grep -rl 'gemini-3.8-flash-high' .agents/agents/ | xargs sed -i 's/gemini-3.8-flash-high/<real-gemini-model-id>/g'
grep -rl 'claude-opus-4-6-thinking' .agents/agents/ | xargs sed -i 's/claude-opus-4-6-thinking/<real-claude-model-id>/g'
```

## If your plan/picker only exposes one model total

The role separation (plan vs. implement vs. review) is still worth keeping
even on one model — set every `model:` field to the same string. You lose
the cross-model check (`docs/ANTIHALLUCINATION.md` Rule 4 is weaker with one
model reviewing its own family's work), but every other rule in this harness
(spec-lock, atomic tasks, DoD gates, verification-over-belief) still holds
and still helps.
