/**
 * Integration tests for RailFog Ingress Reverse Proxy Gateway Server.
 *
 * Spec references:
 * - contracts/platform.contract.md#PLAT-1: Control plane vs data plane routing.
 * - contracts/platform.contract.md#PLAT-8: Fail-static data plane (zero control-plane roundtrips on request path).
 * - contracts/platform.contract.md#PLAT-9: Multi-tenant token bucket rate limiting (429 RATE_LIMITED, Retry-After).
 * - contracts/platform.contract.md#PLAT-11: Routing specificity algorithm.
 * - contracts/platform.contract.md#PLAT-12: Canonical error model (RATE_LIMITED, UNAVAILABLE).
 * - contracts/platform.contract.md#PLAT-14: ULID request_id generation and propagation.
 * - contracts/platform.contract.md#PLAT-19: apps/gateway repository structure.
 * - tasks/milestone-0.6-public-beta/T-0604-ingress-gateway-server.md: AC1 - AC5.
 */

import { assert, assertEquals, assertExists, assertRejects } from "@std/assert";
import type {
  GatewayOptions,
  GatewayServer,
} from "../../apps/gateway/gateway-server.ts";
import { startGatewayServer } from "../../apps/gateway/gateway-server.ts";
import { MultiTenantRateLimiter } from "../../apps/gateway/rate-limiter.ts";
import { isValidUlid } from "../../packages/core/id/ulid.ts";

// ============================================================================
// Constants & Test Fixtures
// ============================================================================

/**
 * Standard HTTP status codes used in assertions.
 * spec: contracts/platform.contract.md#PLAT-12
 */
const HTTP_STATUS_OK = 200;
const HTTP_STATUS_CREATED = 201;
const HTTP_STATUS_RATE_LIMITED = 429;
const HTTP_STATUS_UNAVAILABLE = 503;

/**
 * Canonical error codes per PLAT-12.
 * spec: contracts/platform.contract.md#PLAT-12
 */
const ERROR_CODE_RATE_LIMITED = "RATE_LIMITED";
const ERROR_CODE_UNAVAILABLE = "UNAVAILABLE";

/**
 * Token bucket test parameters configured to trigger burst exhaustion on 3rd request.
 * spec: contracts/platform.contract.md#PLAT-9
 */
const TEST_BURST_CAPACITY = 2;
const TEST_REFILL_RATE = 1;

/**
 * Record of an incoming request captured by mock upstream backends.
 */
interface RecordedRequest {
  method: string;
  url: string;
  pathname: string;
  search: string;
  headers: Headers;
  body: string;
}

/**
 * Test mock HTTP backend server recording all received requests.
 */
interface MockBackendServer {
  url: string;
  port: number;
  requests: RecordedRequest[];
  close: () => Promise<void>;
}

/**
 * Spawns an in-memory HTTP server on dynamic port 0 to simulate control plane or data plane.
 */
function createMockBackend(
  handler?: (
    req: Request,
    recorded: RecordedRequest,
  ) => Promise<Response> | Response,
): MockBackendServer {
  const requests: RecordedRequest[] = [];
  const server = Deno.serve(
    { port: 0, onListen: () => {} },
    async (req: Request) => {
      const parsedUrl = new URL(req.url);
      const body = await req.text();
      const recorded: RecordedRequest = {
        method: req.method,
        url: req.url,
        pathname: parsedUrl.pathname,
        search: parsedUrl.search,
        headers: new Headers(req.headers),
        body,
      };
      requests.push(recorded);

      if (handler) {
        return await handler(req, recorded);
      }

      return new Response(
        JSON.stringify({ ok: true, echoPath: parsedUrl.pathname }),
        {
          status: HTTP_STATUS_OK,
          headers: { "content-type": "application/json" },
        },
      );
    },
  );

  const port = (server.addr as Deno.NetAddr).port;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    requests,
    close: () => server.shutdown(),
  };
}

/**
 * Acquires a dynamic port and immediately closes it to simulate an unreachable upstream.
 */
async function createUnreachableUrl(): Promise<string> {
  const server = Deno.serve(
    { port: 0, onListen: () => {} },
    () => new Response("ok"),
  );
  const port = (server.addr as Deno.NetAddr).port;
  await server.shutdown();
  return `http://127.0.0.1:${port}`;
}

