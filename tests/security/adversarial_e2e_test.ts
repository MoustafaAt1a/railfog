/**
 * Comprehensive Security and Adversarial End-to-End Test Suite (Task T-0313).
 *
 * Validates the defense-in-depth guarantees of Milestone 0.3 across all 6 adversarial
 * attack vectors and under both LocalIsolationProvider and ProcessIsolationProvider.
 *
 * Spec references:
 * - docs/contracts/platform.contract.md#PLAT-4: Isolation, defense in depth (OS sandbox & subprocess boundary)
 * - docs/contracts/platform.contract.md#PLAT-5: Network policy (mandatory egress constraint, SSRF mitigation, connect-time IP blocker)
 * - docs/contracts/platform.contract.md#PLAT-6: Capability injection (the permission model, inexpressible out-of-scope resources)
 * - docs/contracts/platform.contract.md#PLAT-7: Multi-tenancy & data isolation ({org_id}/{project_id}/{resource_name}/{caller_key})
 * - docs/contracts/platform.contract.md#PLAT-9: Rate limiting: token bucket algorithm and Retry-After
 * - docs/contracts/platform.contract.md#PLAT-12: Error model (machine-readable codes, status mappings)
 * - docs/contracts/platform.contract.md#PLAT-13: Observability & structured logs (secrets auto-redacted)
 * - docs/contracts/platform.contract.md#PLAT-14: ULID format for request_id (26 chars Crockford Base32)
 * - docs/contracts/platform.contract.md#PLAT-15: Secrets (runtime access capability-scoped, rotation without redeploy, redaction)
 * - docs/contracts/functions.contract.md#FN-4: RailFogContext structure
 * - docs/contracts/functions.contract.md#FN-5: Resource limits (timeout_ms, cpu_ms, kv 1,000 ops, objects 100 ops, queues 100 ops, payload limits)
 * - docs/contracts/functions.contract.md#FN-6: Isolation & warm-reuse rule (reuse ONLY within same {project, function, revision}; fresh bindings)
 * - docs/contracts/functions.contract.md#FN-7: Call-depth guard (X-RailFog-Call-Depth propagation & recursion abort)
 * - docs/adr/0001-isolation-provider-invocation-protocol.md: ADR-0001 (stdio JSON-RPC IPC)
 */

import {
  assert,
  assertEquals,
  assertFalse,
  assertNotEquals,
  assertRejects,
  assertThrows,
} from "@std/assert";

import { LocalIsolationProvider } from "../../runtime/sandbox/local-isolation.ts";
import { ProcessIsolationProvider } from "../../runtime/sandbox/process-isolation.ts";
import { EgressIpBlocker } from "../../runtime/sandbox/egress-ip-blocker.ts";
import { EgressProxy } from "../../runtime/sandbox/egress-proxy.ts";
import {
  createGuardedKVProvider,
  createGuardedObjectProvider,
  createGuardedQueueProvider,
  type TenantContext,
} from "../../providers/guard/tenant-guard.ts";
import { SQLiteKVProvider } from "../../providers/kv/sqlite-provider.ts";
import { LocalFSProvider } from "../../providers/objects/local-fs-provider.ts";
import { SQLiteQueueProvider } from "../../providers/queues/sqlite-queue-provider.ts";
import {
  LocalEncryptedSecretStore,
  type SecretStore,
} from "../../packages/policy/secret-store.ts";
import { SecretInjector } from "../../runtime/loader/secret-injector.ts";
import {
  REDACTED_MARKER,
  SecretRedactor,
} from "../../packages/logging/secret-redactor.ts";
import {
  formatRateLimitRejection,
  TokenBucketLimiter,
} from "../../packages/policy/rate-limiter.ts";
import {
  CALL_DEPTH_HEADER,
  createInvocationTracker,
} from "../../runtime/limits/operation-counter.ts";
import { createKillEnforcer } from "../../runtime/limits/kill-enforcer.ts";
import { generateUlid, isValidUlid } from "../../packages/core/id/ulid.ts";
import {
  CallDepthExceededError,
  PayloadTooLargeError,
  PermissionDeniedError,
  RateLimitedError,
} from "../../packages/errors/mod.ts";
import type {
  Artifact,
  InvocationRequest,
} from "../../primitives/compute/compute-provider.ts";

// ============================================================================
// Helper Fixtures & Types
// ============================================================================

const TENANT_ALPHA: TenantContext = Object.freeze({
  orgId: "org-alpha",
  projectId: "proj-alpha",
});

const TENANT_BETA: TenantContext = Object.freeze({
  orgId: "org-beta",
  projectId: "proj-beta",
});

function createInMemorySecretStore(
  masterKey = "railfog-master-test-key-32-chars!",
): SecretStore {
  return new LocalEncryptedSecretStore({ masterKey });
}

function createTestArtifact(
  entrypoint: string,
  codeString: string,
  extra?: Record<string, unknown>,
): Artifact & Record<string, unknown> {
  const code = new TextEncoder().encode(codeString);
  return {
    id: `sha256:${entrypoint.replace(/[^a-zA-Z0-9]/g, "")}`,
    integrity: `sha256-${entrypoint.replace(/[^a-zA-Z0-9]/g, "")}`,
    entrypoint,
    code,
    ...extra,
  };
}

function createTestInvocation(
  headers?: Record<string, string>,
  extra?: Partial<InvocationRequest>,
): InvocationRequest {
  return {
    requestId: extra?.requestId ?? generateUlid(),
    method: extra?.method ?? "GET",
    url: extra?.url ?? "https://example.com/api",
    headers,
    ...extra,
  };
}

// ============================================================================
// VECTOR 1: Cross-Tenant Data Isolation (PLAT-6, PLAT-7)
// ============================================================================

