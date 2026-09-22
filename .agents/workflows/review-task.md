---
name: review-task
description: Re-run just the review pass on an already-implemented task, without redoing test-writing or implementation.
---

Usage: `/review-task <task-id>`

Use this when a task was implemented in an earlier session, or when you want
a second independent pass without touching the implementation again (e.g.
after a contract file changed and you want to re-check compliance).

## Steps

1. Load the task file and the current diff/files it produced.
2. Invoke `reviewer` fresh — it re-reads `docs/contracts/` directly per
   `.agents/docs/ANTIHALLUCINATION.md` Rule 4, it does not read the previous review's
   notes as a shortcut.
3. If the task's Spec references touch `PLAT-4`, `PLAT-5`, `PLAT-6`,
   `PLAT-7`, `PLAT-15`, `FN-6`, or `FN-7`, also invoke `security-auditor`
   fresh.
4. Report findings. Do not silently fix anything found — route fixes back
   through `/implement-task` so `test-writer`/`implementer` handle them under
   the normal loop, keeping the red-green discipline intact even for
   post-hoc fixes.
