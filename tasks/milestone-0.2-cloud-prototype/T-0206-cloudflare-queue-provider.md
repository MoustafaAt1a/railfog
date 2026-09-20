# T-0206 — Cloudflare Queues remote provider

Status: Done
Milestone: 0.2 Cloud Prototype
Depends on: T-0102, T-0106
Blocks: T-0209, T-0211

## Spec references

`Q-1` `Q-2` `Q-3` `PLAT-12` `PLAT-15` `PLAT-16` `PLAT-17`

## Scope

**In scope:**
- `providers/queues/cloudflare-queue-provider.ts`: implement `QueueProvider` interface (`primitives/queues/queue-provider.ts`) for Cloudflare Queues / remote queue HTTP endpoints.
- Methods: `send`, `sendBatch`, `receive`, `ack`.
- Max message size: 128 KB per `docs/contracts/queues.contract.md` Q-2 (throw `PAYLOAD_TOO_LARGE` if exceeded).
- Delay support on `send`: up to 900 seconds per Q-2 (throw `VALIDATION_FAILED` if `delay > 900`).
- Visibility timeout tracking per Q-3: default 30,000 ms.
- Attempts counter tracking per Q-3.
- Pre-redaction of secrets before parsing JSON or formatting errors (PLAT-15).

**Out of scope:**
- Queue consumer invocation dispatch loop (handled by `QueueConsumerWorker` in T-0209).
- Application idempotency handling (handled at Function level per Q-4).
- Automatic jittered backoff or circuit breaker library code (Milestone 0.4).

## Interface to implement

```typescript
import type {
  QueueMessage,
  QueueProvider,
} from "../../primitives/queues/queue-provider.ts";

export interface CloudflareQueueProviderOptions {
  accountId: string;
  queueId: string;
  apiToken: string;
  baseUrl?: string; // allows local HTTP mock testing
  defaultVisibilityTimeoutMs?: number; // default 30000 (Q-3)
}

export class CloudflareQueueProvider implements QueueProvider {
  constructor(options: CloudflareQueueProviderOptions);
  send(body: unknown, opts?: { delay?: number }): Promise<{ id: string }>;
  sendBatch(bodies: unknown[]): Promise<{ id: string }[]>;
  receive(
    opts?: { visibilityTimeoutMs?: number },
  ): Promise<QueueMessage | null>;
  ack(id: string): Promise<void>;
}
```

## Acceptance criteria

1. Given a configured `CloudflareQueueProvider`, when `send` is called with valid payload, then it transmits the message and returns `{ id }` (Q-2).
2. Given a payload exceeding 128 KB, when `send` is called, then it throws `PAYLOAD_TOO_LARGE` (Q-2, PLAT-12).
3. Given `delay` greater than 900 seconds, when `send` is called, then it throws `VALIDATION_FAILED` pointing to Q-2.
4. Given a batch of messages, when `sendBatch` is called, then it transmits them and returns an array of generated `{ id }` items.
5. Given a message received, when `ack` is called on its id, then the message is marked acknowledged and never re-received (Q-3).
6. Given an unacknowledged message exceeding its visibility timeout, when `receive` is invoked again, then the message is redelivered with incremented `attempts` (Q-3).

## Tests required

- [x] Unit — payload size threshold checking (128 KB), delay bounds check (900s), options defaults
- [x] Integration — send, sendBatch, receive with visibility timeout, and ack against an in-process mock HTTP queue server
- [x] Security — verify authorization tokens are scrubbed from outgoing exception messages, syntax errors, and inspections (PLAT-15)

## Definition of Done

- [x] Implementation matches cited clause IDs (`Q-1`, `Q-2`, `Q-3`, `PLAT-12`, `PLAT-15`, `PLAT-16`, `PLAT-17`)
- [x] Spec-anchor comments present at delay and size validation sites
- [x] Unit tests written first (red), then implementation (green)
- [x] `deno check` run, real output attached, zero errors
- [x] `deno test` run, real output attached, all required tests passing (19/19 task + adversarial tests; 158/158 repo tests)
- [x] `deno lint` run, real output attached, zero warnings
- [x] `deno fmt --check` run, real output attached, zero formatting errors
- [x] No item from `docs/ANTI-SLOP.md` violated
- [x] Nothing outside "In scope" touched
- [x] Reviewer pass completed and approved
- [x] Security auditor pass completed and approved (`PLAT-15`, `Q-2`, `Q-3`)

