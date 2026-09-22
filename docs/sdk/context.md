# SDK — Context & Capability Bindings (`FN-4`)

> [!NOTE]
> **Documentation**: [Docs Home](../README.md) &nbsp;|&nbsp;
> **Specification**: [FN-4 (RailFogContext), PLAT-6 (Capability Injection)](../contracts/platform.contract.md) &nbsp;|&nbsp;
> **Lifecycle**: Fresh instance generated per invocation

Every function invocation in RailFog receives a `RailFogContext` (`ctx`) instance carrying invocation metadata and capability bindings scoped to the declarations in `railfog.toml`.

---

## 1. Context Interface

```typescript
export interface RailFogContext {
  /** Unique ULID identifying this invocation across logs and storage (PLAT-14) */
  readonly requestId: string;
  /** Declared project identifier (PLAT-18) */
  readonly project: string;
  /** Name of the executing function (FN-1) */
  readonly function: string;
  /** Active deployment revision identifier (PLAT-3) */
  readonly revision: string;
  /** Epoch millisecond timestamp of the hard kill deadline (FN-5) */
  readonly deadline: number;
  /** Returns remaining wall-clock milliseconds before hard kill */
  timeRemaining(): number;

  /** Capability-scoped Key-Value storage (KV-2) */
  readonly kv: KVBinding;
  /** Capability-scoped Object storage (OBJ-2) */
  readonly objects: ObjectBinding;
  /** Capability-scoped Queue sender (Q-2) */
  readonly queues: QueueBinding;
  /** Capability-scoped encrypted secrets (PLAT-15) */
  readonly env: EnvBinding;
}
```

---

## 2. Using Injected Capabilities

```typescript
import type { FunctionHandler } from "@railfog/sdk";

const handler: FunctionHandler = async (req, ctx) => {
  // 1. Invocation metadata
  console.log(`[${ctx.requestId}] Invoking ${ctx.function} on ${ctx.project}`);

  // 2. Budget and deadline management (FN-4, FN-5)
  if (ctx.timeRemaining() < 50) {
    return Response.json({ error: "Execution budget exhausted" }, { status: 504 });
  }

  // 3. Capability-scoped storage operations
  const session = await ctx.kv.get(["sessions", "user_1"]);
  const presigned = await ctx.objects.presign("avatar.png", { method: "PUT" });
  await ctx.queues.send({ task: "sync", userId: "user_1" });

  // 4. Capability-scoped secrets (PLAT-15)
  const stripeKey = ctx.env.require("STRIPE_SECRET_KEY");

  return Response.json({ status: "ok", uploadUrl: presigned.url });
};

export default handler;
```

---

## Next Steps

- Learn about [Reliability Helpers](reliability.md).
- Review [Platform Error Codes](errors.md).
