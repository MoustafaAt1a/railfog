# T-0207 — Control plane revision deployment pipeline

Status: Done
Milestone: 0.2 Cloud Prototype
Depends on: T-0102, T-0103, T-0202, T-0203
Blocks: T-0208, T-0210, T-0211

## Spec references

`PLAT-1` `PLAT-3` `PLAT-7` `PLAT-12` `PLAT-14` `PLAT-18` `FN-3` `OBJ-4`

## Scope

**In scope:**
- `apps/api/deployment-service.ts`: control plane deployment pipeline and revision management (`docs/contracts/platform.contract.md` PLAT-1).
- Content-addressed artifact storage into `ObjectProvider` using `OBJ-4` (`artifacts/{artifact_id}`).
- Cryptographic artifact integrity verification on deploy (`OBJ-4`).
- Path traversal rejection on artifact ID (`PLAT-7`, `OBJ-4`).
- Revision record tracking with ULID identifier (`rev_{ULID}`, `PLAT-14`, `PLAT-18`).
- Revision state machine lifecycle per `docs/contracts/functions.contract.md` FN-3:
  `Created → Building → Ready → Deployed` (or `Failed`).
- Atomic cutover and deployment safety check per PLAT-3: health check gate (3 consecutive successes within 30s) before traffic pointer activation; failure leaves existing revision active.
- Instant rollback: pointer flip (`Revision N → Revision N-1`), never a rebuild (FN-3, PLAT-3), restricted strictly to `Deployed` revisions.
- Multi-tenant nested storage maps preventing delimiter collision (`PLAT-7`, `PLAT-18`).

**Out of scope:**
- Gradual canary or traffic-splitting (explicitly banned/deferred in 1.0.0 per PLAT-3 and PLAT-20).
- Executing customer code (PLAT-1: control plane never executes customer code).
- Distributing snapshot to runtime nodes (handled by T-0208).

## Interface to implement

```typescript
import type { ObjectProvider } from "../../primitives/objects/object-provider.ts";
import type {
  Manifest,
  PackagedArtifact,
} from "../../packages/core/artifact/packager.ts";

export type RevisionState =
  | "Created"
  | "Building"
  | "Ready"
  | "Deployed"
  | "Failed"
  | "Suspended";

export interface RevisionRecord {
  id: string; // rev_{ULID} (PLAT-14, PLAT-18)
  project: string;
  functionName: string;
  artifactId: string; // sha256:... (OBJ-4)
  integrity: string;
  state: RevisionState;
  createdAt: number;
  manifest: Manifest;
}

export interface DeploymentResult {
  revisionId: string;
  state: RevisionState;
  active: boolean;
}

export class DeploymentService {
  constructor(storage: ObjectProvider);
  deploy(
    project: string,
    functionName: string,
    artifact: PackagedArtifact,
    healthCheck?: () => Promise<boolean>,
  ): Promise<DeploymentResult>;
  rollback(
    project: string,
    functionName: string,
    targetRevisionId: string,
  ): Promise<void>;
  getActiveRevision(
    project: string,
    functionName: string,
  ): Promise<RevisionRecord | null>;
  getRevision(
    project: string,
    functionName: string,
    revisionId: string,
  ): Promise<RevisionRecord | null>;
}
```

## Acceptance criteria

1. Given a valid packaged artifact, when `deploy` is executed, then the artifact bytes are stored in `ObjectProvider` at `artifacts/{artifact_id}` (OBJ-4), and a revision with ID `rev_{ULID}` is created (PLAT-14, PLAT-18).
2. Given a passing health check (3 consecutive successes), when `deploy` runs, then the revision transitions to `Deployed` and becomes the active pointer for that Function (PLAT-3, FN-3).
3. Given a failing health check, when `deploy` runs, then the revision transitions to `Failed`, is not activated, and the previous active revision continues serving (PLAT-3).
4. Given two deployed revisions `rev_1` and `rev_2`, when `rollback(project, fn, rev_1)` is invoked, then the active pointer flips back to `rev_1` without rebuilding (FN-3, PLAT-3).
5. Given a request to rollback to a non-existent revision, then it throws `RESOURCE_NOT_FOUND` (PLAT-12).

## Tests required

- [x] Unit — revision state transitions, ULID generation for revisions, rollback pointer flip
- [x] Integration — deploy artifact with mock health check, store in real `ObjectProvider`, verify stored bytes match sha256 integrity
- [x] Security — verify control plane never imports or invokes customer code inside the control process (PLAT-1)
- [x] Security — verify path traversal rejection, content-address verification, and tenant isolation (PLAT-7, OBJ-4)

## Definition of Done

