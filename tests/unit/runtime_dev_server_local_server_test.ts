/**
 * Integration tests for `rail dev` local server wiring / end-to-end loop.
 *
 * Spec references:
 * - FN-8: Request lifecycle (route -> cached permissions -> isolate -> fresh ctx -> handler -> response + request_id)
 * - FN-6: Isolation & warm-reuse rule (separate context and scoped bindings per invocation)
 * - PLAT-2: Everything is Trigger -> Function
 * - PLAT-11: Routing specificity algorithm
 * - PLAT-12: Error model (exhaustive codes, HTTPS + JSON, request_id in body & header)
 * - PLAT-14: ULID format for request_id
 * - PLAT-17: Local/production parity (real SQLite and LocalFS providers, zero cloud account)
 * - docs/contracts/worked-example.md: Canonical end-to-end /upload flow
 * - tasks/milestone-0.1-runtime-prototype/T-0111-local-dev-server.md
 */

import {
  assert,
  assertEquals,
  assertNotEquals,
  assertRejects,
} from "@std/assert";
import { join, resolve, toFileUrl } from "@std/path";
import { isValidUlid } from "../../packages/core/id/ulid.ts";
import {
  type LocalServer,
  type LocalServerOptions,
  type RailfogConfig,
  startLocalServer,
} from "../../runtime/dev-server/local-server.ts";

const WORKED_EXAMPLE_TOML = `name = "upload-demo"

[functions.api]
entry = "functions/api.ts"
[functions.api.permissions]
objects = ["app:uploads"]
queues  = ["app:jobs"]

[[routes]]
pattern = "/upload"
function = "api"
`;

const workedExampleConfig: RailfogConfig = {
  name: "upload-demo",
  functions: {
    api: {
      entry: "functions/api.ts",
      permissions: {
        objects: ["app:uploads"],
        queues: ["app:jobs"],
      },
    },
  },
  routes: [
    {
      pattern: "/upload",
      function: "api",
    },
  ],
};

function getResponseRequestId(res: Response): string | null {
  return res.headers.get("x-request-id") ?? res.headers.get("request-id");
}

function getServerPort(server: LocalServer): number {
  const port = server.port ??
    (server as unknown as { addr: { port: number } }).addr?.port;
  assert(
    typeof port === "number" && port > 0,
    `Expected server port to be a positive integer, got: ${port}`,
  );
  return port;
}

// ============================================================================
// Acceptance Criterion 1: Worked-example /upload route with real providers
// ============================================================================