Deno.test(
  "Vector 1 (PLAT-7, KV-2): Guarded KV rejects key prefix spoofing attempting to access another tenant's keys",
  async () => {
    // spec: contracts/platform.contract.md#PLAT-7 — physical prefix boundary
    const rawKv = new SQLiteKVProvider(":memory:");
    const guardedKvAlpha = createGuardedKVProvider(rawKv, TENANT_ALPHA);
    const guardedKvBeta = createGuardedKVProvider(rawKv, TENANT_BETA);

    // Populate Tenant Beta key directly in backing store
    await rawKv.set(
      ["org-beta", "proj-beta", "secrets", "apikey"],
      "beta-secret-token",
    );

    // Tenant Beta can read its own key legitimately
    assertEquals(
      await guardedKvBeta.get(["org-beta", "proj-beta", "secrets", "apikey"]),
      "beta-secret-token",
    );

    // Attacker under Tenant Alpha attempts to read Tenant Beta key
    await assertRejects(
      async () => {
        await guardedKvAlpha.get([
          "org-beta",
          "proj-beta",
          "secrets",
          "apikey",
        ]);
      },
      PermissionDeniedError,
      "Cross-tenant KV access denied: key does not match tenant prefix",
    );

    // Attacker under Tenant Alpha attempts to overwrite Tenant Beta key
    await assertRejects(
      async () => {
        await guardedKvAlpha.set(
          ["org-beta", "proj-beta", "secrets", "apikey"],
          "pwned-by-alpha",
        );
      },
      PermissionDeniedError,
      "Cross-tenant KV access denied",
    );

    // Attacker under Tenant Alpha attempts to delete Tenant Beta key
    await assertRejects(
      async () => {
        await guardedKvAlpha.delete([
          "org-beta",
          "proj-beta",
          "secrets",
          "apikey",
        ]);
      },
      PermissionDeniedError,
      "Cross-tenant KV access denied",
    );

    // Verify Tenant Beta data remained intact and uncorrupted
    assertEquals(
      await rawKv.get(["org-beta", "proj-beta", "secrets", "apikey"]),
      "beta-secret-token",
    );
  },
);

Deno.test(
  "Vector 1 (PLAT-7, KV-2): Guarded KV rejects path traversal escapes (../, ..\\, %2e%2e, null bytes, empty segments)",
  async () => {
    // spec: contracts/platform.contract.md#PLAT-7 — path traversal prevention
    const rawKv = new SQLiteKVProvider(":memory:");
    const guardedKv = createGuardedKVProvider(rawKv, TENANT_ALPHA);

    const maliciousKeys = [
      ["org-alpha", "proj-alpha", "..", "proj-beta", "secrets"],
      ["org-alpha", "proj-alpha", "..\\", "proj-beta", "secrets"],
      ["org-alpha", "proj-alpha", "%2e%2e", "proj-beta", "secrets"],
      ["org-alpha", "proj-alpha", "user\0admin", "token"],
      ["org-alpha", "proj-alpha", "", "token"],
      ["org-alpha", "proj-alpha", "valid", "/escaped"],
      ["org-alpha", "proj-alpha", "valid", "\\escaped"],
    ];

    for (const badKey of maliciousKeys) {
      await assertRejects(
        async () => {
          await guardedKv.get(badKey);
        },
        PermissionDeniedError,
      );
      await assertRejects(
        async () => {
          await guardedKv.set(badKey, "evil-val");
        },
        PermissionDeniedError,
      );
      await assertRejects(
        async () => {
          await guardedKv.delete(badKey);
        },
        PermissionDeniedError,
      );
    }
  },
);

Deno.test(
  "Vector 1 (PLAT-7, KV-2): Guarded KV list prevents cross-tenant scanning and prefix escape",
  async () => {
    // spec: contracts/platform.contract.md#PLAT-7 — list prefix validation
    const rawKv = new SQLiteKVProvider(":memory:");
    const guardedKv = createGuardedKVProvider(rawKv, TENANT_ALPHA);

    // Attempting to list with Tenant Beta prefix
    await assertRejects(
      async () => {
        await guardedKv.list(["org-beta", "proj-beta"]);
      },
      PermissionDeniedError,
      "Cross-tenant KV list denied: prefix does not match tenant prefix",
    );

    // Attempting to list root or org-level scope to scan all tenants
    await assertRejects(
      async () => {
        await guardedKv.list(["org-alpha"]);
      },
      PermissionDeniedError,
      "KV list prefix must specify at least [orgId, projectId]",
    );

    // Attempting traversal inside prefix
    await assertRejects(
      async () => {
        await guardedKv.list(["org-alpha", "proj-alpha", ".."]);
      },
      PermissionDeniedError,
    );
  },
);

Deno.test(
  "Vector 1 (PLAT-7, KV-2): Guarded KV atomic builder rejects cross-tenant check, set, and delete operations",
  () => {
    // spec: contracts/platform.contract.md#PLAT-7 — atomic builder tenant enforcement
    const rawKv = new SQLiteKVProvider(":memory:");
    const guardedKv = createGuardedKVProvider(rawKv, TENANT_ALPHA);

    const atomic = guardedKv.atomic();

    assertThrows(
      () => {
        atomic.check(["org-beta", "proj-beta", "account", "balance"], 1);
      },
      PermissionDeniedError,
      "Cross-tenant KV access denied",
    );

    assertThrows(
      () => {
        atomic.set(["org-beta", "proj-beta", "account", "balance"], 999999);
      },
      PermissionDeniedError,
      "Cross-tenant KV access denied",
    );

    assertThrows(
      () => {
        atomic.delete(["org-beta", "proj-beta", "account", "balance"]);
      },
      PermissionDeniedError,
      "Cross-tenant KV access denied",
    );
  },
);

Deno.test(
  "Vector 1 (PLAT-7, OBJ-2): Guarded Object storage rejects prefix spoofing, path traversal, and empty segments",
  async () => {
    // spec: contracts/platform.contract.md#PLAT-7 — physical_key = {org_id}/{project_id}/{resource_name}/{caller_key}
    const tempDir = Deno.makeTempDirSync({ prefix: "railfog_test_obj_" });
    try {
      const rawStorage = new LocalFSProvider(tempDir);
      const guardedStorage = createGuardedObjectProvider(
        rawStorage,
        TENANT_ALPHA,
      );

      // 1. Prefix spoofing: Tenant Alpha attempts to write to Tenant Beta's namespace
      await assertRejects(
        async () => {
          await guardedStorage.put(
            "org-beta/proj-beta/uploads/avatar.png",
            new TextEncoder().encode("malicious avatar").buffer,
          );
        },
        PermissionDeniedError,
        "Cross-tenant object access denied",
      );

      // 2. Path traversal sequences attempting directory escape
      const traversalKeys = [
        "org-alpha/proj-alpha/../proj-beta/uploads/secret.txt",
        "org-alpha/proj-alpha/..\\proj-beta/uploads/secret.txt",
        "org-alpha/proj-alpha/%2e%2e/proj-beta/uploads/secret.txt",
        "org-alpha/proj-alpha/valid/../../etc/passwd",
        "org-alpha/proj-alpha/null\0byte.txt",
        "org-alpha/proj-alpha//empty_leading_slash.txt",
        "org-alpha/proj-alpha/", // Empty remainder after prefix
      ];

      for (const badKey of traversalKeys) {
        await assertRejects(
          async () => {
            await guardedStorage.get(badKey);
          },
          PermissionDeniedError,
        );
        await assertRejects(
          async () => {
            await guardedStorage.delete(badKey);
          },
          PermissionDeniedError,
        );
        await assertRejects(
          async () => {
            await guardedStorage.head(badKey);
          },
          PermissionDeniedError,
        );
        await assertRejects(
          async () => {
            await guardedStorage.presign(badKey, { method: "GET" });
          },
          PermissionDeniedError,
        );
      }

      // 3. Object list prefix traversal and cross-tenant scan
      await assertRejects(
        async () => {
          await guardedStorage.list("org-beta/proj-beta/");
        },
        PermissionDeniedError,
        "Cross-tenant object list denied",
      );
      await assertRejects(
        async () => {
          await guardedStorage.list("org-alpha/proj-alpha/../");
        },
        PermissionDeniedError,
      );
    } finally {
      Deno.removeSync(tempDir, { recursive: true });
    }
  },
);

