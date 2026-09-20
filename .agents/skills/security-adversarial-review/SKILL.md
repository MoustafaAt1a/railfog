---
name: security-adversarial-review
description: Use whenever writing, reviewing, or discussing code that touches isolation, capability injection, network policy, secrets, or multi-tenancy (docs/contracts/platform.contract.md PLAT-4, PLAT-5, PLAT-6, PLAT-7, or PLAT-15, or functions.contract.md FN-6/FN-7). Not just for the security-auditor agent — any agent touching this surface should think adversarially, not just spec-compliantly.
---

# Security Adversarial Review

Matching spec is necessary but not sufficient for these clauses specifically —
code can cite the right clause ID and still be exploitable if it wasn't
written by someone actively trying to break it. This skill exists so that
`implementer` and `reviewer`, not only `security-auditor`, carry this mindset
while the code is being written, not just after.

## The clauses this applies to

`PLAT-4` (isolation), `PLAT-5` (network/SSRF), `PLAT-6`/`PLAT-7` (capability
injection, multi-tenancy), `PLAT-15` (secrets), `FN-6` (warm-isolate reuse),
`FN-7` (call-depth). If a task's Spec references include any of these, this
skill's checklist applies in addition to `railfog-contract-lock` and
`anti-slop-code-quality` — it does not replace either.

## While writing this code, ask

- **Capability injection (PLAT-6/PLAT-7):** could I construct or reach an
  out-of-scope resource through any method on this binding? Not "would it be
  denied" — could I even *call* it with an out-of-scope argument? If yes,
  the design is wrong, not just under-tested (see PLAT-6's testability
  requirement).
- **Isolation (PLAT-4) / warm reuse (FN-6):** does anything here persist in
  module scope across invocations? If a value is set once and read many
  times without being in the per-invocation `RailFogContext`, that's a
  candidate for state bleeding between tenants sharing a warm isolate.
- **Network (PLAT-5):** if this code makes an outbound request, is the
  destination checked by *resolved IP*, not just hostname? A hostname
  allowlist alone is bypassed by DNS rebinding — the mandatory IP-range block
  is a second, independent layer, not a fallback.
- **Secrets (PLAT-15):** could this value end up in a log line, an error
  message, a stack trace, or a stringified object passed to any of those? If
  a secret variable's value could reach `console.log`/`JSON.stringify`
  through a code path that isn't obviously "logging the secret," that's the
  finding — accidental leakage is the common case, not deliberate exfiltration.
- **Call depth (FN-7):** does this code path allow Function A to trigger
  Function B to trigger Function A, and if so, is the depth header actually
  checked before the call is made, not just incremented?

## The proof bar

"I read the code and it looks right" is not a finding closure for this
surface — write or point to the test that actually attempts the attack and
fails. This mirrors `docs/ANTIHALLUCINATION.md` Rule 5 (verification over
belief) applied specifically to security claims, where the cost of being
wrong is highest.

## What good adversarial framing sounds like

Not: "This binding correctly scopes KV access to the permitted namespace."
Instead: "I tried to construct a `KVBinding` call that reaches
`app:other-namespace` from a Function permitted only `app:sessions` — there
is no parameter, method, or prototype-chain path that accepts a different
namespace, so the access is inexpressible, not merely denied."
