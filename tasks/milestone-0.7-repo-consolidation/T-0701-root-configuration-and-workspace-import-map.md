# T-0701 — Root Configuration and Workspace Import Map

Status: Complete
Milestone: 0.7 Repo Consolidation
Depends on: none
Blocks: T-0702, T-0703, T-0704, T-0705, T-0706, T-0707, T-0708, T-0709, T-0710

## Spec references

`PLAT-19`

## Scope

**In scope**:
- `deno.json`: Configure root workspace import map with `@railfog/*` path mappings for all packages and primitives:
  - `@railfog/core`: `./packages/core/mod.ts`
  - `@railfog/config`: `./packages/config/mod.ts`
  - `@railfog/api`: `./packages/api/mod.ts`
  - `@railfog/auth`: `./packages/auth/mod.ts`
  - `@railfog/errors`: `./packages/errors/mod.ts`
  - `@railfog/logging`: `./packages/logging/mod.ts`
  - `@railfog/metrics`: `./packages/metrics/mod.ts`
  - `@railfog/policy`: `./packages/policy/mod.ts`
  - `@railfog/protocol`: `./packages/protocol/mod.ts`
  - `@railfog/testing`: `./packages/testing/mod.ts`
  - `@railfog/primitives/functions`: `./primitives/functions/mod.ts`
  - `@railfog/primitives/kv`: `./primitives/kv/mod.ts`
  - `@railfog/primitives/objects`: `./primitives/objects/mod.ts`
  - `@railfog/primitives/queues`: `./primitives/queues/mod.ts`
- `deno.json`: Configure strict compiler options (`compilerOptions: { "strict": true, "noImplicitAny": true, "noUnusedLocals": false }`).
- `deno.json`: Define standardized test execution tasks with `--allow-env` permission flag:
  - `test:unit`: `deno test --allow-read --allow-write --allow-env tests/unit/`
  - `test:integration`: `deno test --allow-read --allow-write --allow-net --allow-env tests/integration/`
  - `test:contract`: `deno test --allow-read --allow-write --allow-net --allow-env tests/contract/`
  - `test:security`: `deno test --allow-read --allow-write --allow-net --allow-env tests/security/`
  - `test:load`: `deno test --allow-read --allow-write --allow-net --allow-env tests/load/`
  - `test:e2e`: `deno test --allow-read --allow-write --allow-net --allow-env tests/e2e/`
  - Update `test` task to include `--allow-env`.

**Out of scope**:
- Modifying contract files under `docs/contracts/`.
- Changing application logic or existing implementation files.

## Interface to implement

`deno.json` configuration block:

```json
{
  "unstable": ["kv"],
  "compilerOptions": {
    "strict": true
  },
  "imports": {
    "@std/assert": "jsr:@std/assert@0.224.0",
    "@std/encoding/hex": "jsr:@std/encoding@0.224.0/hex",
    "@std/encoding/base64": "jsr:@std/encoding@0.224.0/base64",
    "@std/crypto": "jsr:@std/crypto@0.224.0",
    "@std/async": "jsr:@std/async@0.224.0",
    "@std/async/delay": "jsr:@std/async@0.224.0/delay",
    "@std/path": "jsr:@std/path@0.224.0",
    "@std/toml": "jsr:@std/toml@0.224.0",
    "@railfog/core": "./packages/core/mod.ts",
    "@railfog/config": "./packages/config/mod.ts",
    "@railfog/api": "./packages/api/mod.ts",
    "@railfog/auth": "./packages/auth/mod.ts",
    "@railfog/errors": "./packages/errors/mod.ts",
    "@railfog/logging": "./packages/logging/mod.ts",
    "@railfog/metrics": "./packages/metrics/mod.ts",
    "@railfog/policy": "./packages/policy/mod.ts",
    "@railfog/protocol": "./packages/protocol/mod.ts",
    "@railfog/testing": "./packages/testing/mod.ts",
    "@railfog/primitives/functions": "./primitives/functions/mod.ts",
    "@railfog/primitives/kv": "./primitives/kv/mod.ts",
    "@railfog/primitives/objects": "./primitives/objects/mod.ts",
    "@railfog/primitives/queues": "./primitives/queues/mod.ts"
  },
  "tasks": {
    "dev": "deno run --allow-read --allow-write --allow-net cli/main.ts dev",
    "test": "deno test --allow-read --allow-write --allow-net --allow-run --allow-env",
    "test:unit": "deno test --allow-read --allow-write --allow-env tests/unit/",
    "test:integration": "deno test --allow-read --allow-write --allow-net --allow-env tests/integration/",
    "test:contract": "deno test --allow-read --allow-write --allow-net --allow-env tests/contract/",
    "test:security": "deno test --allow-read --allow-write --allow-net --allow-env tests/security/",
    "test:load": "deno test --allow-read --allow-write --allow-net --allow-env tests/load/",
    "test:e2e": "deno test --allow-read --allow-write --allow-net --allow-env tests/e2e/",
    "check": "deno check **/*.ts",
    "lint": "deno lint",
    "fmt": "deno fmt"
  }
}
```

## Acceptance criteria (Given/When/Then)

1. Given the updated `deno.json`, when inspecting workspace tasks, then granular test commands `test:unit`, `test:integration`, `test:contract`, `test:security`, `test:load`, `test:e2e` exist and include the `--allow-env` flag.
2. Given `@railfog/*` imports in `deno.json`, when a module imports `@railfog/<package>`, then Deno resolves the path alias directly to the corresponding workspace entrypoint.
3. Given strict compiler options in `deno.json`, when running `deno check`, then Deno applies strict type checking across all workspace files.

## Tests required

- [x] Unit — `tests/unit/deno_config_test.ts`: Read `deno.json`, parse JSON, and assert all required `@railfog/*` aliases, granular test tasks, and compiler options are declared.

## Definition of Done

- [x] Implementation matches every cited clause ID exactly
- [x] Spec-anchor comments present at each RailFog-specific decision point
- [x] Unit tests written first (red), then implementation (green)
- [x] `deno check` run, real output attached, zero errors
- [x] `deno test` run, real output attached, all required tests passing
- [x] `deno lint` run, real output attached, zero warnings
- [x] No item from `docs/ANTI-SLOP.md` violated
- [x] Reviewer pass complete; security-auditor pass complete if triggered
- [x] Nothing outside "In scope" touched

## Assumptions made

None.