Deno.test(
  "Vector 1 (PLAT-7, Q-2): Guarded Queue provider rejects queue name spoofing and cross-tenant queue access",
  async () => {
    // spec: contracts/platform.contract.md#PLAT-7 — physical queue naming {org_id}_{project_id}_{resource_name}
    const rawQueue = new SQLiteQueueProvider(":memory:");

    // Tenant Alpha cannot create or bind to Tenant Beta's queue name
    assertThrows(
      () => {
        createGuardedQueueProvider(
          rawQueue,
          TENANT_ALPHA,
          "org-beta_proj-beta_jobs",
        );
      },
      PermissionDeniedError,
      "Cross-tenant queue access denied: queue name must begin with org-alpha_proj-alpha_",
    );

    // Queue names with traversal or path delimiters are rejected
    const invalidQueueNames = [
      "org-alpha_proj-alpha_../other_queue",
      "org-alpha_proj-alpha_jobs/sub",
      "org-alpha_proj-alpha_jobs\\sub",
      "org-alpha_proj-alpha_jobs\0admin",
      "org-alpha_proj-alpha_%2e%2e",
      "org-alpha_proj-alpha_", // Empty resource name
    ];

    for (const badName of invalidQueueNames) {
      assertThrows(
        () => {
          createGuardedQueueProvider(rawQueue, TENANT_ALPHA, badName);
        },
        PermissionDeniedError,
      );
    }

    // Dynamic property mutation on underlying object caught by assertCurrentQueueName
    const validGuarded = createGuardedQueueProvider(
      rawQueue,
      TENANT_ALPHA,
      "org-alpha_proj-alpha_jobs",
    );
    (rawQueue as unknown as Record<string, unknown>).queueName =
      "org-beta_proj-beta_tampered";

    await assertRejects(
      async () => {
        await validGuarded.send({ task: "pwn" });
      },
      PermissionDeniedError,
      "Cross-tenant queue access denied",
    );
  },
);

Deno.test(
  "Vector 1 (PLAT-6, PLAT-7): LocalIsolationProvider blocks untrusted function from addressing cross-tenant storage",
  async () => {
    // spec: contracts/platform.contract.md#PLAT-6, PLAT-7 — execution under LocalIsolationProvider
    const rawKv = new SQLiteKVProvider(":memory:");
    const guardedKv = createGuardedKVProvider(rawKv, TENANT_ALPHA);
    const provider = new LocalIsolationProvider();

    // Adversarial function code attempting cross-tenant KV access
    const adversaryCode = `
      export default async function handler(req, ctx) {
        try {
          await ctx.kv.get(["org-beta", "proj-beta", "victim_key"]);
          return new Response("EXPLOIT_SUCCESS", { status: 200 });
        } catch (err) {
          return new Response(JSON.stringify({
            name: err.name,
            message: err.message,
            code: err.code
          }), { status: 403, headers: { "content-type": "application/json" } });
        }
      }
    `;

    const artifact = createTestArtifact("adversary.ts", adversaryCode, {
      context: { kv: guardedKv },
    });

    const res = await provider.run(
      artifact,
      { timeoutMs: 5000, cpuMs: 200, memoryMb: 128 },
      createTestInvocation({
        "x-railfog-org": "org-alpha",
        "x-railfog-project": "proj-alpha",
        "x-railfog-function": "adversary",
        "x-railfog-revision": "rev_01",
      }, {
        requestId: "01J8ZTEST0000000000000001",
        url: "https://example.com/exploit",
      }),
    );

    assertEquals(res.statusCode, 403);
    const bodyObj = JSON.parse(new TextDecoder().decode(res.body));
    assertEquals(bodyObj.code, "PERMISSION_DENIED");
    assert(bodyObj.message.includes("Cross-tenant KV access denied"));
  },
);

// ============================================================================
// VECTOR 2: Network SSRF & DNS Rebinding (PLAT-5)
// ============================================================================

