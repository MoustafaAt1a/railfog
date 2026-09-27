# Milestone 0.9.2 — Master Autonomous Engineering, Forensic Audit, Hardening & Productionization Gate

**Goal**: Conduct an exhaustive forensic audit across all 25 critical architectural and security dimensions; resolve egress SSRF coverage gaps by including RFC 4193 IPv6 ULA (`fc00::/7`) and RFC 6598 Carrier-Grade NAT (`100.64.0.0/10`); expand static pre-deploy secret diagnostics for SDK `c.env` context bindings; guarantee mathematical determinism in URLPattern specificity scoring; achieve 100% clean formatting and diff hygiene; align the release gatekeeper with v0.9.2 standards; and achieve a 100% green verification across all unit, integration, contract, security, load, and e2e test suites.

---

## 1. Theoretical & Security Foundations

1. **SSRF Defense-in-Depth & Non-Routable CIDR Boundaries (PLAT-5)**:
   - *Problem*: In egress network proxying, while RFC 1918 private IPv4 and AWS metadata (`fd00:ec2::/8`) were blocked, general IPv6 Unique Local Addresses (`fc00::/7` covering all `fc00::/8` and `fd00::/8`) and RFC 6598 Carrier-Grade NAT (`100.64.0.0/10` used by internal cloud VPCs and Kubernetes pod overlays) were not included in mandatory default blocks.
   - *Theoretical Grounding*: RFC 4193 and RFC 6598 specify reserved address spaces that must never be routed across public transit. Blocking both at connect time by resolved IP ensures complete protection against cloud metadata exfiltration and internal VPC SSRF.

2. **Static Secret Reference Analysis & SDK Context Ergonomics (PLAT-6, PLAT-15)**:
   - *Problem*: Pre-deploy diagnostic regex statically matched `ctx.env` and `Deno.env`, but ergonomic SDK handlers canonicalize on `c` (`HandlerContext`).
   - *Theoretical Grounding*: Deterministic regular expressions recognizing `c.env`, `ctx.env`, and `Deno.env` ensure pre-deploy verification flags undeclared secrets regardless of handler syntax style.

3. **Deterministic Routing Specificity (PLAT-11)**:
   - *Problem*: Complex route patterns involving regex groups and URLPattern segments must be evaluated with absolute determinism and monotonic tie-breaking.
   - *Theoretical Grounding*: Strict evaluation of literal segment weights ($W_{\text{literal}} = 2$) and variable/wildcard segment weights ($W_{\text{pattern}} = 1$) with stable declaration-order tie-breaking.

4. **Diff Hygiene & Release Gate Certification (PLAT-19)**:
   - *Problem*: Workspace code formatting drift blocks release gate Step 1 (`fmt --check`).
   - *Theoretical Grounding*: Automated deterministic code formatting standardizes all AST nodes, removing syntax drift and guaranteeing 100% green release gate compliance.

---

## 2. Dependency Graph

```
Wave 1 (Security & Diagnostic Hardening):
  T-0923 (SSRF Defense-in-Depth Expansion for Carrier-Grade NAT & IPv6 ULA)
  T-0924 (Pre-Deploy Diagnostic Scanner Context Ergonomics)
  T-0925 (Deterministic Route Matcher Specificity & Param-Group Stability)

Wave 2 (Code Hygiene & Gate Alignment — depends on Wave 1):
  T-0926 (Codebase Formatting & Diff Hygiene Standardization)
  T-0927 (Pre-Release Certification Gate Version Alignment & Pipeline Verification)

Wave 3 (Verification & Release Gate Closure — depends on Waves 1-2):
  T-0928 (Milestone 0.9.2 Forensic Hardening & Adversarial Verification Suite)
```

---

## 3. Tasks Summary

| ID | Title | Scope | Spec References |
|---|---|---|---|
| `T-0923` | SSRF Defense-in-Depth Expansion for Carrier-Grade NAT & IPv6 ULA | `runtime/sandbox/egress-ip-blocker.ts` | `PLAT-5` |
| `T-0924` | Pre-Deploy Diagnostic Scanner Context Ergonomics | `packages/core/diagnostics/deploy-analyzer.ts` | `PLAT-6`, `PLAT-15` |
| `T-0925` | Deterministic Route Matcher Specificity & Param-Group Stability | `runtime/router/route-matcher.ts` | `PLAT-11` |
| `T-0926` | Codebase Formatting & Diff Hygiene Standardization | Repository-wide | `PLAT-19`, `docs/ANTI-SLOP.md` |
| `T-0927` | Pre-Release Certification Gate Version Alignment & Pipeline Verification | `scripts/release_gate.ts` | `PLAT-19` |
| `T-0928` | Milestone 0.9.2 Forensic Hardening & Adversarial Verification Suite | `tests/unit/milestone_092_hardening_test.ts` | `PLAT-5`, `PLAT-6`, `PLAT-11`, `PLAT-15`, `PLAT-19` |

---

## 4. Out of scope for the whole milestone

Modifying or breaking existing contracts in `docs/contracts/`, rewriting functional provider implementations, introducing unvetted third-party dependencies, weakening isolation boundaries, or adding 1.0 features not defined in the LTS spec.