Deno.test(
  "AC1: POST /upload runs handler with real objects/queues bindings and returns uploadUrl, queue messageId, and valid ULID request_id",
  async () => {
    const tempDir = await Deno.makeTempDir({ prefix: "railfog-ac1-" });
    let server: LocalServer | null = null;

    try {
      // Set up project files: railfog.toml and functions/api.ts
      await Deno.writeTextFile(
        join(tempDir, "railfog.toml"),
        WORKED_EXAMPLE_TOML,
      );
      const functionsDir = join(tempDir, "functions");
      await Deno.mkdir(functionsDir, { recursive: true });

      // Handler exercises real ctx.objects.presign (OBJ-2) and ctx.queues.send (Q-2)
      const apiCode = `
export default async function handler(req: Request, ctx: any) {
  const key = crypto.randomUUID();
  const { url } = await ctx.objects.presign(key, { method: "PUT" });
  const sendResult = await ctx.queues.send({ key, uploadedAt: Date.now() });
  return Response.json({
    uploadUrl: url,
    key,
    messageId: sendResult.id,
  });
}
`;
      await Deno.writeTextFile(join(functionsDir, "api.ts"), apiCode);

      // Start local server with dynamic port (0) and cwd pointing to tempDir
      const options: LocalServerOptions = { cwd: tempDir };
      server = await startLocalServer(workedExampleConfig, 0, options);
      const port = getServerPort(server);

      // Send POST request to /upload
      const res = await fetch(`http://localhost:${port}/upload`, {
        method: "POST",
      });

      // Verify HTTP status 200
      assertEquals(res.status, 200, "Expected HTTP 200 response from /upload");

      // Verify header x-request-id (or request-id) is present and is a valid ULID (FN-8, PLAT-14)
      const requestIdHeader = getResponseRequestId(res);
      assert(
        requestIdHeader !== null,
        "Response must include x-request-id or request-id header",
      );
      assert(
        isValidUlid(requestIdHeader),
        `Header request_id must be a valid ULID per PLAT-14, got: "${requestIdHeader}"`,
      );

      // Verify JSON response body contains uploadUrl and messageId
      const body = await res.json();
      assert(
        typeof body.uploadUrl === "string" && body.uploadUrl.length > 0,
        "Response body must contain non-empty uploadUrl",
      );
      assert(
        body.uploadUrl.includes("http://") ||
          body.uploadUrl.includes("https://"),
        `uploadUrl must be an HTTP(S) URL, got: "${body.uploadUrl}"`,
      );
      assert(
        typeof body.messageId === "string" && body.messageId.length > 0,
        "Response body must contain non-empty queue messageId",
      );
      assert(
        isValidUlid(body.messageId),
        `Queue messageId must be a valid ULID per Q-2, got: "${body.messageId}"`,
      );
      assert(
        typeof body.key === "string" && body.key.length > 0,
        "Response body must contain object key",
      );
    } finally {
      if (server) {
        await server.close();
      }
      await Deno.remove(tempDir, { recursive: true });
    }
  },
);

// ============================================================================
// Acceptance Criterion 2: FN-6 Warm Reuse & Context Isolation at Integration Level
// ============================================================================

Deno.test(
  "AC2 (FN-6): two sequential requests to the same route receive distinct requestIds and separate context instances",
  async () => {
    const tempDir = await Deno.makeTempDir({ prefix: "railfog-ac2-" });
    let server: LocalServer | null = null;

    try {
      await Deno.writeTextFile(
        join(tempDir, "railfog.toml"),
        WORKED_EXAMPLE_TOML,
      );
      const functionsDir = join(tempDir, "functions");
      await Deno.mkdir(functionsDir, { recursive: true });

      // Handler tracks module-level references across invocations in the warm isolate
      // to verify fresh context and fresh bindings per FN-6
      const apiCode = `
let previousContext = null;
let previousObjects = null;
let previousQueues = null;

export default async function handler(req: Request, ctx: any) {
  const isSameContext = previousContext !== null && previousContext === ctx;
  const isSameObjects = previousObjects !== null && previousObjects === ctx.objects;
  const isSameQueues = previousQueues !== null && previousQueues === ctx.queues;

  previousContext = ctx;
  previousObjects = ctx.objects;
  previousQueues = ctx.queues;

  const key = crypto.randomUUID();
  const presignResult = await ctx.objects.presign(key, { method: "PUT" });
  const queueResult = await ctx.queues.send({ key, step: "check-fn6" });

  return Response.json({
    requestId: ctx.requestId,
    isSameContext,
    isSameObjects,
    isSameQueues,
    uploadUrl: presignResult.url,
    messageId: queueResult.id,
  });
}
`;
      await Deno.writeTextFile(join(functionsDir, "api.ts"), apiCode);

      server = await startLocalServer(workedExampleConfig, 0, { cwd: tempDir });
      const port = getServerPort(server);

      // Invocation 1
      const res1 = await fetch(`http://localhost:${port}/upload`, {
        method: "POST",
      });
      assertEquals(res1.status, 200, "Request 1 must succeed with 200");
      const reqIdHeader1 = getResponseRequestId(res1);
      assert(reqIdHeader1 !== null, "Request 1 must include request-id header");
      assert(
        isValidUlid(reqIdHeader1),
        "Request 1 header must be a valid ULID",
      );

      const body1 = await res1.json();
      assertEquals(
        body1.requestId,
        reqIdHeader1,
        "Request 1 body requestId must match header",
      );
      assertEquals(
        body1.isSameContext,
        false,
        "Request 1 is first invocation, cannot be same context",
      );

      // Invocation 2 (sequential to same route)
      const res2 = await fetch(`http://localhost:${port}/upload`, {
        method: "POST",
      });
      assertEquals(res2.status, 200, "Request 2 must succeed with 200");
      const reqIdHeader2 = getResponseRequestId(res2);
      assert(reqIdHeader2 !== null, "Request 2 must include request-id header");
      assert(
        isValidUlid(reqIdHeader2),
        "Request 2 header must be a valid ULID",
      );

      const body2 = await res2.json();
      assertEquals(
        body2.requestId,
        reqIdHeader2,
        "Request 2 body requestId must match header",
      );

      // Verification 1: Request IDs must be distinct across invocations (FN-4, FN-8, PLAT-14)
      assertNotEquals(
        reqIdHeader1,
        reqIdHeader2,
        "Sequential requests must receive distinct request IDs in headers",
      );
      assertNotEquals(
        body1.requestId,
        body2.requestId,
        "Context requestId must differ between invocations",
      );

      // Verification 2: Context instance must be fresh, not identical reference (FN-6)
      assertEquals(
        body2.isSameContext,
        false,
        "FN-6 violation: second request reused previous context instance",
      );

      // Verification 3: Scoped bindings must be re-injected, not identical references (FN-6)
      assertEquals(
        body2.isSameObjects,
        false,
        "FN-6 violation: second request reused previous objects binding instance",
      );
      assertEquals(
        body2.isSameQueues,
        false,
        "FN-6 violation: second request reused previous queues binding instance",
      );
    } finally {
      if (server) {
        await server.close();
      }
      await Deno.remove(tempDir, { recursive: true });
    }
  },
);

