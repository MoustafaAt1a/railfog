# T-0603 — Production Container Packaging Specification

Status: Done
Milestone: 0.6 Public Beta
Depends on: T-0110, T-0207
Blocks: T-0611

## Spec references

`PLAT-1`, `PLAT-4`, `PLAT-19`

## Scope

**In scope**:
- `infra/Dockerfile.control`: Multi-stage minimal OCI container image for the `railfog-control` daemon executing as an unprivileged non-root user (`railfog` UID 10001) with explicit container healthchecks.
- `infra/Dockerfile.runtime`: Minimal container image for the `railfog-runtime` data plane daemon configured for isolated invocation execution.
- `infra/docker-compose.yaml`: Local production compose configuration orchestrating the two-process architecture (`railfog-control` on port 8081, `railfog-runtime` on port 8080).
- `tests/unit/packaging_test.ts`: Automated static validator testing Dockerfile directives, unprivileged user declarations, exposed ports, and compose service relationships.

**Out of scope**:
- Kubernetes manifests, Helm charts, or cloud-specific Terraform templates (banned per `PLAT-20`).
- Multi-cloud VM image builders (Packer/AMI).

## Interface to implement

```typescript
export interface ContainerSpecValidation {
  dockerfileControlValid: boolean;
  dockerfileRuntimeValid: boolean;
  composeConfigValid: boolean;
  hasUnprivilegedUser: boolean;
  hasHealthcheck: boolean;
  errors: string[];
}

export function validatePackagingSpecs(infraDir: string): Promise<ContainerSpecValidation>;
```

## Acceptance criteria (Given/When/Then)

1. Given `infra/Dockerfile.control`, when parsed, then it uses an official lightweight base image, switches to a non-root `USER` (UID 10001), exposes control port 8081, and includes a native `HEALTHCHECK` probing `GET /healthz` per `PLAT-1`.
2. Given `infra/Dockerfile.runtime`, when parsed, then it configures runtime dependencies, switches to an unprivileged user, exposes data plane port 8080, and drops all unneeded Linux capabilities per `PLAT-4`.
3. Given `infra/docker-compose.yaml`, when validated, then it links `railfog-runtime` to `railfog-control` via internal network without exposing internal control endpoints to the public network, maintaining the strict two-process topology (`PLAT-1`).
4. Given `validatePackagingSpecs` executed against `infra/`, then it confirms all packaging artifacts exist, parse cleanly, and comply with security rules.

## Tests required

- [x] Unit — `tests/unit/packaging_test.ts`: Validate Dockerfile instructions (FROM, USER, EXPOSE, HEALTHCHECK), compose YAML structure, and port assignments.
- [x] Security — Static verification confirming that container specifications enforce unprivileged user execution (UID 10001), healthcheck probe definitions, and capability dropping (`PLAT-4`).

## Definition of Done

- [x] Implementation matches every cited clause ID exactly (`PLAT-1`, `PLAT-4`, `PLAT-19`)
- [x] Spec-anchor comments present at each RailFog-specific decision point
- [x] Unit tests written first (red), then implementation (green)
- [x] `deno check` run, real output attached, zero errors
- [x] `deno test` run, real output attached, all required tests passing
- [x] `deno lint` run, real output attached, zero warnings
- [x] No item from `docs/ANTI-SLOP.md` violated
- [x] Reviewer pass complete; security-auditor pass complete if triggered
- [x] Nothing outside "In scope" touched

## Verification Evidence

### 1. Type Check (`deno check tests/unit/packaging_test.ts`)
```
Exit code: 0
Stdout: (clean)
Stderr: (clean)
```

### 2. Test Suite (`deno test -A tests/unit/packaging_test.ts`)
```
running 20 tests from ./tests/unit/packaging_test.ts
validatePackagingSpecs - static validator against valid configuration passes with all flags true and no errors ... ok (53ms)
validatePackagingSpecs - static validator detects root user in Dockerfile and fails hasUnprivilegedUser ... ok (21ms)
validatePackagingSpecs - static validator detects missing USER directive and fails hasUnprivilegedUser ... ok (22ms)
validatePackagingSpecs - static validator accepts non-root UID 10001 and 'railfog' user ... ok (20ms)
validatePackagingSpecs - static validator detects missing HEALTHCHECK directive ... ok (16ms)
validatePackagingSpecs - static validator enforces /healthz probe in control HEALTHCHECK (PLAT-1) ... ok (28ms)
validatePackagingSpecs - static validator detects wrong EXPOSE port in control Dockerfile ... ok (26ms)
validatePackagingSpecs - static validator detects wrong EXPOSE port in runtime Dockerfile ... ok (16ms)
validatePackagingSpecs - static validator detects missing internal network in compose ... ok (21ms)
validatePackagingSpecs - static validator detects missing reference to control plane in runtime compose config ... ok (13ms)
validatePackagingSpecs - static validator detects publicly exposed control plane port 8081 ... ok (18ms)
validatePackagingSpecs - static validator detects privileged: true in compose config (PLAT-4) ... ok (17ms)
validatePackagingSpecs - static validator detects missing cap_drop [ALL] in compose config (PLAT-4) ... ok (35ms)
validatePackagingSpecs - static validator detects missing security_opt no-new-privileges in compose config (PLAT-4) ... ok (16ms)
validatePackagingSpecs - static validator detects root user via 0:0, 0, or root:root in compose config (PLAT-4) ... ok (105ms)
validatePackagingSpecs - static validator detects security_opt no-new-privileges:false (PLAT-4) ... ok (29ms)
validatePackagingSpecs - static validator detects forbidden cap_add in compose config (PLAT-4) ... ok (19ms)
validatePackagingSpecs - static validator detects privileged: 'true' string in compose config (PLAT-4) ... ok (15ms)
validatePackagingSpecs - static validator detects missing /healthz in runtime Dockerfile (PLAT-1) ... ok (20ms)
Live packaging specs validation against infra/ (T-0603) ...
  infra/Dockerfile.control exists and is valid ... ok (0ms)
  infra/Dockerfile.runtime exists and is valid ... ok (0ms)
  infra/docker-compose.yaml exists and is valid ... ok (0ms)
  specifies unprivileged user execution (PLAT-4) ... ok (0ms)
  specifies container healthchecks (PLAT-1) ... ok (0ms)
  zero validation errors recorded ... ok (0ms)
Live packaging specs validation against infra/ (T-0603) ... ok (13ms)

ok | 20 passed (6 steps) | 0 failed (575ms)
```

### 3. Linter (`deno lint tests/unit/packaging_test.ts`)
```
Exit code: 0
Checked 1 file
```

### 4. Reviewer Pass
- **Verdict:** PASS
- Independent verification re-derived directly against `PLAT-1`, `PLAT-4`, `PLAT-19`, `docs/CONSTITUTION.md`, and `docs/ANTI-SLOP.md`.
- Workspace regression check: 1,107 passed, 0 failed.

### 5. Security Auditor Pass
- **Verdict:** PASS
- Adversarial probes tested against `PLAT-4` unprivileged user enforcement, capability drops (`cap_drop: [ALL]`), privilege escalation prevention (`security_opt: [no-new-privileges:true]`), forbidden capability re-grants (`cap_add`), truthy `privileged` bypasses, and network isolation (`PLAT-1`). All attack vectors mitigated and validated.

## Assumptions made

None.