// ============================================================================
// AC1: Management Route Routing (/v1/*) to Control Plane (PLAT-1)
// ============================================================================

Deno.test(
  "PLAT-1 (AC1): forwards GET /v1/projects with query params and headers to control plane",
  async () => {
    // spec: contracts/platform.contract.md#PLAT-1 — /v1/* routes directly to control plane
    const mockControlPlane = createMockBackend();
    const mockDataPlane = createMockBackend();
    let gateway: GatewayServer | undefined;

    try {
      const options: GatewayOptions = {
        port: 0,
        controlPlaneUrl: mockControlPlane.url,
        dataPlaneUrl: mockDataPlane.url,
      };
      gateway = await startGatewayServer(options);

      const response = await fetch(
        `http://127.0.0.1:${gateway.port}/v1/projects?limit=10&page=2`,
        {
          method: "GET",
          headers: {
            "authorization": "Bearer admin-token",
            "x-custom-tenant-header": "tenant-xyz",
          },
        },
      );

      assertEquals(response.status, HTTP_STATUS_OK);
      const json = await response.json();
      assertEquals(json.ok, true);

      // Verify control plane received the exact request with query parameters and headers intact
      assertEquals(mockControlPlane.requests.length, 1);
      const cpReq = mockControlPlane.requests[0];
      assertEquals(cpReq.method, "GET");
      assertEquals(cpReq.pathname, "/v1/projects");
      assertEquals(cpReq.search, "?limit=10&page=2");
      assertEquals(cpReq.headers.get("authorization"), "Bearer admin-token");
      assertEquals(cpReq.headers.get("x-custom-tenant-header"), "tenant-xyz");

      // Verify data plane received zero requests
      assertEquals(mockDataPlane.requests.length, 0);
    } finally {
      await gateway?.close();
      await mockControlPlane.close();
      await mockDataPlane.close();
    }
  },
);

Deno.test(
  "PLAT-1 (AC1): forwards POST /v1/deploy with streaming body and headers to control plane",
  async () => {
    // spec: contracts/platform.contract.md#PLAT-1 — deploy payloads route to control plane
    const mockControlPlane = createMockBackend((_req, recorded) => {
      return new Response(
        JSON.stringify({ deployed: true, received: recorded.body }),
        {
          status: HTTP_STATUS_CREATED,
          headers: {
            "content-type": "application/json",
            "x-deployment-id": "dep_01J8Z9",
          },
        },
      );
    });
    const mockDataPlane = createMockBackend();
    let gateway: GatewayServer | undefined;

    try {
      gateway = await startGatewayServer({
        port: 0,
        controlPlaneUrl: mockControlPlane.url,
        dataPlaneUrl: mockDataPlane.url,
      });

      const payload = JSON.stringify({
        project: "proj_01J8Z9",
        entrypoint: "main.ts",
        runtime: "railfog-deno",
      });

      const response = await fetch(
        `http://127.0.0.1:${gateway.port}/v1/deploy`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "authorization": "Bearer deploy-token",
          },
          body: payload,
        },
      );

      assertEquals(response.status, HTTP_STATUS_CREATED);
      assertEquals(response.headers.get("x-deployment-id"), "dep_01J8Z9");
      const json = await response.json();
      assertEquals(json.deployed, true);
      assertEquals(json.received, payload);

      // Verify control plane received the POST request with intact body
      assertEquals(mockControlPlane.requests.length, 1);
      const cpReq = mockControlPlane.requests[0];
      assertEquals(cpReq.method, "POST");
      assertEquals(cpReq.pathname, "/v1/deploy");
      assertEquals(cpReq.body, payload);
      assertEquals(cpReq.headers.get("authorization"), "Bearer deploy-token");

      // Verify data plane received zero requests
      assertEquals(mockDataPlane.requests.length, 0);
    } finally {
      await gateway?.close();
      await mockControlPlane.close();
      await mockDataPlane.close();
    }
  },
);