// ============================================================================
// Acceptance Criterion 3: PLAT-12 RESOURCE_NOT_FOUND on Unmatched Path
// ============================================================================

Deno.test(
  "AC3 (PLAT-12): request to unmatched path returns HTTP 404 with RESOURCE_NOT_FOUND error shape and matching request_id",
  async () => {
    const tempDir = await Deno.makeTempDir({ prefix: "railfog-ac3-" });
    let server: LocalServer | null = null;

    try {
      await Deno.writeTextFile(
        join(tempDir, "railfog.toml"),
        WORKED_EXAMPLE_TOML,
      );
      const functionsDir = join(tempDir, "functions");
      await Deno.mkdir(functionsDir, { recursive: true });

      const apiCode = `
export default async function handler(_req: Request, _ctx: any) {
  return new Response("OK");
}
`;
      await Deno.writeTextFile(join(functionsDir, "api.ts"), apiCode);

      server = await startLocalServer(workedExampleConfig, 0, { cwd: tempDir });
      const port = getServerPort(server);

      // Request an unmatched route
      const res = await fetch(`http://localhost:${port}/no-such-route`);

      // Verify HTTP status 404
      assertEquals(
        res.status,
        404,
        "Unmatched route must return HTTP 404",
      );

      // Verify response header carries request_id (PLAT-12, PLAT-14)
      const requestIdHeader = getResponseRequestId(res);
      assert(
        requestIdHeader !== null,
        "404 response must include x-request-id or request-id header",
      );
      assert(
        isValidUlid(requestIdHeader),
        `404 response header request_id must be valid ULID, got: "${requestIdHeader}"`,
      );

      // Verify PLAT-12 error body shape: { error: { code, message, request_id } }
      const body = await res.json();
      assert(
        body && typeof body === "object" && body.error &&
          typeof body.error === "object",
        "Response body must have standard PLAT-12 structure: { error: { ... } }",
      );
      assertEquals(
        body.error.code,
        "RESOURCE_NOT_FOUND",
        "Error code must be RESOURCE_NOT_FOUND per PLAT-12",
      );
      assert(
        typeof body.error.message === "string" && body.error.message.length > 0,
        "Error body must include a non-empty descriptive message",
      );
      assertEquals(
        body.error.request_id,
        requestIdHeader,
        "body.error.request_id must match HTTP response request-id header exactly",
      );
    } finally {
      if (server) {
        await server.close();
      }
      await Deno.remove(tempDir, { recursive: true });
    }
  },
);

