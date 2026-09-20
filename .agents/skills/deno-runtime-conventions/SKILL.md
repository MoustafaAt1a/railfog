---
name: deno-runtime-conventions
description: Use when writing any code that runs inside the RailFog runtime or is part of the Deno/TypeScript toolchain itself (deno.json, permission flags, Web API usage). Keeps runtime code portable and consistent with the spec's Deno-first, Web-API-first stance.
---

# Deno Runtime Conventions

`docs/contracts/functions.contract.md` FN-1 requires RailFog Functions to be
built on standard Web APIs specifically so code stays portable off the
platform. This skill is the concrete checklist for honoring that in every
line of runtime-facing code.

## Prefer Web APIs over Deno- or Node-specific ones

| Use | Not |
|---|---|
| `Request` / `Response` / `Headers` / `URL` / `URLPattern` | Deno-specific request/response wrappers |
| `fetch()` | `Deno.connect` for anything HTTP-shaped |
| `ReadableStream` / `WritableStream` | Node-style `Readable`/`Writable` streams |
| Web Crypto (`crypto.subtle`, `crypto.randomUUID`) | `node:crypto` |
| `AbortSignal.timeout(ms)` | hand-rolled timeout races |
| Standard `Error` subclasses (see `packages/errors`) | ad hoc error shapes |

A Function author's code should read the same whether it eventually runs on
RailFog, plain Deno, or (per the spec's own long-term vision) any other
Web-API-compliant runtime. Runtime-internal code (under `runtime/`) has more
latitude to use Deno-specific APIs where the interface genuinely needs
platform capabilities (permissions, subprocess control for isolation) — but
even there, prefer the narrowest Deno API that does the job.

## `deno.json` task names are fixed

Reuse exactly: `dev`, `test`, `check`, `lint`, `fmt` (established in
T-0101). Don't add a differently-named task for the same purpose in a later
package — if a new package needs its own check step, it's wired into the
existing task, not a new top-level task name.

## Permissions are explicit, not `-A`

Runtime code that invokes `Deno.Command` or grants Function-facing
permissions must state exactly which permission it needs
(`--allow-net=api.example.com`, not `--allow-net`, per
`docs/contracts/platform.contract.md` PLAT-5's allowlist model). `deno test -A`
is acceptable for the test runner itself (a trusted context) but never as a
pattern that leaks into how a Function's own permissions get resolved.

## Dependencies

Deno-native imports (`https://` specifiers pinned via `deno.json` imports
map, or JSR) are preferred over pulling in an npm package for something the
standard library or a Web API already covers. When an npm package genuinely
is needed, pin it exactly (no floating ranges) — this is the same
"dependency security" discipline the spec asks for at the platform level,
applied to the harness's own code.

## Formatting and linting are not optional per-task

Every task's Definition of Done requires real `deno fmt --check` / `deno lint`
output, not just `deno check`. A diff that type-checks but isn't formatted or
has lint warnings does not close a task — see
`.agents/skills/tdd-atomic-protocol/SKILL.md`.
