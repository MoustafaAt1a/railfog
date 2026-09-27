# Contributor Testing Guide

> [!NOTE]
> **Documentation**: [Docs Home](../README.md) &nbsp;|&nbsp; **Specification**:
> [`PLAT-19`](../contracts/platform.contract.md#PLAT-19) &nbsp;|&nbsp;
> **Standard**: 100% Green Verification Across All Suites

Testing in RailFog is rigorous, deterministic, and layered across five distinct
test categories.

---

## 1. Test Suite Structure

```
tests/
├── unit/         # Isolated component and package tests (tests/unit/)
├── contract/     # Spec clause and provider parity tests (tests/contract/)
├── security/     # Adversarial penetration and sandbox escape tests (tests/security/)
├── load/         # High-concurrency throughput and memory leak benchmarks (tests/load/)
└── e2e/          # Full multi-daemon integration and soak simulations (tests/e2e/)
```

---

## 2. Running Test Suites

Run individual suites using dedicated Deno tasks:

```bash
# 1. Unit Tests (~450+ tests covering packages, CLI, and providers)
deno task test:unit

# 2. Contract & Provider Parity Tests
deno task test:contract

# 3. Adversarial Security Tests (SSRF, credentials, sandbox escapes)
deno task test:security

# 4. Load & Concurrency Benchmarks
deno task test:load

# 5. End-to-End & Soak Simulations
deno task test:e2e
```

---

## 3. Local Verification (`deno task verify`)

Run the fast multi-suite verification check:

```bash
deno task verify
```

Executes `check`, `lint`, `fmt:check`, `test:unit`, `test:contract`, and
`test:security` sequentially.

---

## 4. The 8-Step Pre-Release Certification Gate

Before any release candidate or milestone closure, run the release gatekeeper:

```bash
deno task release:gate
```

This executes all 8 release gates sequentially:

1. `deno fmt --check` (Formatting)
2. `deno lint` (Linter)
3. `deno task check` (Typecheck)
4. `deno task test:unit` (Unit Tests)
5. `deno task test:contract` (Contract & Parity)
6. `deno task test:security` (Adversarial Security)
7. `deno task test:load` (Load & Concurrency)
8. `deno task test:e2e` (End-to-End & Soak)

All 8 gates must pass with zero warnings, zero failures, and zero skipped
assertions.