// ============================================================================
// Lifecycle: server.close() cleanup
// ============================================================================

Deno.test(
  "Lifecycle: server.close() shuts down server and refuses subsequent connections",
  async () => {
    const tempDir = await Deno.makeTempDir({ prefix: "railfog-lifecycle-" });
    let server: LocalServer | null = null;

    try {
      await Deno.writeTextFile(
        join(tempDir, "railfog.toml"),
        WORKED_EXAMPLE_TOML,
      );
      const functionsDir = join(tempDir, "functions");
      await Deno.mkdir(functionsDir, { recursive: true });
      await Deno.writeTextFile(
        join(functionsDir, "api.ts"),
        `export default async function handler() { return new Response("pong"); }`,
      );

      server = await startLocalServer(workedExampleConfig, 0, { cwd: tempDir });
      const port = getServerPort(server);

      // Verify server is accepting connections
      const initialRes = await fetch(`http://localhost:${port}/upload`);
      assertEquals(initialRes.status, 200);

      // Close the server
      await server.close();
      server = null;

      // Connections after close should fail
      await assertRejects(
        async () => {
          await fetch(`http://localhost:${port}/upload`, {
            // On Windows, connection refused on localhost takes ~2.1s of TCP SYN retransmit before TypeError is thrown
            signal: AbortSignal.timeout(3500),
          });
        },
        TypeError, // fetch throws TypeError on connection refused
      );
    } finally {
      if (server) {
        await server.close();
      }
      await Deno.remove(tempDir, { recursive: true });
    }
  },
);

// ============================================================================
// Error Handling: PLAT-12 compliance during invocation exceptions
// ============================================================================

Deno.test(
  "Error handling: handler throwing RailFogError returns mapped status and PLAT-12 body with request_id",
  async () => {
    const tempDir = await Deno.makeTempDir({ prefix: "railfog-err-railfog-" });
    let server: LocalServer | null = null;

    try {
      const config: RailfogConfig = {
        name: "error-test-app",
        functions: {
          faulty: {
            entry: "functions/faulty.ts",
          },
        },
        routes: [{ pattern: "/fail", function: "faulty" }],
      };

      const functionsDir = join(tempDir, "functions");
      await Deno.mkdir(functionsDir, { recursive: true });
      const errorsModUrl = toFileUrl(resolve("packages/errors/mod.ts")).href;
      await Deno.writeTextFile(
        join(functionsDir, "faulty.ts"),
        `import { ValidationFailedError } from "${errorsModUrl}";
export default async function handler() {
  throw new ValidationFailedError("Invalid user input provided");
}`,
      );

      server = await startLocalServer(config, 0, { cwd: tempDir });
      const port = getServerPort(server);

      const res = await fetch(`http://localhost:${port}/fail`);
      assertEquals(
        res.status,
        400,
        "ValidationFailedError must map to HTTP 400",
      );

      const headerId = getResponseRequestId(res);
      assert(headerId !== null, "Response must carry request_id header");
      assert(isValidUlid(headerId), "request_id must be valid ULID");

      const body = await res.json();
      assertEquals(body.error.code, "VALIDATION_FAILED");
      assertEquals(body.error.message, "Invalid user input provided");
      assertEquals(body.error.request_id, headerId);
    } finally {
      if (server) {
        await server.close();
      }
      await Deno.remove(tempDir, { recursive: true });
    }
  },
);

