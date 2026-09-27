# T-0913 — Add Permissive Capability Aliases to Configuration Schema

Status: Done
Milestone: 0.9.1 Unified Four-Primitives & SDK Specification
Depends on: T-0911, T-0912
Blocks: T-0917

## Spec references

`PLAT-6`, `CONCEPT-2`, `CONCEPT-6`

## Scope

**In scope**:
- Modify `schemas/railfog.schema.json` under `properties.functions.additionalProperties.properties.permissions.properties` to allow:
  - `state`: array of string (alias for `kv`)
  - `data`: array of string (alias for `objects`)
  - `signal`: array of string (alias for `queues`)
- Ensure `additionalProperties: false` continues to strictly disallow unknown keys while accepting both naming conventions.
- Update `tests/unit/schemas_test.ts` to validate configurations using `state`, `data`, and `signal`.

**Out of scope**:
- Modifying runtime policy enforcement code (handled in T-0914).
- Modifying route definitions or function triggers.

## Interface to implement

```json
"permissions": {
  "type": "object",
  "description": "Strictly scoped capabilities injected at deployment time (PLAT-6, CONCEPT-6). Functions have zero ambient access beyond declared permissions.",
  "properties": {
    "kv": {
      "type": "array",
      "items": { "type": "string" },
      "description": "List of scoped KV namespace identifiers accessible to this function (KV-2, CONCEPT-2)."
    },
    "state": {
      "type": "array",
      "items": { "type": "string" },
      "description": "Canonical developer concept alias for kv (CONCEPT-2, CONCEPT-6)."
    },
    "objects": {
      "type": "array",
      "items": { "type": "string" },
      "description": "List of object storage buckets accessible to this function (OBJ-2, CONCEPT-2)."
    },
    "data": {
      "type": "array",
      "items": { "type": "string" },
      "description": "Canonical developer concept alias for objects (CONCEPT-2, CONCEPT-6)."
    },
    "queues": {
      "type": "array",
      "items": { "type": "string" },
      "description": "List of message queues this function can publish messages to (Q-2, CONCEPT-2)."
    },
    "signal": {
      "type": "array",
      "items": { "type": "string" },
      "description": "Canonical developer concept alias for queues (CONCEPT-2, CONCEPT-6)."
    },
    "network": {
      "type": "array",
      "items": { "type": "string" },
      "description": "Egress hostname allowlist (PLAT-5)."
    },
    "secrets": {
      "type": "array",
      "items": { "type": "string" },
      "description": "List of encrypted environment secrets injected via ctx.env (PLAT-15)."
    }
  },
  "allOf": [
    { "not": { "required": ["kv", "state"] } },
    { "not": { "required": ["objects", "data"] } },
    { "not": { "required": ["queues", "signal"] } }
  ],
  "additionalProperties": false
}
```

## Acceptance criteria (Given/When/Then)

1. Given a `railfog.toml` declaring `permissions = { state = ["app:sessions"] }`, when validated against `schemas/railfog.schema.json`, then validation succeeds without error.
2. Given a `railfog.toml` declaring `permissions = { data = ["app:uploads"], signal = ["app:jobs"] }`, when validated against `schemas/railfog.schema.json`, then validation succeeds without error.
3. Given a `railfog.toml` declaring an unknown permission key (e.g. `cache = ["foo"]`), when validated, then validation fails with schema violation.
4. Given a `railfog.toml` declaring both `kv` and `state` (or `objects` and `data`, or `queues` and `signal`), when validated against `schemas/railfog.schema.json`, then validation fails due to mutual exclusivity violation (`PLAT-6`).

## Tests required

- [x] Unit — `tests/unit/schemas_test.ts` asserting schema passes on `state`, `data`, and `signal`, and fails on arbitrary unrecognized properties.
- [x] Integration — none.
- [x] Security — Schema assertion verifying mutual exclusivity rejects simultaneous declaration of `kv` and `state`, `objects` and `data`, `queues` and `signal` (PLAT-6).

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

Existing configurations using `kv`, `objects`, `queues` remain 100% valid; `state`, `data`, `signal` are purely additive.
