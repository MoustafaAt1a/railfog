---
name: status
description: Summarize progress across all task files - what's done, in progress, blocked, or not started.
---

Usage: `/status` (whole repo) or `/status <milestone>` (one milestone folder)

## Steps

1. Grep every `tasks/**/*.md` task file (not `TASK-TEMPLATE.md`) for its
   `Status:` line.
2. Group and report:
   - **Done** — count and list.
   - **In review** — list (waiting on `reviewer`/`security-auditor`, not
     blocked on new work).
   - **In progress** — list.
   - **Blocked** — list, with the blocking dependency named (read each
     task's `Depends on` line and cross-check whether that dependency's own
     Status is `Done`; if not, that's the blocker even if the task itself
     doesn't say "Blocked").
   - **Not started** — count only, not a full list, once it's long — the
     interesting signal is what's actionable next, not the full backlog.
3. Compute what's actionable right now: any "Not started" task whose every
   `Depends on` entry is already `Done`. Surface these first — this is
   normally what the person wants from `/status`, not the raw counts.
4. If a milestone's `00-milestone-brief.md` dependency graph shows the
   milestone is fully `Done`, say so explicitly and suggest
   `/new-task <next-milestone>` per `tasks/00-roadmap.md`.

## Output shape

Lead with "Actionable now: [list]". Follow with the grouped summary. Don't
just dump every task's full status line — that's what opening the task files
directly is for.

## A note on trust

This workflow reads `Status:` fields, which are only as accurate as whoever
last updated them. It is a progress dashboard, not a verification tool — it
does not re-run `deno check`/`deno test` itself. For an independent
correctness check, use `/verify-spec` instead.
