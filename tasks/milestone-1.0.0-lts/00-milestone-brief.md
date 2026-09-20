# Milestone 1.0.0 — Production LTS Release Verification & Hardening

**Goal**: Establish and seal the production-grade Long Term Support (v1.0.0 LTS) release of RailFog:
a minimal application-infrastructure platform reduced to `Trigger → Function → {KV, Objects, Queues}`.

1. **Primitive & Contract Lock (v1.0.0 LTS)**:
   - Full conformance to `docs/contracts/` across all 4 primitives (`functions.contract.md`, `kv.contract.md`, `objects.contract.md`, `queues.contract.md`) and `platform.contract.md`.
   - Banned patterns verification: zero runtime ACL checks (`PLAT-6`), zero un-jittered retries (`Q-5`), zero unbounded KV dedupe keys (`KV-2`, `Q-4`), zero bandwidth proxying (`OBJ-3`), zero control-plane roundtrips on data path (`PLAT-8`).

2. **Theoretical & Algorithmic Foundations Grounded**:
   - Rate limiting: Token Bucket with integer micro-second replenishment and leak-free bucket lifecycle (`PLAT-9`).
   - Concurrency & Retries: Optimistic Concurrency Control (CAS) with versioning and AWS-research-backed Decorrelated Jitter (`KV-3`, `Q-5`).
   - Routing: Deterministic URLPattern specificity scoring algorithm (`PLAT-11`).
   - Security: Connect-time CIDR and SSRF protection with DNS rebinding defense (`PLAT-5`).
   - Observability & Billing: Subresource integrity, ULID Crockford Base32 monotonicity, and micro-cent financial calculation (`PLAT-10`, `PLAT-13`, `PLAT-14`).

3. **Wrangler & Railway Tier Developer Experience**:
   - Zero-copy browser login with cryptographic callback state nonce.
   - Interactive terminal UI (spinners, prompts, ANSI color formatting).
   - Fast hot-reloading dev server with local SQLite/LocalFS parity (`PLAT-17`).
   - Universal one-line installers for Linux, macOS, and Windows.

---

## Tasks Summary

| ID       | Title                                               | Scope                                  | Spec References                                             |
| -------- | --------------------------------------------------- | -------------------------------------- | ----------------------------------------------------------- |
| `T-1001` | Milestone 1.0.0 LTS Verification & Integrity Audit | `tests/`, `cli/`, `runtime/`, `docs/` | `PLAT-1` through `PLAT-20`, `FN-1`–`FN-8`, `KV-1`–`KV-5`, `OBJ-1`–`OBJ-4`, `Q-1`–`Q-6` |