Deno.test(
  "Vector 2 (PLAT-5): Connect-time IP blocker blocks direct cloud metadata and RFC1918 private ranges",
  () => {
    // spec: contracts/platform.contract.md#PLAT-5 — Mandatory-block ranges
    const blocker = new EgressIpBlocker();

    // 1. Cloud metadata endpoints (AWS, GCP, Azure, OpenStack)
    assert(
      blocker.isIpBlocked("169.254.169.254"),
      "AWS/GCP metadata IPv4 must be blocked",
    );
    assert(
      blocker.isIpBlocked("169.254.1.1"),
      "Link-local range must be blocked",
    );
    assert(
      blocker.isIpBlocked("fd00:ec2::254"),
      "AWS IPv6 metadata must be blocked",
    );
    assert(
      blocker.isIpBlocked("[fd00:ec2::254]"),
      "Bracketed AWS IPv6 metadata must be blocked",
    );

    // 2. Loopback addresses
    assert(blocker.isIpBlocked("127.0.0.1"), "IPv4 loopback must be blocked");
    assert(
      blocker.isIpBlocked("127.0.0.2"),
      "Whole 127.0.0.0/8 subnet must be blocked",
    );
    assert(
      blocker.isIpBlocked("127.255.255.254"),
      "Loopback end range must be blocked",
    );
    assert(blocker.isIpBlocked("::1"), "IPv6 loopback must be blocked");
    assert(
      blocker.isIpBlocked("[::1]"),
      "Bracketed IPv6 loopback must be blocked",
    );

    // 3. RFC1918 private IP subnets
    assert(
      blocker.isIpBlocked("10.0.0.1"),
      "10.0.0.0/8 private network must be blocked",
    );
    assert(
      blocker.isIpBlocked("10.255.255.255"),
      "10.0.0.0/8 broadcast must be blocked",
    );
    assert(
      blocker.isIpBlocked("172.16.0.1"),
      "172.16.0.0/12 private network must be blocked",
    );
    assert(
      blocker.isIpBlocked("172.31.255.254"),
      "172.16.0.0/12 end range must be blocked",
    );
    assert(
      blocker.isIpBlocked("192.168.0.1"),
      "192.168.0.0/16 private network must be blocked",
    );
    assert(
      blocker.isIpBlocked("192.168.1.254"),
      "192.168.0.0/16 subnet must be blocked",
    );

    // 4. Non-canonical representations and evasion techniques
    assert(
      blocker.isIpBlocked("0x7f000001"),
      "Hexadecimal loopback must be blocked",
    );
    assert(blocker.isIpBlocked("0177.0.0.1"), "Octal loopback must be blocked");
    assert(
      blocker.isIpBlocked("2130706433"),
      "Dword integer loopback must be blocked",
    );
    assert(
      blocker.isIpBlocked("::ffff:127.0.0.1"),
      "IPv4-mapped IPv6 loopback must be blocked",
    );
    assert(
      blocker.isIpBlocked("::ffff:169.254.169.254"),
      "IPv4-mapped IPv6 metadata must be blocked",
    );
    assert(
      blocker.isIpBlocked("::169.254.169.254"),
      "IPv4-compatible IPv6 must be blocked",
    );

    // 5. Legitimate public IPs must be permitted
    assertFalse(
      blocker.isIpBlocked("1.1.1.1"),
      "Public Cloudflare DNS must not be blocked",
    );
    assertFalse(
      blocker.isIpBlocked("8.8.8.8"),
      "Public Google DNS must not be blocked",
    );
    assertFalse(
      blocker.isIpBlocked("2606:4700:4700::1111"),
      "Public Cloudflare IPv6 must not be blocked",
    );
  },
);

Deno.test(
  "Vector 2 (PLAT-5): Connect-time IP blocker intercepts DNS rebinding attacks resolving to private or metadata IPs",
  async () => {
    // spec: contracts/platform.contract.md#PLAT-5 — Connect-time DNS resolution prevents rebinding
    const simulatedDns = new Map<string, string[]>();
    simulatedDns.set("attacker-rebind.internal", ["169.254.169.254"]);
    simulatedDns.set("loopback-rebind.example", ["127.0.0.1"]);
    simulatedDns.set("corp-lan-rebind.test", ["10.0.0.5"]);
    simulatedDns.set("legitimate-api.example.com", ["93.184.216.34"]); // example.com public IP

    const blocker = new EgressIpBlocker({
      dnsResolver: (host: string) => {
        const ips = simulatedDns.get(host) ?? [];
        return Promise.resolve(ips);
      },
    });

    // 1. Hostname resolving to cloud metadata
    const metadataResult = await blocker.validateDestination(
      "attacker-rebind.internal",
    );
    assert(
      metadataResult.blocked,
      "Hostname resolving to metadata must be blocked",
    );
    assertEquals(metadataResult.ip, "169.254.169.254");

    // 2. Hostname resolving to loopback
    const loopbackResult = await blocker.validateDestination(
      "loopback-rebind.example",
    );
    assert(
      loopbackResult.blocked,
      "Hostname resolving to loopback must be blocked",
    );

    // 3. Hostname resolving to RFC1918 LAN
    const rfc1918Result = await blocker.validateDestination(
      "corp-lan-rebind.test",
    );
    assert(
      rfc1918Result.blocked,
      "Hostname resolving to 10.0.0.5 must be blocked",
    );

    // 4. Hostname resolving to public IP
    const publicResult = await blocker.validateDestination(
      "legitimate-api.example.com",
    );
    assertFalse(publicResult.blocked, "Public destination must be allowed");
    assertEquals(publicResult.ip, "93.184.216.34");
  },
);

Deno.test(
  "Vector 2 (PLAT-5): EgressProxy intercepts non-allowlisted destinations and blocks metadata requests",
  async () => {
    // spec: contracts/platform.contract.md#PLAT-5 — Layer 1 allowlist + Layer 2 connect-time IP block
    const blocker = new EgressIpBlocker();
    const proxy = new EgressProxy({ blocker });

    try {
      const invocationId = "inv_sec_vector_2";
      proxy.registerInvocation({
        invocationId,
        allowlist: ["api.example.com"],
      });

      // 1. Target not in allowlist (Layer 1 rejection)
      const unauthorizedReq = new Request("http://evil-attacker.com/leak", {
        method: "GET",
      });
      const unauthorizedRes = await proxy.handleRequest(
        unauthorizedReq,
        invocationId,
      );
      assertEquals(unauthorizedRes.status, 403);
      const unauthJson = await unauthorizedRes.json();
      assertEquals(unauthJson.error.code, "PERMISSION_DENIED");
      assert(
        unauthJson.error.message.includes("not permitted by network allowlist"),
      );

      // 2. Direct attempt to reach cloud metadata (blocked by Layer 1 & Layer 2)
      const metadataReq = new Request(
        "http://169.254.169.254/latest/meta-data/",
        {
          method: "GET",
        },
      );
      const metadataRes = await proxy.handleRequest(metadataReq, invocationId);
      assertEquals(metadataRes.status, 403);
      const metaJson = await metadataRes.json();
      assertEquals(metaJson.error.code, "PERMISSION_DENIED");

      // 3. Empty allowlist blocks all outbound egress
      const emptyInvocationId = "inv_empty_allowlist";
      proxy.registerInvocation({
        invocationId: emptyInvocationId,
        allowlist: [],
      });
      const blockedReq = new Request("http://api.example.com/v1", {
        method: "GET",
      });
      const blockedRes = await proxy.handleRequest(
        blockedReq,
        emptyInvocationId,
      );
      assertEquals(blockedRes.status, 403);

      proxy.unregisterInvocation(emptyInvocationId);
      proxy.unregisterInvocation(invocationId);
    } finally {
      await proxy.close();
    }
  },
);

// ============================================================================
// VECTOR 3: Secret Exfiltration & Auto-Redaction (PLAT-15, PLAT-13)
// ============================================================================