Deno.test(
  "PLAT-1: forwards /login and /deploy routes directly to control plane",
  async () => {
    const mockControlPlane = createMockBackend(
      (_req, rec) =>
        new Response(
          JSON.stringify({ target: "control", path: rec.pathname }),
          { headers: { "content-type": "application/json" } },
        ),
    );
    const mockDataPlane = createMockBackend();
    let gateway: GatewayServer | undefined;

    try {
      const options: GatewayOptions = {
        port: 0,
        controlPlaneUrl: mockControlPlane.url,
        dataPlaneUrl: mockDataPlane.url,
      };
      gateway = await startGatewayServer(options);

      const res = await fetch(
        `http://127.0.0.1:${gateway.port}/login?callback=http%3A%2F%2F127.0.0.1%3A4840%2Fcallback`,
      );
      assertEquals(res.status, HTTP_STATUS_OK);
      const json = await res.json();
      assertEquals(json.target, "control");
      assertEquals(json.path, "/login");

      assertEquals(mockControlPlane.requests.length, 1);
      assertEquals(mockDataPlane.requests.length, 0);
    } finally {
      await gateway?.close();
      await mockControlPlane.close();
      await mockDataPlane.close();
    }
  },
);

Deno.test(
  "PLAT-1 (AC1): streams chunked response body from control plane back to client intact",
  async () => {
    // spec: contracts/platform.contract.md#PLAT-1 — streaming payload body preservation
    const chunk1 = "event: progress\ndata: step 1\n\n";
    const chunk2 = "event: progress\ndata: step 2\n\n";
    const chunk3 = "event: complete\ndata: done\n\n";

    const mockControlPlane = createMockBackend(() => {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(chunk1));
          controller.enqueue(new TextEncoder().encode(chunk2));
          controller.enqueue(new TextEncoder().encode(chunk3));
          controller.close();
        },
      });
      return new Response(stream, {
        status: HTTP_STATUS_OK,
        headers: {
          "content-type": "text/event-stream",
          "x-stream-mode": "chunked-transfer",
        },
      });
    });
    const mockDataPlane = createMockBackend();
    let gateway: GatewayServer | undefined;

    try {
      gateway = await startGatewayServer({
        port: 0,
        controlPlaneUrl: mockControlPlane.url,
        dataPlaneUrl: mockDataPlane.url,
      });

      const response = await fetch(
        `http://127.0.0.1:${gateway.port}/v1/logs/stream`,
      );

      assertEquals(response.status, HTTP_STATUS_OK);
      assertEquals(response.headers.get("x-stream-mode"), "chunked-transfer");
      const fullText = await response.text();
      assertEquals(fullText, chunk1 + chunk2 + chunk3);

      assertEquals(mockControlPlane.requests.length, 1);
      assertEquals(mockDataPlane.requests.length, 0);
    } finally {
      await gateway?.close();
      await mockControlPlane.close();
      await mockDataPlane.close();
    }
  },
);

// ============================================================================
// AC2: Customer Function Route Routing to Data Plane (PLAT-1, PLAT-8)
// ============================================================================

Deno.test(
  "PLAT-1, PLAT-8 (AC2): forwards customer route GET /hello with zero control plane roundtrips",
  async () => {
    // spec: contracts/platform.contract.md#PLAT-8 — data plane routes bypass control plane entirely
    const mockControlPlane = createMockBackend();
    const mockDataPlane = createMockBackend((_req, recorded) => {
      return new Response(
        JSON.stringify({ message: "hello world", path: recorded.pathname }),
        {
          status: HTTP_STATUS_OK,
          headers: {
            "content-type": "application/json",
            "x-powered-by": "railfog-runtime",
          },
        },
      );
    });
    let gateway: GatewayServer | undefined;

    try {
      gateway = await startGatewayServer({
        port: 0,
        controlPlaneUrl: mockControlPlane.url,
        dataPlaneUrl: mockDataPlane.url,
      });

      const response = await fetch(
        `http://127.0.0.1:${gateway.port}/hello?filter=active`,
        {
          headers: { "accept": "application/json" },
        },
      );

      assertEquals(response.status, HTTP_STATUS_OK);
      assertEquals(response.headers.get("x-powered-by"), "railfog-runtime");
      const json = await response.json();
      assertEquals(json.message, "hello world");
      assertEquals(json.path, "/hello");

      // Verify data plane received the request
      assertEquals(mockDataPlane.requests.length, 1);
      const dpReq = mockDataPlane.requests[0];
      assertEquals(dpReq.method, "GET");
      assertEquals(dpReq.pathname, "/hello");
      assertEquals(dpReq.search, "?filter=active");

      // Verify control plane received 0 requests (zero roundtrips on data plane path)
      assertEquals(mockControlPlane.requests.length, 0);
    } finally {
      await gateway?.close();
      await mockControlPlane.close();
      await mockDataPlane.close();
    }
  },
);

