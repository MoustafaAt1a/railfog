# Glossary — Canonical Nouns

Use these words, and only these words, for these concepts. Two models
generating code in the same repo will drift in naming unless both are pinned
to the same list. If a concept below has a spelling variant elsewhere in
either uploaded spec file, this list wins (the LTS file's usage matches this
list already).

| Term | Definition |
|---|---|
| **Project** | The unit that owns Functions, KV namespaces, Object stores, and Queues. Belongs to one Organization. |
| **Organization** | The top-level tenant boundary. Owns Projects and Identities. |
| **Function** | The compute primitive. Versioned, isolated, receives `Request` + `RailFogContext`, returns `Response`. |
| **Revision** | One immutable, deployed version of a Function. Traffic points at exactly one Revision per Function. |
| **Deployment** | The act of producing a new Revision via the pipeline in `docs/contracts/platform.contract.md` PLAT-3. |
| **KV** | The small-state primitive. Never called "the database" or "cache" in code or docs — it is KV. |
| **Object** | The large-binary-data primitive. Never called "blob storage" or "files" in code identifiers — it is Object/Objects. |
| **Queue** | The async-work primitive. |
| **Trigger** | What causes a Function to run: HTTP, Queue, Schedule, or Webhook. Never a separate primitive. |
| **Context (`ctx` / `RailFogContext`)** | The one RailFog-specific object injected into a Function: `kv`, `objects`, `queues`, `env`, `requestId`, `deadline`, `timeRemaining()`. |
| **Provider** | A swappable backend implementation of `KVProvider` / `ObjectProvider` / `QueueProvider` / `ComputeProvider`. Application code depends on the interface, never the provider name. |
| **Isolation boundary** | The layer between untrusted Function code and the host (OS sandbox + microVM), abstracted behind `IsolationProvider`. |
| **Capability injection** | The permission model: bindings are resolved once at deploy time into pre-scoped client objects; there is no runtime ACL check. |
| **Control plane** | Owns identity, projects, deployments, permission config, routing config. Never executes customer code. |
| **Data plane** | Serves every live request. Fail-static with respect to the control plane (`docs/contracts/platform.contract.md` PLAT-8). |
| **Artifact** | The content-addressed, immutable build output of a Deployment. |
| **`rail`** | The CLI. Never "railfog-cli" or "the CLI tool" in identifiers. |
| **`railfog.toml`** | The one project configuration file. |
| **Request ID** | A ULID, propagated Gateway → Control → Runtime → Storage → Logs unchanged. |

Do not introduce a new noun for a concept already on this list. If a genuinely
new concept appears, add it here in the same task that introduces it — don't
let it live undocumented.
