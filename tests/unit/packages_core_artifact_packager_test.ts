import { assertEquals, assertRejects } from "@std/assert";
import {
  type Manifest,
  type PackagedArtifact,
  packageFunctionArtifact,
} from "../../packages/core/artifact/packager.ts";
import { ValidationFailedError } from "../../packages/errors/mod.ts";
import { computeIntegrity } from "../../packages/core/crypto/content-address.ts";

/**
 * Task T-0202: Deployment artifact packaging tests
 * Spec references: PLAT-3, OBJ-4, FN-5
 */

Deno.test("Unit: AC1 & AC2 - packageFunctionArtifact calculates OBJ-4 hashes and injects FN-5 default limits", async () => {
  const code = new TextEncoder().encode(
    'export default function(ctx) { return new Response("ok"); }',
  );
  const entrypoint = "api.ts";

  const artifact: PackagedArtifact = await packageFunctionArtifact(
    entrypoint,
    code,
  );

  // AC1: id and integrity per OBJ-4
  assertEquals(
    /^sha256:[0-9a-f]{64}$/.test(artifact.id),
    true,
    `Expected id to match sha256 hex format, got ${artifact.id}`,
  );
  assertEquals(
    /^sha256-[A-Za-z0-9+/=]+$/.test(artifact.integrity),
    true,
    `Expected integrity to match sha256 base64 format, got ${artifact.integrity}`,
  );

  // Manifest matching PLAT-3
  const manifest: Manifest = artifact.manifest;
  assertEquals(manifest.runtime, "railfog-deno");
  assertEquals(manifest.runtimeVersion, "1.0");
  assertEquals(manifest.entrypoint, "api.ts");
  assertEquals(manifest.integrity, artifact.integrity);

  // AC2: FN-5 default limits when omitted
  assertEquals(manifest.limits, {
    cpu_ms: 200,
    timeout_ms: 30000,
    memory_mb: 128,
  });

  assertEquals(manifest.permissions, {});
  assertEquals(manifest.dependencies, {});
  assertEquals(artifact.bytes, code);
});

Deno.test("Unit: Custom permissions, custom limits, and AC4 lockfile dependencies", async () => {
  const code = new TextEncoder().encode("console.log('test');");
  const lockfile = new TextEncoder().encode('{"version": "3"}');
  const expectedLockfileHash = await computeIntegrity(lockfile);

  const artifact = await packageFunctionArtifact("main.ts", code, {
    permissions: {
      kv: ["app:sessions"],
      objects: ["app:uploads"],
    },
    limits: {
      cpu_ms: 500,
      timeout_ms: 60000,
      memory_mb: 256,
    },
    lockfileBytes: lockfile,
  });

  assertEquals(artifact.manifest.permissions, {
    kv: ["app:sessions"],
    objects: ["app:uploads"],
  });
  assertEquals(artifact.manifest.limits, {
    cpu_ms: 500,
    timeout_ms: 60000,
    memory_mb: 256,
  });
  // AC4: dependencies.lockfile contains SHA-256 hash of lockfile per PLAT-3
  assertEquals(artifact.manifest.dependencies.lockfile, expectedLockfileHash);
});

Deno.test("Unit: AC3 - Validation errors for empty code or whitespace entrypoint", async () => {
  const validCode = new TextEncoder().encode("export default () => {};");

  // Empty entrypoint
  await assertRejects(
    async () => {
      await packageFunctionArtifact("", validCode);
    },
    ValidationFailedError,
    "VALIDATION_FAILED",
  );

  // Whitespace-only entrypoint
  await assertRejects(
    async () => {
      await packageFunctionArtifact("   \t\n  ", validCode);
    },
    ValidationFailedError,
    "VALIDATION_FAILED",
  );

  // Empty code bytes
  await assertRejects(
    async () => {
      await packageFunctionArtifact("api.ts", new Uint8Array(0));
    },
    ValidationFailedError,
    "VALIDATION_FAILED",
  );

  // Invalid limit numbers (non-positive)
  await assertRejects(
    async () => {
      await packageFunctionArtifact("api.ts", validCode, {
        limits: { cpu_ms: 0 },
      });
    },
    ValidationFailedError,
    "VALIDATION_FAILED",
  );

  await assertRejects(
    async () => {
      await packageFunctionArtifact("api.ts", validCode, {
        limits: { timeout_ms: -10 },
      });
    },
    ValidationFailedError,
    "VALIDATION_FAILED",
  );

  await assertRejects(
    async () => {
      await packageFunctionArtifact("api.ts", validCode, {
        limits: { memory_mb: -5 },
      });
    },
    ValidationFailedError,
    "VALIDATION_FAILED",
  );
});

Deno.test("Integration: Package starter function fixture and verify uncorrupted byte extraction", async () => {
  const fixturePath = "tests/fixtures/functions/valid_function.ts";
  const fixtureBytes = await Deno.readFile(fixturePath);

  const packaged = await packageFunctionArtifact(
    "valid_function.ts",
    fixtureBytes,
    {
      permissions: { kv: ["app:state"] },
    },
  );

  // Verify byte extraction is uncorrupted
  assertEquals(packaged.bytes, fixtureBytes);
  const decoded = new TextDecoder().decode(packaged.bytes);
  assertEquals(decoded, new TextDecoder().decode(fixtureBytes));
  assertEquals(decoded.includes("RailFogContext"), true);

  // Verify manifest integrity
  const expectedIntegrity = await computeIntegrity(fixtureBytes);
  assertEquals(packaged.manifest.integrity, expectedIntegrity);
  assertEquals(packaged.integrity, expectedIntegrity);
});