Deno.test(
  "PLAT-1, PLAT-8 (AC2): forwards customer route POST /upload/image with payload to data plane",
  async () => {
    // spec: contracts/platform.contract.md#PLAT-1, PLAT-8 — customer invocations dispatch to data plane
    const mockControlPlane = createMockBackend();
    const mockDataPlane = createMockBackend((_req, recorded) => {
      return new Response(
        JSON.stringify({ uploadedBytes: recorded.body.length }),
        {
          status: HTTP_STATUS_OK,
          headers: { "content-type": "application/json" },
        },
      );
    });
    let gateway: GatewayServer | undefined;

    try {
      gateway = await startGatewayServer({
        port: 0,
        controlPlaneUrl: mockControlPlane.url,
        dataPlaneUrl: mockDataPlane.url,
      });

      const binaryPayload = "sample-image-binary-stream-data-12345";
      const response = await fetch(
        `http://127.0.0.1:${gateway.port}/upload/image`,
        {
          method: "POST",
          headers: { "content-type": "application/octet-stream" },
          body: binaryPayload,
        },
      );

      assertEquals(response.status, HTTP_STATUS_OK);
      const json = await response.json();
      assertEquals(json.uploadedBytes, binaryPayload.length);

      assertEquals(mockDataPlane.requests.length, 1);
      assertEquals(mockDataPlane.requests[0].method, "POST");
      assertEquals(mockDataPlane.requests[0].pathname, "/upload/image");
      assertEquals(mockDataPlane.requests[0].body, binaryPayload);

      // Verify zero control plane requests
      assertEquals(mockControlPlane.requests.length, 0);
    } finally {
      await gateway?.close();
      await mockControlPlane.close();
      await mockDataPlane.close();
    }
  },
);

Deno.test(
  "PLAT-1, PLAT-8 (AC2): forwards nested path GET /users/123 to data plane with zero control plane roundtrips",
  async () => {
    // spec: contracts/platform.contract.md#PLAT-8 — customer route paths
    const mockControlPlane = createMockBackend();
    const mockDataPlane = createMockBackend();
    let gateway: GatewayServer | undefined;

    try {
      gateway = await startGatewayServer({
        port: 0,
        controlPlaneUrl: mockControlPlane.url,
        dataPlaneUrl: mockDataPlane.url,
      });

      const response = await fetch(
        `http://127.0.0.1:${gateway.port}/users/123?sort=asc`,
      );

      assertEquals(response.status, HTTP_STATUS_OK);
      await response.text();

      assertEquals(mockDataPlane.requests.length, 1);
      assertEquals(mockDataPlane.requests[0].pathname, "/users/123");
      assertEquals(mockDataPlane.requests[0].search, "?sort=asc");
      assertEquals(mockControlPlane.requests.length, 0);
    } finally {
      await gateway?.close();
      await mockControlPlane.close();
      await mockDataPlane.close();
    }
  },
);

// ============================================================================
// AC3: Request ID (ULID) Injection (PLAT-14, PLAT-12)
// ============================================================================

