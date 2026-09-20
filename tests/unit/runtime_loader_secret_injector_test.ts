/**
 * Tests for dynamic secret injection (SecretInjector) and env binding resolution.
 *
 * Spec references:
 * - docs/contracts/platform.contract.md#PLAT-15: Secrets (never committed, logged, returned by API,
 *   embedded in artifact, or in error/trace; runtime access capability-scoped; resolved at invocation time;
 *   rotation possible without redeploy; structured logging auto-redacts bound secret names)
 * - docs/contracts/platform.contract.md#PLAT-6: Capability injection (no runtime ACL checks,
 *   undeclared secrets cannot be addressed)
 * - docs/contracts/platform.contract.md#PLAT-7: Multi-tenancy & data isolation (scoping by orgId and projectId)
 * - docs/contracts/platform.contract.md#PLAT-12: Error model (ValidationFailedError on invalid inputs)
 * - docs/contracts/functions.contract.md#FN-4: RailFogContext (env: EnvBinding exposes only explicitly assigned secrets)
 * - docs/contracts/functions.contract.md#FN-6: Isolation & warm-reuse rule (bindings re-injected every invocation,
 *   never trusted to persist across invocations)
 */

import { assertEquals, assertNotEquals, assertRejects } from "@std/assert";
import { ValidationFailedError } from "../../packages/errors/mod.ts";
import {
  LocalEncryptedSecretStore,
  type SecretStore,
} from "../../packages/policy/secret-store.ts";
import {
  buildContext,
  type EnvBinding,
} from "../../runtime/loader/context-builder.ts";
import { SecretInjector } from "../../runtime/loader/secret-injector.ts";

const MASTER_KEY = "test-master-key-0123456789abcdef";

function createStore(): SecretStore {
  return new LocalEncryptedSecretStore({ masterKey: MASTER_KEY });
}

// ============================================================================
// AC1 & Unit: Capability Scoping & Resolution (PLAT-15, PLAT-6, FN-4)
// ============================================================================

Deno.test("AC1 — Declared secret in permissions.secrets returns value from SecretStore via ctx.env.get", async () => {
  // spec: docs/contracts/platform.contract.md#PLAT-15 — ctx.env.get("STRIPE_KEY") returns secret value
  // spec: docs/contracts/functions.contract.md#FN-4 — env: EnvBinding only secrets explicitly assigned
  const store = createStore();
  const orgId = "org_ac1";
  const projectId = "proj_ac1";
  await store.set(
    orgId,
    projectId,
    "STRIPE_KEY",
    "sk_live_stripe_secret_12345",
  );

  const injector = new SecretInjector();
  const envBinding: EnvBinding = await injector.resolveEnvBinding(
    orgId,
    projectId,
    ["STRIPE_KEY"],
    store,
  );

  // Directly verify EnvBinding
  assertEquals(envBinding.get("STRIPE_KEY"), "sk_live_stripe_secret_12345");

  // Verify through RailFogContext
  const ctx = {
    ...buildContext(
      { project: projectId, function: "api", revision: "rev_01" },
      {},
    ),
    env: envBinding,
  };
  assertEquals(ctx.env.get("STRIPE_KEY"), "sk_live_stripe_secret_12345");
});

Deno.test("AC1 — Multiple declared secrets are all accessible via ctx.env.get", async () => {
  // spec: docs/contracts/platform.contract.md#PLAT-15 — Multiple allowed secrets resolved at invocation time
  const store = createStore();
  const orgId = "org_multi";
  const projectId = "proj_multi";
  await store.set(orgId, projectId, "STRIPE_KEY", "sk_stripe_val");
  await store.set(
    orgId,
    projectId,
    "DATABASE_URL",
    "postgres://user:pass@db:5432/app",
  );
  await store.set(
    orgId,
    projectId,
    "SENDGRID_API_KEY",
    "SG.test_api_key_value",
  );

  const injector = new SecretInjector();
  const env = await injector.resolveEnvBinding(
    orgId,
    projectId,
    ["STRIPE_KEY", "DATABASE_URL", "SENDGRID_API_KEY"],
    store,
  );

  assertEquals(env.get("STRIPE_KEY"), "sk_stripe_val");
  assertEquals(env.get("DATABASE_URL"), "postgres://user:pass@db:5432/app");
  assertEquals(env.get("SENDGRID_API_KEY"), "SG.test_api_key_value");
});

// ============================================================================
// AC2 & Undeclared Secret Rejection (PLAT-15, PLAT-6, FN-4)
// ============================================================================

