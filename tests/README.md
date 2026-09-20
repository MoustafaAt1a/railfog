# Tests (`tests/`)

Centralized testing pyramid for RailFog per [`PLAT-19`](file:///C:/FM/railfog/docs/contracts/platform.contract.md#L311).

All tests live strictly under `tests/` — collocated unit tests in source directories are forbidden.

## Test Directory Taxonomy

| Directory | Scope | Execution Command | Purpose |
|---|---|---|---|
| [`tests/unit/`](file:///C:/FM/railfog/tests/unit) | Isolated modules | `deno task test:unit` | Fast, deterministic testing of isolated classes, functions, and models without external dependencies (~1,000+ tests). |
| [`tests/contract/`](file:///C:/FM/railfog/tests/contract) | Spec & Parity | `deno task test:contract` | Verifies local/cloud provider parity ([`PLAT-17`](file:///C:/FM/railfog/docs/contracts/platform.contract.md#L288)) and repository structural invariants ([`PLAT-19`](file:///C:/FM/railfog/docs/contracts/platform.contract.md#L311), [`PLAT-20`](file:///C:/FM/railfog/docs/contracts/platform.contract.md#L330)). |
| [`tests/security/`](file:///C:/FM/railfog/tests/security) | Adversarial | `deno task test:security` | Evaluates adversarial attacks: memory escape, cross-tenant data bleed, secret leakage, header spoofing, prototype pollution. |
| [`tests/integration/`](file:///C:/FM/railfog/tests/integration) | Multi-module | `deno task test:integration` | Verifies fail-static snapshot serving during control plane outages ([`PLAT-8`](file:///C:/FM/railfog/docs/contracts/platform.contract.md#L129)), DLQ retries, circuit breaking. |
| [`tests/load/`](file:///C:/FM/railfog/tests/load) | Throughput & Burst | `deno task test:load` | Verifies token-bucket rate limiting ([`PLAT-9`](file:///C:/FM/railfog/docs/contracts/platform.contract.md#L147)), multi-tenant concurrency under load, memory stability. |
| [`tests/e2e/`](file:///C:/FM/railfog/tests/e2e) | End-to-End | `deno task test:e2e` | End-to-end user workflows: developer journey (`init` -> `dev` -> `deploy` -> `rollback`), direct client-to-storage uploads, queue processing. |

## Running Tests

```bash
# Run all unit tests
deno task test:unit

# Run individual test file
deno test --allow-read --allow-write --allow-net --allow-run --allow-env tests/unit/packages_core_test.ts

# Run entire test suite
deno task test
```