Deno.test(
  "PLAT-14, PLAT-12 (AC3): generates Crockford Base32 ULID and injects x-request-id and request-id when absent",
  async () => {
    // spec: contracts/platform.contract.md#PLAT-14 — 26 char Crockford Base32 monotonic ULID
    // spec: contracts/platform.contract.md#PLAT-12 — every response carries request_id
    const mockControlPlane = createMockBackend();
    const mockDataPlane = createMockBackend();
    let gateway: GatewayServer | undefined;

    try {
      gateway = await startGatewayServer({
        port: 0,
        controlPlaneUrl: mockControlPlane.url,
        dataPlaneUrl: mockDataPlane.url,
      });

      // Request sent without any request ID header
      const response = await fetch(`http://127.0.0.1:${gateway.port}/hello`);
      assertEquals(response.status, HTTP_STATUS_OK);
      await response.text();

      // Verify upstream data plane received injected request ID headers
      assertEquals(mockDataPlane.requests.length, 1);
      const upstreamHeaders = mockDataPlane.requests[0].headers;
      const upstreamXRequestId = upstreamHeaders.get("x-request-id");
      const upstreamRequestId = upstreamHeaders.get("request-id");

      assertExists(upstreamXRequestId);
      assertExists(upstreamRequestId);
      assertEquals(upstreamXRequestId, upstreamRequestId);
      assertEquals(isValidUlid(upstreamXRequestId), true);

      // Verify downstream client response contains identical request ID headers
      const downstreamXRequestId = response.headers.get("x-request-id");
      const downstreamRequestId = response.headers.get("request-id");

      assertExists(downstreamXRequestId);
      assertExists(downstreamRequestId);
      assertEquals(downstreamXRequestId, upstreamXRequestId);
      assertEquals(downstreamRequestId, upstreamRequestId);
    } finally {
      await gateway?.close();
      await mockControlPlane.close();
      await mockDataPlane.close();
    }
  },
);

Deno.test(
  "PLAT-14, PLAT-12 (AC3): preserves existing client-supplied x-request-id upstream and downstream",
  async () => {
    // spec: contracts/platform.contract.md#PLAT-12 — propagated Gateway -> Control -> Runtime unchanged
    const mockControlPlane = createMockBackend();
    const mockDataPlane = createMockBackend();
    let gateway: GatewayServer | undefined;

    try {
      gateway = await startGatewayServer({
        port: 0,
        controlPlaneUrl: mockControlPlane.url,
        dataPlaneUrl: mockDataPlane.url,
      });

      const clientSuppliedId = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

      const response = await fetch(
        `http://127.0.0.1:${gateway.port}/v1/projects`,
        {
          headers: {
            "x-request-id": clientSuppliedId,
          },
        },
      );

      assertEquals(response.status, HTTP_STATUS_OK);
      await response.text();

      // Verify upstream control plane received the client-supplied ID
      assertEquals(mockControlPlane.requests.length, 1);
      const cpHeaders = mockControlPlane.requests[0].headers;
      assertEquals(cpHeaders.get("x-request-id"), clientSuppliedId);
      assertEquals(cpHeaders.get("request-id"), clientSuppliedId);

      // Verify downstream client received the preserved ID
      assertEquals(response.headers.get("x-request-id"), clientSuppliedId);
      assertEquals(response.headers.get("request-id"), clientSuppliedId);
    } finally {
      await gateway?.close();
      await mockControlPlane.close();
      await mockDataPlane.close();
    }
  },
);

// ============================================================================
// AC4: Rate Limiting Rejection 429 RATE_LIMITED (PLAT-9, PLAT-12)
// ============================================================================

