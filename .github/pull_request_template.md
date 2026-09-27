## Description of Change
<!-- What was changed, and why was this change necessary? -->

## Motivation & Context
<!-- Which issue, task, or specification requirement does this address? -->

## Verification
<!-- Provide the exact command(s) and test output demonstrating correctness -->
- [ ] `deno task check` (Typecheck passed)
- [ ] `deno fmt --check` (Formatting verified)
- [ ] `deno lint` (Linter passed)
- [ ] `deno test -A tests/unit/` (Unit tests passed)

Command run:
```bash
# Paste verification command and output summary here
```

## Contract & Specification Impact
- [ ] Does this PR modify, add, or contradict any contract in `docs/contracts/`?
  - If YES: Please reference the associated ADR or clause.

## Security & Isolation Impact
- [ ] Does this PR touch runtime isolation, egress network policy, capabilities, or secrets (`PLAT-4`, `PLAT-5`, `PLAT-6`, `PLAT-7`, `PLAT-15`, `FN-6`, `FN-7`)?
  - If YES: Have adversarial security tests been added to `tests/security/`?

## Documentation Impact
- [ ] Have all affected documentation pages, guides, or references in `docs/` been updated?
- [ ] Did `deno test -A tests/unit/docs_test.ts` pass?
