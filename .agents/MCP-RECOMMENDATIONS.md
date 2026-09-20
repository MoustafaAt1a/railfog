# MCP Recommendations

Two are worth adding now. Two more are worth adding later, when the build
actually reaches the milestone that needs them. A few popular ones are worth
deliberately *not* adding, for the same "don't add infrastructure because it
sounds impressive" reason the spec itself gives (`AGENTS.md` §3, Rule 1).

Antigravity CLI reads workspace-level MCP config from `.agents/mcp_config.json`
— that file already ships in this package with the two "add now" servers
wired in (no real keys in it; you fill those in via environment variables).
Global config, if you want a server available outside this one workspace,
lives at `~/.antigravity/mcp_config.json` on current installs — I found this
path phrased slightly differently across sources depending on CLI version
(`~/.gemini/config/mcp_config.json` and `~/.gemini/antigravity-cli/mcp_config.json`
both show up too), so if the workspace-level file alone doesn't get picked
up, check `/mcp` inside a running session to see which global path your
install actually uses.

## Add now

### Context7 (Upstash) — the one that matters most for this harness specifically

This harness spends a lot of its weight on one failure mode: agents
confidently generating an API that doesn't exist. `docs/ANTIHALLUCINATION.md`
covers that for RailFog's *own* spec — but `implementer` and `test-writer`
are also going to be writing against Deno's standard library, SQLite driver
APIs, and (from Milestone 0.2 on) Cloudflare's Workers/R2/Queues SDKs and a
Postgres client. That's a different, just as real, hallucination surface, and
nothing in the harness currently covers it. Context7 does exactly this: it
fetches real, version-specific library docs into context instead of letting
a model guess from training data.

Already wired into `.agents/mcp_config.json`. Works without an API key; get
a free one at `context7.com/dashboard` and set it as `CONTEXT7_API_KEY` in
your environment — worth doing given how often a multi-agent loop like this
one will call it.

**Where it actually helps in this repo:** `test-writer` and `implementer`
should reach for it before writing any code against `Deno.*` APIs, SQLite
bindings, or (later) a provider SDK — same instinct as
`.agents/skills/deno-runtime-conventions/SKILL.md`, just backed by a live
lookup instead of memory.

### GitHub MCP server (official)

The harness already assumes GitHub: `.github/workflows/ci.yml` exists,
`docs/adr/` is the kind of thing teams often mirror as GitHub Discussions or
Issues, and `docs/ANTIHALLUCINATION.md` Rule 5 (verification over belief)
is only as strong as what a model can actually check. Right now, `reviewer`
and `security-auditor` can run `deno check`/`deno test` locally, but they
have no way to confirm the *actual* CI run on a pushed commit passed —
they're stuck trusting a local run stood in for it. The GitHub MCP server
closes that gap: it can check real Actions run status, open/read PRs and
issues, and let `architect` track ADRs as issues if you want that instead of
(or alongside) `docs/adr/*.md` files.

Already wired into `.agents/mcp_config.json` using GitHub's official hosted
endpoint. You'll need a fine-grained Personal Access Token scoped to just
this repo — read-only is enough for `reviewer`/`security-auditor`'s use case;
only grant write/PR-creation scope if you actually want an agent opening PRs
on your behalf, and if so, treat that the way the harness treats any other
irreversible action — confirm before it happens, don't let it run unattended.

## Add later — not yet, but worth knowing about

### Cloudflare MCP server (official, hosted) — from Milestone 0.2 on

`docs/contracts/platform.contract.md` PLAT-16/17 names Cloudflare
Workers/KV/R2/Queues as the initial production provider substrate. The exact
mistake that produced Audit Finding #1 (`docs/00-deep-analysis.md` §1) — a
false claim about Workers KV's consistency guarantee — is precisely the kind
of error a live Cloudflare MCP connection prevents, by letting `architect`
and `implementer` check real API behavior and real free-tier limits instead
of asserting them from memory. Not needed for Milestone 0.1 (everything's
local/SQLite). Add it when `/new-task 0.2` starts:

```json
"cloudflare": {
  "url": "https://mcp.cloudflare.com/mcp",
  "headers": { "Authorization": "Bearer ${CLOUDFLARE_API_TOKEN}" }
}
```

Verify the exact hosted URL and token scopes at Cloudflare's own MCP docs
when you get there — connector URLs and auth flows in this space change
often enough that I wouldn't trust a months-old citation for either.

### Postgres MCP — once control-plane metadata work begins

The spec's own "Database Strategy" names PostgreSQL for control-plane
metadata (not the RailFog KV primitive itself — see `docs/contracts/kv.contract.md`
KV-5 on why those are different things). Once that work starts (0.2/0.4
territory), a Postgres MCP lets agents inspect the real schema instead of
guessing column types. I'm deliberately not naming a specific package here —
the MCP steering group's own reference Postgres server has reportedly been
archived in favor of community forks, and I'd rather you search the registry
for the current best-maintained option when you actually need it than ship
you a name I can't verify is still the right one by then.

## Deliberately not recommended

**Filesystem and Git MCP servers.** Antigravity CLI already has native file
read/write and git access as a coding agent — these are the connectors you'd
add to a chat client (like Claude Desktop) that doesn't otherwise touch your
filesystem. Adding them here would be exactly the "add infrastructure
because it sounds impressive" pattern `AGENTS.md` §3 already tells every
agent in this repo not to do. Skip them.

**Sequential Thinking MCP.** This harness already has its own structured
reasoning mechanism — atomic task decomposition
(`.agents/skills/atomic-task-decomposition/SKILL.md`) plus Claude's own
extended thinking on `implementer`/`reviewer`. A generic step-by-step-prompting
MCP on top of that is redundant, not additive.

## If you want to scope a server to specific agents only

Antigravity's per-agent `tools:` frontmatter (used throughout
`.agents/agents/*.md`) is how tool access gets restricted per role elsewhere
in this harness. I haven't found a fully confirmed, version-stable syntax
for naming a specific MCP server's tools inside that same list, so I'm not
writing one into the six agent files — don't want to hand you a config line
that silently no-ops on your CLI version. If you want, say so, and check
what `/mcp` shows as the exact tool names once Context7/GitHub are connected
— from there it's the same pattern as everything else in `tools:`, just with
the real names substituted in.