Deno.test(
  "Vector 3 (PLAT-15, PLAT-6): Undeclared secrets return undefined and ambient host environment is inexpressible",
  async () => {
    // spec: contracts/platform.contract.md#PLAT-15 — runtime access capability-scoped
    // spec: contracts/platform.contract.md#PLAT-6 — unpermitted secrets inexpressible
    const secretStore = createInMemorySecretStore();
    await secretStore.set(
      "org-corp",
      "proj-api",
      "STRIPE_KEY",
      "sk_live_1234567890abcdef",
    );
    await secretStore.set(
      "org-corp",
      "proj-api",
      "DATABASE_URL",
      "postgres://admin:pass@db/prod",
    );

    const injector = new SecretInjector();

    // 1. Function declaring only STRIPE_KEY
    const envBinding = await injector.resolveEnvBinding(
      "org-corp",
      "proj-api",
      ["STRIPE_KEY"],
      secretStore,
    );

    assertEquals(
      envBinding.get("STRIPE_KEY"),
      "sk_live_1234567890abcdef",
      "Declared secret must be accessible",
    );
    assertEquals(
      envBinding.get("DATABASE_URL"),
      undefined,
      "Undeclared secret must return undefined",
    );

    // 2. Attempting to smuggle host environment variables via permissions.secrets
    const smuggledBinding = await injector.resolveEnvBinding(
      "org-corp",
      "proj-api",
      ["PATH", "HOME", "USER", "SHELL", "AWS_SECRET_ACCESS_KEY"],
      secretStore,
    );

    assertEquals(smuggledBinding.get("PATH"), undefined);
    assertEquals(smuggledBinding.get("HOME"), undefined);
    assertEquals(smuggledBinding.get("AWS_SECRET_ACCESS_KEY"), undefined);
  },
);

Deno.test(
  "Vector 3 (PLAT-15, FN-6): Invocation-time secret rotation without isolate restart in LocalIsolationProvider",
  async () => {
    // spec: contracts/platform.contract.md#PLAT-15 — rotation possible without a redeploy
    const secretStore = createInMemorySecretStore();
    await secretStore.set(
      "org-sec",
      "proj-rot",
      "ROTATING_TOKEN",
      "token_version_alpha_11111",
    );

    const provider = new LocalIsolationProvider({
      secretStore,
      orgId: "org-sec",
    });

    const handlerCode = `
      export default async function handler(req, ctx) {
        return new Response(ctx.env.get("ROTATING_TOKEN") ?? "UNDEFINED", { status: 200 });
      }
    `;

    const artifact = createTestArtifact("rotator.ts", handlerCode);

    const invRequest = createTestInvocation({
      "x-railfog-org": "org-sec",
      "x-railfog-project": "proj-rot",
      "x-railfog-function": "rotator",
      "x-railfog-revision": "rev_01",
    }, {
      requestId: "01J8ZTEST0000000000000002",
      url: "https://example.com/secret",
    });

    // Invocation 1 reads Initial Secret
    const res1 = await provider.run(
      artifact,
      { timeoutMs: 5000, cpuMs: 200, memoryMb: 128 },
      invRequest,
    );
    assertEquals(
      new TextDecoder().decode(res1.body),
      "token_version_alpha_11111",
    );
    assertEquals(provider.getWarmCount(), 1, "Isolate must be warm in cache");

    // Rotate secret in SecretStore dynamically
    await secretStore.set(
      "org-sec",
      "proj-rot",
      "ROTATING_TOKEN",
      "token_version_beta_99999",
    );

    // Invocation 2 executes in the same warm isolate and receives the new rotated secret immediately
    const res2 = await provider.run(
      artifact,
      { timeoutMs: 5000, cpuMs: 200, memoryMb: 128 },
      { ...invRequest, requestId: "01J8ZTEST0000000000000003" },
    );
    assertEquals(
      new TextDecoder().decode(res2.body),
      "token_version_beta_99999",
    );
    assertEquals(
      provider.getWarmCount(),
      1,
      "Warm isolate reused without restart",
    );
  },
);

Deno.test(
  "Vector 3 (PLAT-15, PLAT-13): SecretRedactor auto-redacts bound secret values in logs, error traces, and JSON objects",
  () => {
    // spec: contracts/platform.contract.md#PLAT-15 — auto-redact any value matching bound secret
    const redactor = new SecretRedactor();
    const secrets = [
      "super_secret_stripe_live_key_9999",
      "db_password_top_secret_xyz",
    ];

    // 1. Plain text logs
    const rawLog =
      "Request failed authenticating with super_secret_stripe_live_key_9999 against upstream";
    const redactedLog = redactor.redact(rawLog, secrets);
    assertEquals(
      redactedLog,
      `Request failed authenticating with ${REDACTED_MARKER} against upstream`,
    );

    // 2. Error objects and stack traces
    const err = new Error(
      "Database query failed with db_password_top_secret_xyz",
    );
    const redactedErr = redactor.redactJson(err, secrets) as Error;
    assertEquals(
      redactedErr.message,
      `Database query failed with ${REDACTED_MARKER}`,
    );
    assertFalse(redactedErr.stack?.includes("db_password_top_secret_xyz"));

    // 3. Structured JSON payloads with nested objects and arrays
    const structuredPayload = {
      timestamp: "2026-09-14T21:00:00Z",
      level: "error",
      message: "Authorization error",
      credentials: {
        token: "super_secret_stripe_live_key_9999",
        pass: "db_password_top_secret_xyz",
      },
      audit: [
        "Logged in with super_secret_stripe_live_key_9999",
        { key: "db_password_top_secret_xyz" },
      ],
    };

    const redactedPayload = redactor.redactJson(
      structuredPayload,
      secrets,
    ) as typeof structuredPayload;
    assertEquals(redactedPayload.credentials.token, REDACTED_MARKER);
    assertEquals(redactedPayload.credentials.pass, REDACTED_MARKER);
    assertEquals(
      redactedPayload.audit[0],
      `Logged in with ${REDACTED_MARKER}`,
    );
    assertEquals(
      (redactedPayload.audit[1] as Record<string, string>).key,
      REDACTED_MARKER,
    );
  },
);

// ============================================================================
// VECTOR 4: Warm-Isolate State Bleeding (FN-6, PLAT-4)
// ============================================================================