Deno.test("AC2 — Omitted secret returns undefined even when present in SecretStore", async () => {
  // spec: docs/contracts/platform.contract.md#PLAT-15 — Absence of secret in permissions == undefined
  // spec: docs/contracts/platform.contract.md#PLAT-6 — Absence of resource == no code path to reach it
  const store = createStore();
  const orgId = "org_ac2";
  const projectId = "proj_ac2";

  // Secret exists in the store
  await store.set(orgId, projectId, "STRIPE_KEY", "sk_live_stripe_value");
  await store.set(
    orgId,
    projectId,
    "GITHUB_TOKEN",
    "ghp_secret_github_token_value",
  );

  const injector = new SecretInjector();
  // GITHUB_TOKEN is omitted from allowedSecrets
  const env = await injector.resolveEnvBinding(
    orgId,
    projectId,
    ["STRIPE_KEY"],
    store,
  );

  assertEquals(env.get("STRIPE_KEY"), "sk_live_stripe_value");
  assertEquals(env.get("GITHUB_TOKEN"), undefined);
});

Deno.test("AC2 — Undeclared secret returns undefined even when present in host Deno.env", async () => {
  // spec: docs/contracts/platform.contract.md#PLAT-15 — Never ambient process environment variables
  // spec: docs/contracts/platform.contract.md#PLAT-5 — A Function never gets host environment by default
  const store = createStore();
  const orgId = "org_ac2_host";
  const projectId = "proj_ac2_host";

  const hostSecretKey = "GITHUB_TOKEN_HOST_TEST";
  const hostSecretVal = "ghp_host_level_secret_token";
  const envPerm = await Deno.permissions.query({ name: "env" });
  if (envPerm.state === "granted") {
    Deno.env.set(hostSecretKey, hostSecretVal);
  }

  try {
    const injector = new SecretInjector();
    // GITHUB_TOKEN_HOST_TEST omitted from permissions
    const env = await injector.resolveEnvBinding(
      orgId,
      projectId,
      ["SOME_OTHER_KEY"],
      store,
    );

    assertEquals(env.get(hostSecretKey), undefined);
  } finally {
    if (envPerm.state === "granted") {
      Deno.env.delete(hostSecretKey);
    }
  }
});

Deno.test("Unit — Empty allowedSecrets yields an env binding where all queries return undefined", async () => {
  // spec: docs/contracts/platform.contract.md#PLAT-6 — Empty declaration means zero access
  const store = createStore();
  const orgId = "org_empty";
  const projectId = "proj_empty";
  await store.set(orgId, projectId, "ANY_SECRET", "should_not_be_accessible");

  const injector = new SecretInjector();
  const env = await injector.resolveEnvBinding(orgId, projectId, [], store);

  assertEquals(env.get("ANY_SECRET"), undefined);
  assertEquals(env.get("NON_EXISTENT"), undefined);
});

Deno.test("Unit — Declared key not found in SecretStore returns undefined", async () => {
  // spec: docs/contracts/platform.contract.md#PLAT-15 — Missing secret in store returns undefined
  const store = createStore();
  const orgId = "org_missing";
  const projectId = "proj_missing";

  const injector = new SecretInjector();
  const env = await injector.resolveEnvBinding(
    orgId,
    projectId,
    ["UNSET_SECRET_KEY"],
    store,
  );

  assertEquals(env.get("UNSET_SECRET_KEY"), undefined);
});

Deno.test("Unit — Secret key lookup is case-sensitive", async () => {
  // spec: docs/contracts/platform.contract.md#PLAT-15 — Exact key name lookup
  const store = createStore();
  const orgId = "org_case";
  const projectId = "proj_case";
  await store.set(orgId, projectId, "STRIPE_KEY", "sk_case_sensitive");

  const injector = new SecretInjector();
  const env = await injector.resolveEnvBinding(
    orgId,
    projectId,
    ["STRIPE_KEY"],
    store,
  );

  assertEquals(env.get("STRIPE_KEY"), "sk_case_sensitive");
  assertEquals(env.get("stripe_key"), undefined);
  assertEquals(env.get("Stripe_Key"), undefined);
});

// ============================================================================
// AC3 & Integration: Warm Isolate Rotation (PLAT-15, FN-6)
// ============================================================================