Deno.test(
  "PLAT-9, PLAT-12 (AC4): rejects bursts exceeding token bucket with 429 RATE_LIMITED, Retry-After, and PLAT-12 body",
  async () => {
    // spec: contracts/platform.contract.md#PLAT-9 — token bucket rate limiter: 429 RATE_LIMITED with Retry-After
    // spec: contracts/platform.contract.md#PLAT-12 — error shape { error: { code, message, request_id } }
    const mockDataPlane = createMockBackend();
    const mockControlPlane = createMockBackend();
    let gateway: GatewayServer | undefined;

    const rateLimiter = new MultiTenantRateLimiter({
      ip: { rate: TEST_REFILL_RATE, burst: TEST_BURST_CAPACITY },
    });

    try {
      gateway = await startGatewayServer({
        port: 0,
        controlPlaneUrl: mockControlPlane.url,
        dataPlaneUrl: mockDataPlane.url,
        rateLimiter,
      });

      const clientIp = "198.51.100.1";
      const headers = { "x-forwarded-for": clientIp };

      // Request 1: allowed (burst token 1 consumed)
      const res1 = await fetch(`http://127.0.0.1:${gateway.port}/hello`, {
        headers,
      });
      assertEquals(res1.status, HTTP_STATUS_OK);
      await res1.text();

      // Request 2: allowed (burst token 2 consumed, bucket now empty)
      const res2 = await fetch(`http://127.0.0.1:${gateway.port}/hello`, {
        headers,
      });
      assertEquals(res2.status, HTTP_STATUS_OK);
      await res2.text();

      // Request 3: rejected immediately by gateway without contacting backend
      const res3 = await fetch(`http://127.0.0.1:${gateway.port}/hello`, {
        headers,
      });
      assertEquals(res3.status, HTTP_STATUS_RATE_LIMITED);

      // Verify Retry-After header is present and is a positive integer
      const retryAfterHeader = res3.headers.get("retry-after");
      assertExists(retryAfterHeader);
      const retryAfterSeconds = Number.parseInt(retryAfterHeader, 10);
      assert(
        !Number.isNaN(retryAfterSeconds) && retryAfterSeconds > 0,
        `Expected positive integer Retry-After, got: ${retryAfterHeader}`,
      );

      // Verify response body matches PLAT-12 canonical error structure
      const errorBody = await res3.json();
      assertExists(errorBody.error);
      assertEquals(errorBody.error.code, ERROR_CODE_RATE_LIMITED);
      assertExists(errorBody.error.message);
      assert(errorBody.error.message.length > 0);
      assertExists(errorBody.error.request_id);
      assertEquals(isValidUlid(errorBody.error.request_id), true);

      // Verify request-id headers in response match the error body request_id
      assertEquals(
        res3.headers.get("x-request-id"),
        errorBody.error.request_id,
      );
      assertEquals(res3.headers.get("request-id"), errorBody.error.request_id);

      // Verify backend server only received the first 2 allowed requests (3rd dropped at gateway)
      assertEquals(mockDataPlane.requests.length, 2);
    } finally {
      await gateway?.close();
      await mockControlPlane.close();
      await mockDataPlane.close();
    }
  },
);

Deno.test(
  "PLAT-9, PLAT-18 (AC4): isolates rate limit buckets across distinct client IPs",
  async () => {
    // spec: contracts/platform.contract.md#PLAT-9, PLAT-18 — independent rate limit state per client/tenant
    const mockDataPlane = createMockBackend();
    const mockControlPlane = createMockBackend();
    let gateway: GatewayServer | undefined;

    const rateLimiter = new MultiTenantRateLimiter({
      ip: { rate: TEST_REFILL_RATE, burst: TEST_BURST_CAPACITY },
    });

    try {
      gateway = await startGatewayServer({
        port: 0,
        controlPlaneUrl: mockControlPlane.url,
        dataPlaneUrl: mockDataPlane.url,
        rateLimiter,
      });

      const ipA = "198.51.100.1";
      const ipB = "198.51.100.2";

      // Exhaust IP A
      const resA1 = await fetch(`http://127.0.0.1:${gateway.port}/hello`, {
        headers: { "x-forwarded-for": ipA },
      });
      assertEquals(resA1.status, HTTP_STATUS_OK);
      await resA1.text();

      const resA2 = await fetch(`http://127.0.0.1:${gateway.port}/hello`, {
        headers: { "x-forwarded-for": ipA },
      });
      assertEquals(resA2.status, HTTP_STATUS_OK);
      await resA2.text();

      const resA3 = await fetch(`http://127.0.0.1:${gateway.port}/hello`, {
        headers: { "x-forwarded-for": ipA },
      });
      assertEquals(resA3.status, HTTP_STATUS_RATE_LIMITED);
      await resA3.text();

      // IP B should succeed despite IP A being rate limited
      const resB1 = await fetch(`http://127.0.0.1:${gateway.port}/hello`, {
        headers: { "x-forwarded-for": ipB },
      });
      assertEquals(resB1.status, HTTP_STATUS_OK);
      await resB1.text();

      // Total requests received by data plane: 2 from IP A + 1 from IP B = 3
      assertEquals(mockDataPlane.requests.length, 3);
    } finally {
      await gateway?.close();
      await mockControlPlane.close();
      await mockDataPlane.close();
    }
  },
);

// ============================================================================
// AC5: Upstream Error / Network Drop Recovery 503 UNAVAILABLE (PLAT-12)
// ============================================================================