Deno.test(
  "Vector 4 (FN-6, PLAT-4): Warm-isolate sequential invocations run with fresh ULID, fresh bindings, and cleansed globals",
  async () => {
    // spec: contracts/functions.contract.md#FN-6 — bindings re-injected every invocation
    const provider = new LocalIsolationProvider();

    // Adversary function attempts to store context reference, poison global scope, and Object.prototype
    const adversaryCode = `
      let cachedPriorCtx = null;

      export default async function handler(req, ctx) {
        if (req.headers.get("x-action") === "poison") {
          globalThis.__exfiltrated_global = "compromised_data";
          Object.prototype.__poisoned_proto = "proto_leak";
          cachedPriorCtx = ctx;
          return new Response("POISONED", { status: 200 });
        }

        // Invocation 2: probe whether leaked state or capability survived
        const globalValue = globalThis.__exfiltrated_global ?? null;
        const protoValue = ({}).__poisoned_proto ?? null;
        const priorEnvValue = cachedPriorCtx ? (cachedPriorCtx.env.get("ANY") ?? null) : null;

        return new Response(JSON.stringify({
          globalValue,
          protoValue,
          priorEnvValue,
          requestId: ctx.requestId,
        }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
    `;

    const artifact = createTestArtifact("isolate_adversary.ts", adversaryCode);
    const limits = { timeoutMs: 5000, cpuMs: 200, memoryMb: 128 };

    const reqId1 = generateUlid();
    const reqId2 = generateUlid();

    // Invocation 1: Poison state
    const res1 = await provider.run(
      artifact,
      limits,
      createTestInvocation({
        "x-action": "poison",
        "x-railfog-project": "proj-bleed",
        "x-railfog-function": "adversary",
        "x-railfog-revision": "rev_01",
      }, {
        requestId: reqId1,
        method: "POST",
        url: "https://example.com/poison",
      }),
    );
    assertEquals(res1.statusCode, 200);

    // Invocation 2: Check isolation
    const res2 = await provider.run(
      artifact,
      limits,
      createTestInvocation({
        "x-action": "probe",
        "x-railfog-project": "proj-bleed",
        "x-railfog-function": "adversary",
        "x-railfog-revision": "rev_01",
      }, {
        requestId: reqId2,
        method: "GET",
        url: "https://example.com/probe",
      }),
    );
    assertEquals(res2.statusCode, 200);

    const probeResult = JSON.parse(new TextDecoder().decode(res2.body));
    assertEquals(
      probeResult.globalValue,
      null,
      "globalThis pollution must be cleaned up",
    );
    assertEquals(
      probeResult.protoValue,
      null,
      "Object.prototype pollution must be cleaned up",
    );
    assertEquals(
      probeResult.priorEnvValue,
      null,
      "Prior invocation env must be deactivated",
    );
    assertEquals(probeResult.requestId, reqId2);
    assertNotEquals(probeResult.requestId, reqId1);
    assert(isValidUlid(probeResult.requestId), "Must have fresh valid ULID");
  },
);

Deno.test(
  "Vector 4 (FN-6): Distinct revisions and distinct projects never share warm isolates across providers",
  async () => {
    // spec: contracts/functions.contract.md#FN-6 — reuse ONLY within same Function + Revision
    const localProvider = new LocalIsolationProvider();
    const processProvider = new ProcessIsolationProvider();

    const statefulCode = `
      let invocationOrder = 0;
      export default async function handler(req, ctx) {
        invocationOrder++;
        return new Response(JSON.stringify({
          project: ctx.project,
          revision: ctx.revision,
          invocationOrder
        }), { status: 200 });
      }
    `;

    const artifact = createTestArtifact("stateful.ts", statefulCode);
    const limits = { timeoutMs: 5000, cpuMs: 200, memoryMb: 128 };

    try {
      // 1. Under LocalIsolationProvider
      const resRev1 = await localProvider.run(
        artifact,
        limits,
        createTestInvocation({
          "x-railfog-project": "proj-shared",
          "x-railfog-function": "stateful",
          "x-railfog-revision": "rev_1",
        }),
      );
      const bodyRev1 = JSON.parse(new TextDecoder().decode(resRev1.body));
      assertEquals(bodyRev1.invocationOrder, 1);

      // Revision 2 runs in a new separate isolate
      const resRev2 = await localProvider.run(
        artifact,
        limits,
        createTestInvocation({
          "x-railfog-project": "proj-shared",
          "x-railfog-function": "stateful",
          "x-railfog-revision": "rev_2",
        }),
      );
      const bodyRev2 = JSON.parse(new TextDecoder().decode(resRev2.body));
      assertEquals(
        bodyRev2.invocationOrder,
        1,
        "Different revision must start in a fresh isolate",
      );

      // Project B runs in a new separate isolate
      const resProjB = await localProvider.run(
        artifact,
        limits,
        createTestInvocation({
          "x-railfog-project": "proj-isolated-b",
          "x-railfog-function": "stateful",
          "x-railfog-revision": "rev_1",
        }),
      );
      const bodyProjB = JSON.parse(new TextDecoder().decode(resProjB.body));
      assertEquals(
        bodyProjB.invocationOrder,
        1,
        "Different project must start in a fresh isolate",
      );

      // 2. Under ProcessIsolationProvider
      const procRev1 = await processProvider.run(
        artifact,
        limits,
        createTestInvocation({
          "x-railfog-project": "proj-proc-shared",
          "x-railfog-function": "stateful",
          "x-railfog-revision": "rev_1",
        }),
      );
      const procBodyRev1 = JSON.parse(new TextDecoder().decode(procRev1.body));
      assertEquals(procBodyRev1.invocationOrder, 1);

      const procRev2 = await processProvider.run(
        artifact,
        limits,
        createTestInvocation({
          "x-railfog-project": "proj-proc-shared",
          "x-railfog-function": "stateful",
          "x-railfog-revision": "rev_2",
        }),
      );
      const procBodyRev2 = JSON.parse(new TextDecoder().decode(procRev2.body));
      assertEquals(
        procBodyRev2.invocationOrder,
        1,
        "Different revision must spawn separate subprocess",
      );
    } finally {
      await processProvider.shutdown();
    }
  },
);

// ============================================================================
// VECTOR 5: Denial-of-Wallet & Resource Exhaustion (PLAT-9, FN-5, FN-7)
// ============================================================================

Deno.test(
  "Vector 5 (PLAT-9): TokenBucketLimiter throttles burst requests with 429 RATE_LIMITED and Retry-After",
  () => {
    // spec: contracts/platform.contract.md#PLAT-9 — rate limiting: token bucket algorithm
    const limiter = new TokenBucketLimiter();

    // IP scope tier: rate 10 req/s, burst 20
    const clientIp = "198.51.100.42";

    // Consume entire burst capacity of 20 tokens
    for (let i = 0; i < 20; i++) {
      const res = limiter.consume(clientIp, "ip");
      assert(
        res.allowed,
        `Request ${i + 1} within burst capacity must be allowed`,
      );
    }

    // 21st request must be throttled
    const rejected = limiter.consume(clientIp, "ip");
    assertFalse(
      rejected.allowed,
      "Request beyond burst capacity must be rejected",
    );
    assert(
      rejected.retryAfterSeconds !== undefined &&
        rejected.retryAfterSeconds >= 1,
      "Retry-After must be computed and >= 1 second",
    );

    // Format PLAT-12 HTTP 429 response
    const httpRes = formatRateLimitRejection(rejected.retryAfterSeconds!);
    assertEquals(httpRes.status, 429);
    assertEquals(
      httpRes.headers.get("Retry-After"),
      String(rejected.retryAfterSeconds),
    );
  },
);