### Verified Tool Outputs

#### `deno check`
```
$ deno check providers/queues/cloudflare-queue-provider.ts providers/queues/cloudflare-queue-provider_test.ts tests/security/cloudflare_queue_adversarial_test.ts
Check providers/queues/cloudflare-queue-provider.ts
Check providers/queues/cloudflare-queue-provider_test.ts
Check tests/security/cloudflare_queue_adversarial_test.ts
```

#### `deno test`
```
$ deno test --allow-net providers/queues/cloudflare-queue-provider_test.ts tests/security/cloudflare_queue_adversarial_test.ts
running 11 tests from ./providers/queues/cloudflare-queue-provider_test.ts
CloudflareQueueProvider - unit: delay bounds validation rejects > 900s, < 0, and NaN (Q-2, AC3) ... ok (1ms)
CloudflareQueueProvider - unit: payload size validation rejects > 128 KB (Q-2, PLAT-12, AC2) ... ok (2ms)
CloudflareQueueProvider - unit: options defaults and required parameters validation ... ok (606µs)
CloudflareQueueProvider - integration: send transmits POST to queue messages endpoint with headers and returns { id } (Q-2, AC1) ... ok (361ms)
CloudflareQueueProvider - integration: sendBatch transmits batch to /messages/batch and returns { id }[] (Q-2, AC4) ... ok (315ms)
CloudflareQueueProvider - integration: receive returns message or null, and ack acknowledges message (Q-3, AC5) ... ok (316ms)
CloudflareQueueProvider - integration: visibility timeout and redelivery with incremented attempts counter (Q-3, AC6) ... ok (748ms)
CloudflareQueueProvider - integration: default visibility timeout 30,000 ms propagated in pull request (Q-3, AC6) ... ok (315ms)
CloudflareQueueProvider - security: apiToken is scrubbed from error messages and stack traces (PLAT-15) ... ok (322ms)
CloudflareQueueProvider - security: naive object inspection via Deno.inspect/JSON.stringify redacts apiToken (PLAT-15) ... ok (762µs)
CloudflareQueueProvider - security: malformed JSON response is redacted and mapped to InternalError (PLAT-15, PLAT-12) ... ok (306ms)
running 8 tests from ./tests/security/cloudflare_queue_adversarial_test.ts
Adversarial PLAT-15: upstream 4xx/5xx responses echoing apiToken are thoroughly redacted from message and stack across all methods ... ok (336ms)
Adversarial PLAT-15: malformed JSON response embedding apiToken is scrubbed from syntax error and stack ... ok (308ms)
Adversarial PLAT-15: network connection failure does not leak apiToken in message or stack ... ok (8s)
Adversarial PLAT-15: naive inspection, reflection, and JSON serialization never leak apiToken ... ok (482µs)
Adversarial PLAT-15: tokens with regex metacharacters are safely redacted without crashing ... ok (315ms)
Adversarial Q-2: payloads > 128 KB, circular payloads, and invalid delays are rejected before any network traffic ... ok (66ms)
Adversarial Q-3: invalid visibilityTimeoutMs and defaultVisibilityTimeoutMs are rejected before network traffic ... ok (1ms)
Adversarial Q-3: state machine enforces message invisibility, redelivery with attempts counter, and ack permanence ... ok (669ms)

ok | 19 passed | 0 failed (12s)
```

#### `deno lint`
```
$ deno lint providers/queues/cloudflare-queue-provider.ts providers/queues/cloudflare-queue-provider_test.ts tests/security/cloudflare_queue_adversarial_test.ts
Checked 3 files
```

#### `deno fmt --check`
```
$ deno fmt --check providers/queues/cloudflare-queue-provider.ts providers/queues/cloudflare-queue-provider_test.ts tests/security/cloudflare_queue_adversarial_test.ts
Checked 3 files
```

## Assumptions made

Local tests run against an in-memory HTTP mock server simulating Cloudflare Queue REST endpoints, preserving test speed and independence from external network dependencies per PLAT-17.