Deno.test("AC3 — Rotation on warm isolate: updating secret between invocations reads new value without redeploy", async () => {
  // spec: docs/contracts/platform.contract.md#PLAT-15 — Resolved at invocation time, never baked into artifact
  // spec: docs/contracts/functions.contract.md#FN-6 — Bindings re-injected on every invocation
  const store = createStore();
  const orgId = "org_rotate";
  const projectId = "proj_rotate";

  // 1. Initial secret value configured before Invocation 1
  await store.set(orgId, projectId, "API_TOKEN", "initial_secret_value_v1");

  const injector = new SecretInjector();

  // Invocation 1 on isolate
  const env1 = await injector.resolveEnvBinding(
    orgId,
    projectId,
    ["API_TOKEN"],
    store,
  );
  assertEquals(env1.get("API_TOKEN"), "initial_secret_value_v1");

  // 2. Secret rotated out-of-band in SecretStore (no code redeployment)
  await store.set(orgId, projectId, "API_TOKEN", "rotated_secret_value_v2");

  // Invocation 2 on the same warm isolate (re-injects bindings per FN-6)
  const env2 = await injector.resolveEnvBinding(
    orgId,
    projectId,
    ["API_TOKEN"],
    store,
  );

  // Verifies the second invocation immediately observes the new value
  assertEquals(env2.get("API_TOKEN"), "rotated_secret_value_v2");
  assertNotEquals(env1.get("API_TOKEN"), env2.get("API_TOKEN"));
});

Deno.test("AC3 — Secret deletion between invocations causes subsequent invocation to read undefined", async () => {
  // spec: docs/contracts/platform.contract.md#PLAT-15 — Dynamic invocation-time resolution
  // spec: docs/contracts/functions.contract.md#FN-6 — Fresh bindings per invocation
  const store = createStore();
  const orgId = "org_del";
  const projectId = "proj_del";
  await store.set(orgId, projectId, "REVOKED_TOKEN", "token_to_be_revoked");

  const injector = new SecretInjector();

  // Invocation 1
  const env1 = await injector.resolveEnvBinding(
    orgId,
    projectId,
    ["REVOKED_TOKEN"],
    store,
  );
  assertEquals(env1.get("REVOKED_TOKEN"), "token_to_be_revoked");

  // Secret is deleted/revoked
  await store.delete(orgId, projectId, "REVOKED_TOKEN");

  // Invocation 2
  const env2 = await injector.resolveEnvBinding(
    orgId,
    projectId,
    ["REVOKED_TOKEN"],
    store,
  );
  assertEquals(env2.get("REVOKED_TOKEN"), undefined);
});

// ============================================================================
// Security: Isolation & Adversarial Tests (PLAT-15, PLAT-6, PLAT-7, FN-6)
// ============================================================================

Deno.test("Security — Ambient host environment variables (PATH, HOME) are never leaked via env.get", async () => {
  // spec: docs/contracts/platform.contract.md#PLAT-5 — Never gets host environment
  // spec: docs/contracts/platform.contract.md#PLAT-15 — Undeclared secrets return undefined
  const store = createStore();
  const orgId = "org_sec_host";
  const projectId = "proj_sec_host";

  const injector = new SecretInjector();
  const env = await injector.resolveEnvBinding(
    orgId,
    projectId,
    ["STRIPE_KEY"],
    store,
  );

  // Common ambient host environment variables
  assertEquals(env.get("PATH"), undefined);
  assertEquals(env.get("HOME"), undefined);
  assertEquals(env.get("USER"), undefined);
  assertEquals(env.get("SHELL"), undefined);
  assertEquals(env.get("DENO_DIR"), undefined);
});

Deno.test("Security — Declaring ambient host variable name does not leak host env if not in SecretStore", async () => {
  // spec: docs/contracts/platform.contract.md#PLAT-15 — Resolved from SecretStore, never host environment
  const store = createStore();
  const orgId = "org_sec_leak";
  const projectId = "proj_sec_leak";

  const hostVar = "SYSTEM_SECRET_KEY";
  const envPerm = await Deno.permissions.query({ name: "env" });
  if (envPerm.state === "granted") {
    Deno.env.set(hostVar, "host_secret_cannot_leak");
  }

  try {
    const injector = new SecretInjector();
    // Attacker declares SYSTEM_SECRET_KEY in permissions, hoping to exfiltrate host process env
    const env = await injector.resolveEnvBinding(
      orgId,
      projectId,
      [hostVar],
      store,
    );

    assertEquals(env.get(hostVar), undefined);
  } finally {
    if (envPerm.state === "granted") {
      Deno.env.delete(hostVar);
    }
  }
});

Deno.test("Security — Prototype pollution properties return undefined", async () => {
  // spec: docs/contracts/platform.contract.md#PLAT-15 — Safe key access without prototype pollution
  const store = createStore();
  const orgId = "org_proto";
  const projectId = "proj_proto";

  const injector = new SecretInjector();
  const env = await injector.resolveEnvBinding(orgId, projectId, [], store);

  assertEquals(env.get("__proto__"), undefined);
  assertEquals(env.get("constructor"), undefined);
  assertEquals(env.get("toString"), undefined);
  assertEquals(env.get("valueOf"), undefined);
  assertEquals(env.get("hasOwnProperty"), undefined);
});

