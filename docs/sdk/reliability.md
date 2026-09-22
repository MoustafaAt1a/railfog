# SDK — Reliability Helpers

> [!NOTE]
> **Documentation**: [Docs Home](../README.md) &nbsp;|&nbsp; **Specification**:
> [Q-4 (Idempotency), Q-5 (Backoff Jitter)](../contracts/queues.contract.md)
> &nbsp;|&nbsp; **Philosophy**: Built over KV as zero-overhead library code

RailFog provides reliability helpers as standard library utilities built over KV
storage, avoiding redundant platform primitives.

---

## 1. Idempotent Execution (`withIdempotency`)

Under at-least-once message delivery (`Q-1`), duplicate deliveries can occur due
to network retries. `withIdempotency` ensures business operations execute
exactly once within the retention window:

```typescript
import { withIdempotency } from "@railfog/sdk";
import type { KVBinding } from "@railfog/sdk";

export async function processPayment(
  kv: KVBinding,
  paymentId: string,
): Promise<{ status: string }> {
  const dedupeKey = ["processed_payments", paymentId];

  const { processed, result } = await withIdempotency(
    kv,
    dedupeKey,
    async () => {
      // Business logic runs exactly once per paymentId
      return { status: "settled" };
    },
    { ttlSeconds: 14 * 24 * 3600 }, // Mandatory 14-day retention TTL (Q-4)
  );

  return result;
}
```

> [!IMPORTANT]
> The TTL parameter is mandatory and matches the 14-day queue retention period
> (`Q-4`). Omission of TTL is strictly prohibited to prevent permanent database
> growth.

---

## 2. Exponential Backoff with Decorrelated Jitter (`withRetry`)

When calling external APIs or microservices, naive linear retries can trigger
the "thundering herd" problem and collapse downstream services.

`withRetry` implements exponential backoff with decorrelated jitter (`Q-5`):

$$t_{\text{sleep}} = \min(\text{cap}, \text{random\_uniform}(\text{base}, t_{\text{prev}} \times 3))$$

```typescript
import { withRetry } from "@railfog/sdk";

export async function callExternalService(): Promise<Response> {
  return await withRetry(
    async () => {
      const res = await fetch("https://api.partner.com/webhook");
      if (!res.ok && res.status >= 500) {
        throw new Error(`Partner returned HTTP ${res.status}`);
      }
      return res;
    },
    {
      maxAttempts: 5,
      baseMs: 100,
      capMs: 20000,
    },
  );
}
```

- **Parameters**: `maxAttempts = 5`, `baseMs = 100`, `capMs = 20000`.
- **Error Propagation**: When retry attempts are exhausted, the original error
  is preserved and rethrown unchanged (`PLAT-12`).

---

## Next Steps

- Explore the [Platform Error Taxonomy](errors.md).
- Learn about the [CLI Commands](../../cli/commands.md).
