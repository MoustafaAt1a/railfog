---
name: provider-abstraction-pattern
description: Use when implementing or reviewing any *Provider interface or adapter (KVProvider, ObjectProvider, QueueProvider, ComputeProvider, IsolationProvider). Enforces DIP/ISP/LSP so providers stay genuinely swappable.
---

# Provider Abstraction Pattern

The four provider interfaces are fixed by
`docs/contracts/platform.contract.md` PLAT-16:

```typescript
interface KVProvider      { get; set; delete; list; }
interface ObjectProvider  { put; get; delete; head; list; presign; createMultipartUpload; }
interface QueueProvider   { send; sendBatch; receive; ack; }
interface ComputeProvider { run(artifact, limits): Promise<Result>; }
```

Plus `IsolationProvider` (`platform.contract.md` PLAT-4).

## Rules for every adapter you write

1. **Dependency direction (DIP).** The interface lives in `primitives/` or
   `runtime/`; the adapter lives in `providers/`. Nothing outside
   `providers/` imports a concrete adapter directly — only the interface.
   Wiring happens once, at composition time (CLI/config load).

2. **No fat interface (ISP).** Don't add a method to a provider interface
   that only one implementation needs. If local dev genuinely needs
   something production doesn't (or vice versa), that's a sign that
   behavior doesn't belong on the interface at all.

3. **Substitutability (LSP) — the one most likely to be gotten wrong.**
   Every implementation of an interface must deliver the *exact* guarantee
   the interface's contract clause states, not an approximation:
   - A `KVProvider` claiming the `strong` tier must actually support CAS
     linearizably (`docs/contracts/kv.contract.md` KV-5). This is the exact
     bug the LTS audit found in the original draft (Workers KV claimed as
     `strong`-capable when it's eventually consistent) — verify every new
     provider against KV-5 before trusting a `strong` claim.
   - A `QueueProvider` must implement the full redelivery state machine
     (`docs/contracts/queues.contract.md` Q-3), not a simplified version that
     merely enqueues/dequeues.
   - An `ObjectProvider` must support direct client↔storage transfer
     semantics for `presign` (`docs/contracts/objects.contract.md` OBJ-3),
     not silently proxy bytes through itself.

4. **Local/production parity (`platform.contract.md` PLAT-17).** Application
   code that calls a provider through its interface must behave identically
   regardless of which implementation is wired in. If a caller needs to
   check which provider it's talking to, the abstraction has already failed.

## Review question

For any new or modified provider: "if I swapped this for another
implementation of the same interface, would any caller need to change?" If
yes, find out why and fix the interface or the caller, not just the adapter.