Deno.test(
  "PLAT-12 (AC5): returns HTTP 503 UNAVAILABLE with PLAT-12 error body when upstream control plane is unreachable",
  async () => {
    // spec: contracts/platform.contract.md#PLAT-12 — UNAVAILABLE when control plane is unreachable
    const unreachableControlPlaneUrl = await createUnreachableUrl();
    const mockDataPlane = createMockBackend();
    let gateway: GatewayServer | undefined;

    try {
      gateway = await startGatewayServer({
        port: 0,
        controlPlaneUrl: unreachableControlPlaneUrl,
        dataPlaneUrl: mockDataPlane.url,
      });

      const response = await fetch(
        `http://127.0.0.1:${gateway.port}/v1/projects`,
      );

      assertEquals(response.status, HTTP_STATUS_UNAVAILABLE);

      const errorBody = await response.json();
      assertExists(errorBody.error);
      assertEquals(errorBody.error.code, ERROR_CODE_UNAVAILABLE);
      assertExists(errorBody.error.message);
      assert(errorBody.error.message.length > 0);
      assertExists(errorBody.error.request_id);
      assertEquals(isValidUlid(errorBody.error.request_id), true);

      // Verify response headers contain the matching request ID
      assertEquals(
        response.headers.get("x-request-id"),
        errorBody.error.request_id,
      );
      assertEquals(
        response.headers.get("request-id"),
        errorBody.error.request_id,
      );
    } finally {
      await gateway?.close();
      await mockDataPlane.close();
    }
  },
);

Deno.test(
  "PLAT-12 (AC5): returns HTTP 503 UNAVAILABLE with PLAT-12 error body when upstream data plane is unreachable",
  async () => {
    // spec: contracts/platform.contract.md#PLAT-12 — UNAVAILABLE on upstream connection drop
    const mockControlPlane = createMockBackend();
    const unreachableDataPlaneUrl = await createUnreachableUrl();
    let gateway: GatewayServer | undefined;

    try {
      gateway = await startGatewayServer({
        port: 0,
        controlPlaneUrl: mockControlPlane.url,
        dataPlaneUrl: unreachableDataPlaneUrl,
      });

      const response = await fetch(
        `http://127.0.0.1:${gateway.port}/hello`,
      );

      assertEquals(response.status, HTTP_STATUS_UNAVAILABLE);

      const errorBody = await response.json();
      assertExists(errorBody.error);
      assertEquals(errorBody.error.code, ERROR_CODE_UNAVAILABLE);
      assertExists(errorBody.error.message);
      assert(errorBody.error.message.length > 0);
      assertExists(errorBody.error.request_id);
      assertEquals(isValidUlid(errorBody.error.request_id), true);

      // Verify response headers contain the matching request ID
      assertEquals(
        response.headers.get("x-request-id"),
        errorBody.error.request_id,
      );
      assertEquals(
        response.headers.get("request-id"),
        errorBody.error.request_id,
      );
    } finally {
      await gateway?.close();
      await mockControlPlane.close();
    }
  },
);

// ============================================================================
// Lifecycle & Server Management
// ============================================================================

Deno.test(
  "PLAT-19: allocates dynamic port, handles requests, and terminates cleanly on close()",
  async () => {
    // spec: contracts/platform.contract.md#PLAT-19 — gateway server lifecycle management
    const mockControlPlane = createMockBackend();
    const mockDataPlane = createMockBackend();
    let gateway: GatewayServer | undefined;

    try {
      gateway = await startGatewayServer({
        port: 0,
        controlPlaneUrl: mockControlPlane.url,
        dataPlaneUrl: mockDataPlane.url,
      });

      assert(
        gateway.port > 0,
        `Expected assigned port > 0, got ${gateway.port}`,
      );

      // Verify server is listening and can handle a request
      const activeRes = await fetch(`http://127.0.0.1:${gateway.port}/hello`);
      assertEquals(activeRes.status, HTTP_STATUS_OK);
      await activeRes.text();

      // Cleanly close the gateway
      const assignedPort = gateway.port;
      await gateway.close();
      gateway = undefined;

      // Verify server is closed and no longer accepts connections
      await assertRejects(async () => {
        await fetch(`http://127.0.0.1:${assignedPort}/hello`, {
          signal: AbortSignal.timeout(1000),
        });
      });
    } finally {
      await gateway?.close();
      await mockControlPlane.close();
      await mockDataPlane.close();
    }
  },
);
