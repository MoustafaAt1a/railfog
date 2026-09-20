# `.agents/` — Quick Index

This folder is what Antigravity CLI discovers. If you're browsing it
directly instead of starting from the repo root `README.md`/`AGENTS.md`,
here's the map.

## Agents (`agents/`) — who does what

| Agent | Model | Does | Never does |
|---|---|---|---|
| `architect` | Gemini 3.8 Flash High | Design, ADRs, scope rulings, skill approval/registration | Write implementation code |
| `task-decomposer` | Gemini 3.8 Flash High | Breaks milestones into atomic task files | Write implementation code |
| `test-writer` | Claude Opus 4.6 (Thinking) | Writes failing tests first | Write implementation |
| `implementer` | Claude Opus 4.6 (Thinking) | Writes minimum code to pass tests | Widen scope, approve own work |
| `reviewer` | Claude Opus 4.6 (Thinking) | Independent re-derivation of correctness | Trust the implementer's summary |
| `security-auditor` | Claude Opus 4.6 (Thinking) | Adversarial pass on PLAT-4/5/6/7/15, FN-6/7 tasks | Approve from reading code alone |

See `MODEL-CONFIG.md` if you need to change the model strings.

## Skills (`skills/`) — auto-triggered knowledge

This list grows over time — see `skill-authoring` below and
`AGENTS.md` §9. If a skill exists on disk but isn't in this table, that's a
registration gap, not a hidden feature.

| Skill | Triggers on |
|---|---|
| `railfog-contract-lock` | Any RailFog-specific code/config/design |
| `solid-oop-dod-typescript` | Any TypeScript module — which boundary rule applies |
| `anti-slop-code-quality` | Any code, always |
| `provider-abstraction-pattern` | Any `*Provider` interface or adapter |
| `deno-runtime-conventions` | Any runtime-facing or toolchain code |
| `security-adversarial-review` | Isolation/network/capability/secrets/multi-tenancy code |
| `tdd-atomic-protocol` | Start of any `/implement-task` |
| `atomic-task-decomposition` | Breaking work into task files |
| `skill-authoring` | Noticing a recurring pattern with no existing skill — or before adding one, to check it's not a duplicate |

## Workflows (`workflows/`) — slash commands

| Command | Does |
|---|---|
| `/new-task <milestone>` | Architect + task-decomposer emit atomic task files |
| `/implement-task <id>` | Full red-green-review(-security) loop for one task |
| `/review-task <id>` | Re-run just the review pass |
| `/status` | Progress dashboard across task files |
| `/verify-spec <contract-file>` | Spot-check the repo against one contract |
| `/new-skill <topic>` | Draft, review, and register a new skill |

## MCP servers (`mcp_config.json`)

Pre-wired: Context7 (live library docs — the anti-hallucination coverage for
third-party APIs that `docs/ANTIHALLUCINATION.md` doesn't cover, since that
file is scoped to RailFog's own spec) and the official GitHub MCP server
(lets `reviewer`/`security-auditor` check real CI status instead of only
trusting a local run). Full reasoning, plus what to add later and what to
deliberately skip, in `MCP-RECOMMENDATIONS.md`.

## Hooks (`hooks.json` + `hooks/`)

- `SessionStart` — reminds the session `docs/contracts/` is canon.
- `PreToolUse` (bash) — `block-destructive-ops.sh` blocks `rm -rf /`,
  force-pushes, `DROP TABLE`, etc.
- `PostToolUse` (edit/write) — `post-edit-verify.sh` runs `deno fmt --check`
  / `deno lint` / `deno check` so verification claims are backed by real
  output.

If your Antigravity CLI version uses different hook event key names, the
scripts under `hooks/` are still valid standalone shell scripts — just
re-wire the JSON. See `../TROUBLESHOOTING.md`.