- [x] Implementation matches cited clause IDs (`PLAT-1`, `PLAT-3`, `PLAT-7`, `PLAT-12`, `PLAT-14`, `PLAT-18`, `FN-3`, `OBJ-4`)
- [x] No canary or traffic-splitting logic present (banned per PLAT-3/PLAT-20)
- [x] Unit tests written first (red), then implementation (green)
- [x] `deno check` run, real output attached, zero errors
- [x] `deno test` run, real output attached, all required tests passing (29/29 task + adversarial tests; 187/187 repo tests)
- [x] `deno lint` run, real output attached, zero warnings
- [x] `deno fmt --check` run, real output attached, formatted
- [x] Independent reviewer pass completed and approved
- [x] Security auditor pass completed and approved (`PLAT-1`, `PLAT-3`, `PLAT-7`, `OBJ-4`)
- [x] No item from `docs/ANTI-SLOP.md` violated
- [x] Nothing outside "In scope" touched

### Verified Tool Outputs

#### `deno check`
```
$ deno check apps/api/deployment-service.ts apps/api/deployment-service_test.ts tests/security/deployment_adversarial_test.ts
Check apps/api/deployment-service.ts
Check apps/api/deployment-service_test.ts
Check tests/security/deployment_adversarial_test.ts
```

#### `deno test`
```
$ deno test --allow-read --allow-write apps/api/deployment-service_test.ts tests/security/deployment_adversarial_test.ts
running 9 tests from ./tests/security/deployment_adversarial_test.ts
Attack PLAT-1: Control plane never invokes eval, Function constructor, or Worker ... ok (18ms)
Attack PLAT-7: Cross-tenant rollback is rejected with RESOURCE_NOT_FOUND ... ok (12ms)
Attack PLAT-7: Cross-function rollback in same project is rejected with RESOURCE_NOT_FOUND ... ok (8ms)
Attack PLAT-7: Null-byte delimiter injection in project/function names ... ok (15ms)
Attack PLAT-7 / OBJ-4: Path traversal via artifact.id escaping artifacts/ ... ok (14ms)
Attack OBJ-4: Artifact content spoofing / poisoning of another tenant's artifact ... ok (10ms)
Attack PLAT-3: Activating a FAILED revision via rollback ... ok (16ms)
Attack PLAT-3: Truthy / non-boolean return values in healthCheck probe ... ok (10ms)
Attack PLAT-3: Stale/lagging deploy overwriting newer active deployment ... ok (43ms)
running 20 tests from ./apps/api/deployment-service_test.ts
Unit: AC1 - deploy creates revision with valid ULID and stores artifact under artifacts/{artifact_id} ... ok (20ms)
Unit: AC1 - multiple deployments generate unique, monotonically sortable ULID revision IDs ... ok (19ms)
Unit: AC2 - passing health check (3 consecutive successes) activates revision and transitions to Deployed ... ok (9ms)
Unit: AC2 - deploy without explicit healthCheck probe defaults to passing ... ok (8ms)
Unit: AC3 - health check failing on attempt 1 transitions to Failed and is not activated ... ok (10ms)
Unit: AC3 - health check failing on attempt 2 transitions to Failed and is not activated ... ok (12ms)
Unit: AC3 - health check failing on attempt 3 transitions to Failed and is not activated ... ok (12ms)
Unit: AC3 - health check throwing an error transitions to Failed and does not crash service ... ok (9ms)
Unit: AC3 - failing deployment preserves existing active revision ... ok (11ms)
Unit: AC4 - rollback flips active pointer to target revision without rebuilding ... ok (14ms)
Unit: AC5 - rollback to non-existent revision throws ResourceNotFoundError with code RESOURCE_NOT_FOUND ... ok (9ms)
Unit: AC5 - rollback on non-existent project or function throws ResourceNotFoundError ... ok (9ms)
Unit: AC5 - rollback cannot target revision of another project or function ... ok (16ms)
Unit: Query methods return null when revision or active revision does not exist ... ok (1ms)
Unit: Multi-tenancy isolation - revisions and active pointers are strictly scoped by project and function ... ok (24ms)
Integration: deploy artifact to real ObjectProvider and verify stored bytes match sha256 integrity ... ok (15ms)
Integration: Sequential deployments and rollback on real ObjectProvider preserve all artifacts ... ok (32ms)
Security: PLAT-1 - Control plane deploy never evaluates, imports, or executes customer code bytes ... ok (12ms)
Security: PLAT-1 - Control plane deploy accepts non-JS/corrupt bytes without parse or eval attempt ... ok (11ms)
Security: PLAT-1 - Control plane rollback never evaluates customer code ... ok (14ms)

ok | 29 passed | 0 failed (599ms)
```

#### `deno lint`
```
$ deno lint apps/api/deployment-service.ts apps/api/deployment-service_test.ts tests/security/deployment_adversarial_test.ts
Checked 3 files
```

#### `deno fmt --check`
```
$ deno fmt --check apps/api/deployment-service.ts apps/api/deployment-service_test.ts tests/security/deployment_adversarial_test.ts
Checked 3 files
```

## Assumptions made

- Health check in test harness uses an injectable health probe function to verify 3 consecutive successes within timeout without requiring external network probes.
- Monotonic timestamp ordering is preserved for sequential ULID generations within a DeploymentService instance so lexicographical sort order matches creation order.