Deno.test(
  "Vector 5 (FN-7): Mutual recursive calls abort at hop 9 when call depth exceeds 8 hops (429 CALL_DEPTH_EXCEEDED)",
  async () => {
    // spec: contracts/functions.contract.md#FN-7 — call-depth guard: reject > call_depth_max (8)
    const tracker = createInvocationTracker();

    // Trace hops 1 through 8
    assertEquals(tracker.checkCallDepth(undefined), 1);
    assertEquals(tracker.checkCallDepth("1"), 2);
    assertEquals(tracker.checkCallDepth("7"), 8);

    // 9th hop exceeds maximum call depth 8
    assertThrows(
      () => {
        tracker.checkCallDepth("8");
      },
      CallDepthExceededError,
      "Call depth limit exceeded: next hop 9 exceeds maximum allowed depth of 8",
    );

    // In LocalIsolationProvider: incoming request with depth 8 returns 429
    const provider = new LocalIsolationProvider();
    const noopCode =
      `export default async function handler() { return new Response("OK"); }`;
    const artifact = createTestArtifact("noop.ts", noopCode);

    const res = await provider.run(
      artifact,
      { timeoutMs: 5000, cpuMs: 200, memoryMb: 128 },
      createTestInvocation({
        [CALL_DEPTH_HEADER]: "8",
      }),
    );

    assertEquals(res.statusCode, 429);
    const bodyJson = JSON.parse(new TextDecoder().decode(res.body));
    assertEquals(bodyJson.error.code, "CALL_DEPTH_EXCEEDED");
  },
);

Deno.test(
  "Vector 5 (FN-5): Wall-clock deadline kill aborts long-running execution with 504 TIMEOUT",
  async () => {
    // spec: contracts/functions.contract.md#FN-5 — timeout_ms kill at deadline
    const localProvider = new LocalIsolationProvider();
    const processProvider = new ProcessIsolationProvider();

    const hangingCode = `
      export default async function handler() {
        await new Promise((resolve) => setTimeout(resolve, 500));
        return new Response("TOO_LATE");
      }
    `;

    const artifact = createTestArtifact("hang.ts", hangingCode);

    try {
      // 1. Under LocalIsolationProvider with 50ms timeout
      const localRes = await localProvider.run(
        artifact,
        { timeoutMs: 50, cpuMs: 200, memoryMb: 128 },
      );
      assertEquals(localRes.statusCode, 504);
      const localJson = JSON.parse(new TextDecoder().decode(localRes.body));
      assertEquals(localJson.error.code, "TIMEOUT");

      // 2. Under ProcessIsolationProvider with 100ms timeout
      const procRes = await processProvider.run(
        artifact,
        { timeoutMs: 100, cpuMs: 200, memoryMb: 128 },
      );
      assertEquals(procRes.statusCode, 504);
      const procJson = JSON.parse(new TextDecoder().decode(procRes.body));
      assertEquals(procJson.error.code, "TIMEOUT");
    } finally {
      await processProvider.shutdown();
    }
  },
);

Deno.test(
  "Vector 5 (FN-5): Per-invocation operation quotas reject 1,001st KV op and 101st Object/Queue op with 429",
  () => {
    // spec: contracts/functions.contract.md#FN-5 — kv 1,000, objects 100, queue 100
    const tracker = createInvocationTracker();

    // 1. KV operation limit (1,000 max)
    for (let i = 0; i < 1000; i++) {
      tracker.recordKvOp();
    }
    assertThrows(
      () => {
        tracker.recordKvOp();
      },
      RateLimitedError,
      "KV operation limit exceeded: maximum 1000 operations per invocation allowed",
    );

    // 2. Object operation limit (100 max)
    for (let i = 0; i < 100; i++) {
      tracker.recordObjectOp();
    }
    assertThrows(
      () => {
        tracker.recordObjectOp();
      },
      RateLimitedError,
      "Object operation limit exceeded: maximum 100 operations per invocation allowed",
    );

    // 3. Queue operation limit (100 max)
    for (let i = 0; i < 100; i++) {
      tracker.recordQueueOp();
    }
    assertThrows(
      () => {
        tracker.recordQueueOp();
      },
      RateLimitedError,
      "Queue operation limit exceeded: maximum 100 operations per invocation allowed",
    );
  },
);

Deno.test(
  "Vector 5 (FN-5): Request payload exceeding 10MB ceiling is rejected with 413 PAYLOAD_TOO_LARGE",
  async () => {
    // spec: contracts/functions.contract.md#FN-5 — request_body_mb 10, reject with 413 PAYLOAD_TOO_LARGE
    const killEnforcer = createKillEnforcer({
      timeoutMs: 30000,
      cpuMs: 200,
      maxRequestBodyBytes: 10 * 1024 * 1024,
    });

    // 1. Content-Length header exceeding 10 MB
    await assertRejects(
      async () => {
        await killEnforcer.validateRequestBody(11 * 1024 * 1024);
      },
      PayloadTooLargeError,
      "exceeds maximum allowed size of 10485760 bytes",
    );

    // 2. Streaming body exceeding 10 MB limit
    const oversizedChunk = new Uint8Array(1024 * 1024); // 1 MB chunk
    let chunksRead = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (chunksRead < 11) {
          chunksRead++;
          controller.enqueue(oversizedChunk);
        } else {
          controller.close();
        }
      },
    });

    await assertRejects(
      async () => {
        await killEnforcer.validateRequestBody(undefined, stream);
      },
      PayloadTooLargeError,
      "Request body exceeds maximum allowed size",
    );
  },
);

// ============================================================================
// VECTOR 6: Sandbox Boundary Escape (PLAT-4)
// ============================================================================