Deno.test(
  "Error handling: handler throwing unexpected Error returns 500 INTERNAL and PLAT-12 body with request_id",
  async () => {
    const tempDir = await Deno.makeTempDir({ prefix: "railfog-err-internal-" });
    let server: LocalServer | null = null;

    try {
      const config: RailfogConfig = {
        name: "error-test-app",
        functions: {
          crash: {
            entry: "functions/crash.ts",
          },
        },
        routes: [{ pattern: "/crash", function: "crash" }],
      };

      const functionsDir = join(tempDir, "functions");
      await Deno.mkdir(functionsDir, { recursive: true });
      await Deno.writeTextFile(
        join(functionsDir, "crash.ts"),
        `export default async function handler() {
  throw new Error("Simulated database failure");
}`,
      );

      server = await startLocalServer(config, 0, { cwd: tempDir });
      const port = getServerPort(server);

      const res = await fetch(`http://localhost:${port}/crash`);
      assertEquals(res.status, 500, "Generic Error must map to HTTP 500");

      const headerId = getResponseRequestId(res);
      assert(headerId !== null, "Response must carry request_id header");
      assert(isValidUlid(headerId), "request_id must be valid ULID");

      const body = await res.json();
      assertEquals(body.error.code, "INTERNAL");
      assertEquals(body.error.message, "Simulated database failure");
      assertEquals(body.error.request_id, headerId);
    } finally {
      if (server) {
        await server.close();
      }
      await Deno.remove(tempDir, { recursive: true });
    }
  },
);

Deno.test(
  "Error handling: route targeting undeclared function returns 404 RESOURCE_NOT_FOUND",
  async () => {
    const tempDir = await Deno.makeTempDir({ prefix: "railfog-err-target-" });
    let server: LocalServer | null = null;

    try {
      const config: RailfogConfig = {
        name: "error-test-app",
        functions: {},
        routes: [{ pattern: "/missing-target", function: "non_existent" }],
      };

      server = await startLocalServer(config, 0, { cwd: tempDir });
      const port = getServerPort(server);

      const res = await fetch(`http://localhost:${port}/missing-target`);
      assertEquals(
        res.status,
        404,
        "Undeclared target function must map to HTTP 404",
      );

      const headerId = getResponseRequestId(res);
      assert(headerId !== null, "Response must carry request_id header");

      const body = await res.json();
      assertEquals(body.error.code, "RESOURCE_NOT_FOUND");
      assertEquals(body.error.request_id, headerId);
    } finally {
      if (server) {
        await server.close();
      }
      await Deno.remove(tempDir, { recursive: true });
    }
  },
);

Deno.test(
  "Error handling: missing function entry file returns 400 VALIDATION_FAILED with PLAT-12 body",
  async () => {
    const tempDir = await Deno.makeTempDir({ prefix: "railfog-err-entry-" });
    let server: LocalServer | null = null;

    try {
      const config: RailfogConfig = {
        name: "error-test-app",
        functions: {
          ghost: {
            entry: "functions/does_not_exist.ts",
          },
        },
        routes: [{ pattern: "/ghost", function: "ghost" }],
      };

      server = await startLocalServer(config, 0, { cwd: tempDir });
      const port = getServerPort(server);

      const res = await fetch(`http://localhost:${port}/ghost`);
      assertEquals(
        res.status,
        400,
        "Missing function entry file must return HTTP 400",
      );

      const headerId = getResponseRequestId(res);
      assert(headerId !== null, "Response must carry request_id header");

      const body = await res.json();
      assertEquals(body.error.code, "VALIDATION_FAILED");
      assertEquals(body.error.request_id, headerId);
    } finally {
      if (server) {
        await server.close();
      }
      await Deno.remove(tempDir, { recursive: true });
    }
  },
);
