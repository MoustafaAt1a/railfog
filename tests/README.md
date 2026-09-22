# Test Suites & Verification Pyramid (`tests/`)

> [!NOTE]
> **Testing Pyramid**: Strict 6-Tier Architecture &nbsp;|&nbsp;
> **Specification**: [PLAT-19 (Developer Tooling)](../docs/contracts/platform.contract.md#PLAT-19), [PLAT-20 (Invariants)](../docs/contracts/platform.contract.md#PLAT-20) &nbsp;|&nbsp;
> **Flake Policy**: Zero Flaky Tests (100% Deterministic)

This directory contains the centralized test suite for the RailFog platform. Per [`PLAT-19`](../docs/contracts/platform.contract.md#PLAT-19), all test files live strictly under `tests/`—collocated unit tests in production source folders are strictly forbidden.

---

## 1. Test Directory Taxonomy

```
tests/
├── unit/         # Fast, isolated testing of classes, functions, and models
├── contract/     # Spec-lock verification, parity testing, and structural invariants
├── security/     # Adversarial penetration testing, isolation, and secret leakage
├── integration/  # Multi-process communication, fail-static caching, and backoff retries
├── load/         # Rate limiter stress, concurrent bursts, and memory leak checks
└── e2e/          # Complete developer lifecycles and real-world workflows
```

| Directory | Target Scope | Execution Command | Key Invariants Verified |
|---|---|---|---|
| [`tests/unit/`](unit/) | Isolated modules | `deno task test:unit` | Fast, deterministic testing of isolated units with test doubles (~1,000+ tests). |
| [`tests/contract/`](contract/) | Specification Parity | `deno task test:contract` | Local/cloud provider parity ([`PLAT-17`](../docs/contracts/platform.contract.md#PLAT-17)), route specificity scoring ([`PLAT-11`](../docs/contracts/platform.contract.md#PLAT-11)), and architectural boundaries ([`PLAT-20`](../docs/contracts/platform.contract.md#PLAT-20)). |
| [`tests/security/`](security/) | Adversarial Verification | `deno task test:security` | Evaluates adversarial attacks: memory escapes, cross-tenant data bleed, secret leaks, header spoofing, prototype pollution. |
| [`tests/integration/`](integration/) | Multi-module daemons | `deno task test:integration` | Verifies fail-static snapshot serving during control plane outages ([`PLAT-8`](../docs/contracts/platform.contract.md#PLAT-8)), DLQ retries, and circuit breaking. |
| [`tests/load/`](load/) | Concurrency & Throughput | `deno task test:load` | Verifies token-bucket rate limiting ([`PLAT-9`](../docs/contracts/platform.contract.md#PLAT-9)), multi-tenant concurrency under load, and memory stability. |
| [`tests/e2e/`](e2e/) | End-to-End Workflows | `deno task test:e2e` | End-to-end user workflows: developer journey (`init` -> `dev` -> `deploy` -> `rollback`), direct client-to-storage uploads, and queue processing. |

---

## 2. Test Execution Commands

```bash
# Run the complete test suite across all tiers
deno task test

# Run the full quality and verification pipeline (check + lint + test)
deno task verify

# Run individual test tiers
deno task test:unit
deno task test:contract
deno task test:security
deno task test:integration

# Run a specific test file
deno test --allow-all tests/unit/docs_test.ts
```

---

## 3. Engineering Rules for Tests

1. **No Production Branching for Tests**: Production code paths must never branch on `isTest` or mock flags. Tests must provide test doubles implementing standard SPI interfaces (`ComputeProvider`, `KVProvider`, `ObjectProvider`, `QueueProvider`).
2. **Deterministic Dynamic Ports**: In unit tests booting HTTP servers, always bind to ephemeral port `0` to prevent Windows `AddrInUse` port collisions.
3. **Deterministic Timers**: Tests must never rely on arbitrary `sleep()` delays. Use explicit promises, events, or fake time harnesses.