Deno.test(
  "Vector 6 (PLAT-4): ProcessIsolationProvider blocks untrusted code from executing Deno.Command",
  async () => {
    // spec: contracts/platform.contract.md#PLAT-4 — --deny-run sandbox boundary
    const provider = new ProcessIsolationProvider();

    const escapeCode = `
      export default async function handler() {
        try {
          const bin = Deno.execPath();
          const cmd = new Deno.Command(bin, { args: ["eval", "1"] });
          cmd.spawn();
          return new Response("UNEXPECTED_COMMAND_EXEC_SUCCESS", { status: 200 });
        } catch (err) {
          return new Response(JSON.stringify({
            errorName: err.name,
            errorMessage: err.message
          }), { status: 500 });
        }
      }
    `;

    const artifact = createTestArtifact("exec_escape.ts", escapeCode);

    try {
      const res = await provider.run(
        artifact,
        { timeoutMs: 5000, cpuMs: 200, memoryMb: 128 },
      );

      assertEquals(res.statusCode, 500);
      const json = JSON.parse(new TextDecoder().decode(res.body));
      assert(
        json.errorMessage.includes("Requires run access") ||
          json.errorName === "NotCapable" ||
          json.errorName === "PermissionDenied",
        `Expected Deno run permission error, got: ${JSON.stringify(json)}`,
      );
    } finally {
      await provider.shutdown();
    }
  },
);

Deno.test(
  "Vector 6 (PLAT-4): ProcessIsolationProvider blocks untrusted code from host filesystem read/write and host env inspection",
  async () => {
    // spec: contracts/platform.contract.md#PLAT-4 — --deny-read, --deny-write, --deny-env
    const provider = new ProcessIsolationProvider();

    const fsEscapeCode = `
      export default async function handler(req) {
        const action = req.headers.get("x-action");
        try {
          if (action === "read_file") {
            // Attempt host path read
            const target = Deno.build.os === "windows"
              ? "C:\\\\Windows\\\\System32\\\\drivers\\\\etc\\\\hosts"
              : "/etc/passwd";
            const content = await Deno.readTextFile(target);
            return new Response("LEAK: " + content, { status: 200 });
          } else if (action === "write_file") {
            // Attempt host path write
            const target = Deno.build.os === "windows"
              ? "C:\\\\railfog_pwn.txt"
              : "/tmp/railfog_pwn.txt";
            await Deno.writeTextFile(target, "escaped");
            return new Response("WRITTEN", { status: 200 });
          } else if (action === "read_env") {
            // Attempt host env read
            const envVal = Deno.env.get("PATH");
            return new Response("ENV: " + envVal, { status: 200 });
          }
          return new Response("UNKNOWN_ACTION", { status: 400 });
        } catch (err) {
          return new Response(JSON.stringify({
            errorName: err.name,
            errorMessage: err.message
          }), { status: 500 });
        }
      }
    `;

    const artifact = createTestArtifact("fs_escape.ts", fsEscapeCode);
    const limits = { timeoutMs: 5000, cpuMs: 200, memoryMb: 128 };

    try {
      // 1. Filesystem read attempt
      const readRes = await provider.run(
        artifact,
        limits,
        createTestInvocation({
          "x-action": "read_file",
        }),
      );
      assertEquals(readRes.statusCode, 500);
      const readJson = JSON.parse(new TextDecoder().decode(readRes.body));
      assert(
        readJson.errorMessage.includes("Requires read access") ||
          readJson.errorName === "NotCapable" ||
          readJson.errorName === "PermissionDenied",
        `Expected read permission denial, got: ${JSON.stringify(readJson)}`,
      );

      // 2. Filesystem write attempt
      const writeRes = await provider.run(
        artifact,
        limits,
        createTestInvocation({
          "x-action": "write_file",
        }),
      );
      assertEquals(writeRes.statusCode, 500);
      const writeJson = JSON.parse(new TextDecoder().decode(writeRes.body));
      assert(
        writeJson.errorMessage.includes("Requires write access") ||
          writeJson.errorName === "NotCapable" ||
          writeJson.errorName === "PermissionDenied",
        `Expected write permission denial, got: ${JSON.stringify(writeJson)}`,
      );

      // 3. Host environment query attempt
      const envRes = await provider.run(
        artifact,
        limits,
        createTestInvocation({
          "x-action": "read_env",
        }),
      );
      assertEquals(envRes.statusCode, 500);
      const envJson = JSON.parse(new TextDecoder().decode(envRes.body));
      assert(
        envJson.errorMessage.includes("Requires env access") ||
          envJson.errorName === "NotCapable" ||
          envJson.errorName === "PermissionDenied",
        `Expected env permission denial, got: ${JSON.stringify(envJson)}`,
      );
    } finally {
      await provider.shutdown();
    }
  },
);

Deno.test(
  "Vector 6 (PLAT-4, ADR-0001): Untrusted code writing directly to Deno.stdout cannot forge host IPC messages",
  async () => {
    // spec: contracts/platform.contract.md#PLAT-4 — stdio IPC integrity
    // Customer console and direct Deno.stdout writes are redirected to stderr in process-worker
    const provider = new ProcessIsolationProvider();

    const spooferCode = `
      export default async function handler(req, ctx) {
        // Attempt to forge a legitimate IPC success frame to hijack execution result
        const fakeIpcFrame = JSON.stringify({
          id: "forged_frame_ulid",
          statusCode: 200,
          headers: { "x-hacked": "true" },
          bodyBase64: btoa("FORGED_HOST_RESPONSE"),
          cpuTimeMs: 0,
          wallClockMs: 0
        }) + "\\n";

        // Write directly to Deno.stdout
        try {
          Deno.stdout.writeSync(new TextEncoder().encode(fakeIpcFrame));
        } catch {
          // stdout write trapped
        }

        // Return real intended response
        return new Response("LEGITIMATE_AUTHENTIC_RESPONSE", {
          status: 200,
          headers: { "x-authentic": "true" }
        });
      }
    `;

    const artifact = createTestArtifact("ipc_spoofer.ts", spooferCode);

    try {
      const res = await provider.run(
        artifact,
        { timeoutMs: 5000, cpuMs: 200, memoryMb: 128 },
      );

      assertEquals(res.statusCode, 200);
      const bodyText = new TextDecoder().decode(res.body);
      assertEquals(
        bodyText,
        "LEGITIMATE_AUTHENTIC_RESPONSE",
        "Host runner must receive legitimate response from worker wrapper, ignoring spoofed stdout",
      );
      assertEquals(res.headers["x-authentic"], "true");
      assertEquals(
        res.headers["x-hacked"],
        undefined,
        "Forged headers must not be accepted by host IPC protocol",
      );
    } finally {
      await provider.shutdown();
    }
  },
);