Deno.test("Security & Multi-tenancy — Cross-tenant isolation: Org A cannot read Org B secret", async () => {
  // spec: docs/contracts/platform.contract.md#PLAT-7 — Multi-tenancy & data isolation
  // spec: docs/contracts/platform.contract.md#PLAT-15 — Tenant-isolated secret resolution
  const store = createStore();
  const orgA = "org_tenant_a";
  const orgB = "org_tenant_b";
  const proj = "proj_shared_name";

  await store.set(orgA, proj, "SHARED_KEY", "secret_for_org_a_only");
  await store.set(orgB, proj, "SHARED_KEY", "secret_for_org_b_only");
  await store.set(orgB, proj, "ORG_B_PRIVATE", "org_b_super_secret");

  const injector = new SecretInjector();

  // Org A resolution
  const envA = await injector.resolveEnvBinding(
    orgA,
    proj,
    ["SHARED_KEY", "ORG_B_PRIVATE"],
    store,
  );

  assertEquals(envA.get("SHARED_KEY"), "secret_for_org_a_only");
  // Org B private key must return undefined for Org A
  assertEquals(envA.get("ORG_B_PRIVATE"), undefined);

  // Org B resolution
  const envB = await injector.resolveEnvBinding(
    orgB,
    proj,
    ["SHARED_KEY", "ORG_B_PRIVATE"],
    store,
  );
  assertEquals(envB.get("SHARED_KEY"), "secret_for_org_b_only");
  assertEquals(envB.get("ORG_B_PRIVATE"), "org_b_super_secret");
});

Deno.test("Security & FN-6 — Consecutive invocations produce isolated binding instances", async () => {
  // spec: docs/contracts/functions.contract.md#FN-6 — Bindings re-injected every invocation,
  // never trusted to persist across invocations
  const store = createStore();
  const orgId = "org_isolate";
  const projectId = "proj_isolate";
  await store.set(orgId, projectId, "SECRET_A", "val_a");
  await store.set(orgId, projectId, "SECRET_B", "val_b");

  const injector = new SecretInjector();

  // Invocation 1: permissions for SECRET_A
  const env1 = await injector.resolveEnvBinding(
    orgId,
    projectId,
    ["SECRET_A"],
    store,
  );

  // Invocation 2: permissions for SECRET_B
  const env2 = await injector.resolveEnvBinding(
    orgId,
    projectId,
    ["SECRET_B"],
    store,
  );

  // Assert distinct instances and strict isolation
  assertNotEquals(env1, env2);
  assertEquals(env1.get("SECRET_A"), "val_a");
  assertEquals(env1.get("SECRET_B"), undefined);

  assertEquals(env2.get("SECRET_A"), undefined);
  assertEquals(env2.get("SECRET_B"), "val_b");
});

// ============================================================================
// Input Validation & Error Model (PLAT-12, PLAT-7)
// ============================================================================

Deno.test("Validation — Invalid or empty orgId throws ValidationFailedError", async () => {
  // spec: docs/contracts/platform.contract.md#PLAT-12 — ValidationFailedError on invalid identifiers
  const store = createStore();
  const injector = new SecretInjector();

  await assertRejects(
    async () => {
      await injector.resolveEnvBinding("", "proj1", ["KEY"], store);
    },
    ValidationFailedError,
  );

  await assertRejects(
    async () => {
      await injector.resolveEnvBinding("org/invalid", "proj1", ["KEY"], store);
    },
    ValidationFailedError,
  );

  await assertRejects(
    async () => {
      await injector.resolveEnvBinding("../traversal", "proj1", ["KEY"], store);
    },
    ValidationFailedError,
  );
});

Deno.test("Validation — Invalid or empty projectId throws ValidationFailedError", async () => {
  // spec: docs/contracts/platform.contract.md#PLAT-12 — ValidationFailedError on invalid identifiers
  const store = createStore();
  const injector = new SecretInjector();

  await assertRejects(
    async () => {
      await injector.resolveEnvBinding("org1", "", ["KEY"], store);
    },
    ValidationFailedError,
  );

  await assertRejects(
    async () => {
      await injector.resolveEnvBinding("org1", "proj\\invalid", ["KEY"], store);
    },
    ValidationFailedError,
  );
});

Deno.test("Validation — Null or undefined secretStore throws ValidationFailedError", async () => {
  // spec: docs/contracts/platform.contract.md#PLAT-12 — ValidationFailedError
  const injector = new SecretInjector();

  await assertRejects(
    async () => {
      // deno-lint-ignore no-explicit-any
      await injector.resolveEnvBinding("org1", "proj1", ["KEY"], null as any);
    },
    ValidationFailedError,
  );
});
