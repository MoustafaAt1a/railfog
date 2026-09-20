/**
 * Tests for Local Dev Server File Watcher and Developer Ergonomics.
 *
 * Spec references:
 * - FN-1: Function definition
 * - FN-8: Request lifecycle
 * - PLAT-11: Routing specificity algorithm
 * - PLAT-12: Error model (exhaustive code table, HTTP 500 INTERNAL)
 * - PLAT-14: ULID format for request_id
 * - PLAT-17: Local/production parity (SQLite for KV/Queue, LocalFS for Objects)
 * - PLAT-19: Repository structure
 * - tasks/milestone-0.5-developer-experience/T-0508-local-dev-server-reload.md
 */

import { assert, assertEquals, assertExists } from "@std/assert";
import { join } from "@std/path";
import { isValidUlid } from "../../packages/core/id/ulid.ts";
import {
  ProjectWatcher,
  type WatchEvent,
} from "../../runtime/dev-server/watcher.ts";
import {
  formatRequestLine,
  formatStartupBanner,
  type LocalServer,
  type LocalServerOptions,
  type RailfogConfig,
  type RequestLogLineInfo,
  startLocalServer,
} from "../../runtime/dev-server/local-server.ts";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getResponseRequestId(res: Response): string | null {
  return res.headers.get("x-request-id") ?? res.headers.get("request-id");
}

// ============================================================================
// Suite 1: ProjectWatcher Unit Tests
// ============================================================================

Deno.test(
  "ProjectWatcher: debounces rapid consecutive file write events to fire callback once after debounceMs (AC4)",
  async () => {
    const tempDir = await Deno.makeTempDir({
      prefix: "railfog-watcher-debounce-",
    });
    let watcher: ProjectWatcher | null = null;

    try {
      const filePath = join(tempDir, "target.txt");
      await Deno.writeTextFile(filePath, "initial");

      let callCount = 0;
      const receivedEvents: WatchEvent[] = [];

      // spec: tasks/milestone-0.5-developer-experience/T-0508-local-dev-server-reload.md#AC4
      watcher = new ProjectWatcher({
        paths: [tempDir],
        debounceMs: 100,
      });

      await watcher.start((events: WatchEvent[]) => {
        callCount++;
        receivedEvents.push(...events);
      });

      // Rapidly fire 5 writes within 25ms (well inside 100ms debounce window)
      for (let i = 1; i <= 5; i++) {
        await Deno.writeTextFile(filePath, `update ${i}`);
        await delay(5);
      }

      // Wait past the debounce period
      await delay(250);

      // Verify callback fired exactly once
      assertEquals(
        callCount,
        1,
        `Expected callback to fire exactly once after debouncing, fired ${callCount} times`,
      );
      assert(
        receivedEvents.length > 0,
        "Expected at least one watch event in debounced callback",
      );
      assert(
        receivedEvents.some((ev) => ev.path.includes("target.txt")),
        "Expected event path to include target.txt",
      );
    } finally {
      watcher?.stop();
      await delay(50);
      try {
        await Deno.remove(tempDir, { recursive: true });
      } catch {
        // Ignore file lock cleanup errors on Windows
      }
    }
  },
);

Deno.test(
  "ProjectWatcher: detects file modification and passes event array with path and kind 'modify'",
  async () => {
    const tempDir = await Deno.makeTempDir({
      prefix: "railfog-watcher-modify-",
    });
    let watcher: ProjectWatcher | null = null;

    try {
      const filePath = join(tempDir, "handler.ts");
      await Deno.writeTextFile(filePath, 'console.log("v1");');

      const eventsReceived: WatchEvent[] = [];
      let triggered = false;

      watcher = new ProjectWatcher({
        paths: [tempDir],
        debounceMs: 50,
      });

      await watcher.start((events: WatchEvent[]) => {
        triggered = true;
        eventsReceived.push(...events);
      });

      // Modify existing file
      await delay(50);
      await Deno.writeTextFile(filePath, 'console.log("v2");');
      await delay(200);

      assert(
        triggered,
        "Expected watcher callback to be triggered on file modification",
      );
      const modifyEvent = eventsReceived.find(
        (ev) => ev.path.includes("handler.ts") && ev.kind === "modify",
      );
      assertExists(
        modifyEvent,
        "Expected a 'modify' event for handler.ts",
      );
      assert(
        modifyEvent.path.includes("handler.ts"),
        `Event path must contain handler.ts, got: ${modifyEvent.path}`,
      );
    } finally {
      watcher?.stop();
      await delay(50);
      try {
        await Deno.remove(tempDir, { recursive: true });
      } catch {
        // Ignore
      }
    }
  },
);

Deno.test(
  "ProjectWatcher: detects file creation and passes event array with path and kind 'create'",
  async () => {
    const tempDir = await Deno.makeTempDir({
      prefix: "railfog-watcher-create-",
    });
    let watcher: ProjectWatcher | null = null;

    try {
      const eventsReceived: WatchEvent[] = [];
      let triggered = false;

      watcher = new ProjectWatcher({
        paths: [tempDir],
        debounceMs: 50,
      });

      await watcher.start((events: WatchEvent[]) => {
        triggered = true;
        eventsReceived.push(...events);
      });

      // Create new file
      await delay(50);
      const newFile = join(tempDir, "created.ts");
      await Deno.writeTextFile(newFile, "export default () => 42;");
      await delay(200);

      assert(
        triggered,
        "Expected watcher callback to trigger on file creation",
      );
      const createEvent = eventsReceived.find(
        (ev) =>
          ev.path.includes("created.ts") &&
          (ev.kind === "create" || ev.kind === "modify"),
      );
      assertExists(createEvent, "Expected an event for created.ts");
    } finally {
      watcher?.stop();
      await delay(50);
      try {
        await Deno.remove(tempDir, { recursive: true });
      } catch {
        // Ignore
      }
    }
  },
);

Deno.test(
  "ProjectWatcher: detects file deletion and passes event array with path and kind 'delete'",
  async () => {
    const tempDir = await Deno.makeTempDir({
      prefix: "railfog-watcher-delete-",
    });
    let watcher: ProjectWatcher | null = null;

    try {
      const fileToDelete = join(tempDir, "obsolete.ts");
      await Deno.writeTextFile(fileToDelete, "// to be deleted");

      const eventsReceived: WatchEvent[] = [];
      let triggered = false;

      watcher = new ProjectWatcher({
        paths: [tempDir],
        debounceMs: 50,
      });

      await watcher.start((events: WatchEvent[]) => {
        triggered = true;
        eventsReceived.push(...events);
      });

      // Delete file
      await delay(50);
      await Deno.remove(fileToDelete);
      await delay(200);

      assert(
        triggered,
        "Expected watcher callback to trigger on file deletion",
      );
      const deleteEvent = eventsReceived.find(
        (ev) => ev.path.includes("obsolete.ts") && ev.kind === "delete",
      );
      assertExists(deleteEvent, "Expected a 'delete' event for obsolete.ts");
    } finally {
      watcher?.stop();
      await delay(50);
      try {
        await Deno.remove(tempDir, { recursive: true });
      } catch {
        // Ignore
      }
    }
  },
);

Deno.test(
  "ProjectWatcher: handles clean shutdown via watcher.stop() and stops emitting events",
  async () => {
    const tempDir = await Deno.makeTempDir({ prefix: "railfog-watcher-stop-" });
    let watcher: ProjectWatcher | null = null;

    try {
      const filePath = join(tempDir, "file.txt");
      await Deno.writeTextFile(filePath, "initial");

      let callCount = 0;
      watcher = new ProjectWatcher({
        paths: [tempDir],
        debounceMs: 50,
      });

      await watcher.start(() => {
        callCount++;
      });

      // Trigger one event and wait
      await Deno.writeTextFile(filePath, "mod1");
      await delay(150);
      assertEquals(callCount, 1, "Expected 1 call before stop()");

      // Stop watcher cleanly
      watcher.stop();
      await delay(50);

      // Write again after stop
      await Deno.writeTextFile(filePath, "mod2");
      await delay(150);

      assertEquals(
        callCount,
        1,
        "Watcher callback must not be invoked after watcher.stop() has been called",
      );
    } finally {
      watcher?.stop();
      await delay(50);
      try {
        await Deno.remove(tempDir, { recursive: true });
      } catch {
        // Ignore
      }
    }
  },
);

Deno.test(
  "ProjectWatcher: handles shutdown via AbortSignal passed in WatchOptions",
  async () => {
    const tempDir = await Deno.makeTempDir({
      prefix: "railfog-watcher-abort-",
    });
    let watcher: ProjectWatcher | null = null;

    try {
      const controller = new AbortController();
      const filePath = join(tempDir, "signal-target.txt");
      await Deno.writeTextFile(filePath, "initial");

      let callCount = 0;
      watcher = new ProjectWatcher({
        paths: [tempDir],
        debounceMs: 50,
        signal: controller.signal,
      });

      await watcher.start(() => {
        callCount++;
      });

      // Trigger one event
      await Deno.writeTextFile(filePath, "change-before-abort");
      await delay(150);
      assertEquals(callCount, 1, "Expected 1 call before abort()");

      // Abort via signal
      controller.abort();
      await delay(50);

      // Write again after abort
      await Deno.writeTextFile(filePath, "change-after-abort");
      await delay(150);

      assertEquals(
        callCount,
        1,
        "Watcher must stop listening when AbortSignal triggers",
      );
    } finally {
      watcher?.stop();
      await delay(50);
      try {
        await Deno.remove(tempDir, { recursive: true });
      } catch {
        // Ignore
      }
    }
  },
);

Deno.test(
  "ProjectWatcher: watches both files and directories simultaneously (e.g. railfog.toml and functions/)",
  async () => {
    const tempDir = await Deno.makeTempDir({
      prefix: "railfog-watcher-multi-",
    });
    let watcher: ProjectWatcher | null = null;

    try {
      const tomlFile = join(tempDir, "railfog.toml");
      const functionsDir = join(tempDir, "functions");
      await Deno.writeTextFile(tomlFile, 'name = "multi-watch"');
      await Deno.mkdir(functionsDir, { recursive: true });

      const eventsReceived: WatchEvent[] = [];

      // spec: tasks/milestone-0.5-developer-experience/T-0508-local-dev-server-reload.md Scope
      watcher = new ProjectWatcher({
        paths: [tomlFile, functionsDir],
        debounceMs: 50,
      });

      await watcher.start((events: WatchEvent[]) => {
        eventsReceived.push(...events);
      });

      // 1. Modify railfog.toml
      await delay(50);
      await Deno.writeTextFile(tomlFile, 'name = "multi-watch-modified"');
      await delay(150);

      assert(
        eventsReceived.some((ev) => ev.path.includes("railfog.toml")),
        "Expected watch event for railfog.toml",
      );

      // 2. Create functions/api.ts in directory
      const fnFile = join(functionsDir, "api.ts");
      await Deno.writeTextFile(
        fnFile,
        "export default () => Response.json({});",
      );
      await delay(150);

      assert(
        eventsReceived.some((ev) => ev.path.includes("api.ts")),
        "Expected watch event for functions/api.ts",
      );
    } finally {
      watcher?.stop();
      await delay(50);
      try {
        await Deno.remove(tempDir, { recursive: true });
      } catch {
        // Ignore
      }
    }
  },
);

// ============================================================================
// Suite 2: Developer Ergonomics & Integration Tests
// ============================================================================

Deno.test(
  "Developer ergonomics: startup banner displays listening address, routes with specificity scores (PLAT-11), and local providers (PLAT-17)",
  () => {
    // spec: docs/contracts/platform.contract.md#PLAT-11 — Specificity algorithm
    // spec: docs/contracts/platform.contract.md#PLAT-17 — Local SQLite and LocalFS providers
    // spec: tasks/milestone-0.5-developer-experience/T-0508-local-dev-server-reload.md AC2
    const config: RailfogConfig = {
      name: "banner-demo",
      functions: {
        users: { entry: "functions/users.ts" },
        catchAll: { entry: "functions/catchall.ts" },
      },
      routes: [
        { pattern: "/api/users", function: "users" }, // score: (2 literal * 2) = 4
        { pattern: "/api/*", function: "catchAll" }, // score: (1 literal * 2) + (1 wildcard * 1) = 3
      ],
    };

    const banner = formatStartupBanner(config, 8000);

    // 1. Listening address/port
    assert(
      banner.includes("8000") || banner.includes("http://localhost:8000"),
      `Banner must display listening port or address: ${banner}`,
    );

    // 2. Routes with specificity scores per PLAT-11
    assert(
      banner.includes("/api/users"),
      "Banner must display route /api/users",
    );
    assert(
      banner.includes("4"),
      "Banner must display specificity score 4 for /api/users",
    );

    assert(
      banner.includes("/api/*"),
      "Banner must display route /api/*",
    );
    assert(
      banner.includes("3"),
      "Banner must display specificity score 3 for /api/*",
    );

    // 3. Local providers per PLAT-17 (SQLite for KV/Queues, LocalFS for Objects)
    const lowerBanner = banner.toLowerCase();
    assert(
      lowerBanner.includes("sqlite"),
      "Banner must indicate SQLite provider (KV / Queues) per PLAT-17",
    );
    assert(
      lowerBanner.includes("localfs") || lowerBanner.includes("filesystem") ||
        lowerBanner.includes("fs"),
      "Banner must indicate LocalFS / filesystem provider (Objects) per PLAT-17",
    );
  },
);

Deno.test(
  "Developer ergonomics: request line formatter emits ULID request_id (PLAT-14), HTTP method, pathname, status, and duration_ms",
  () => {
    // spec: docs/contracts/platform.contract.md#PLAT-14 — ULID request_id format
    const logInfo: RequestLogLineInfo = {
      requestId: "01J8Z000000000000000000000",
      method: "POST",
      pathname: "/upload",
      status: 200,
      durationMs: 14,
    };

    const formatted = formatRequestLine(logInfo);

    // 1. ULID request_id
    assert(
      formatted.includes("01J8Z000000000000000000000"),
      `Formatted request line must include ULID request_id: "${formatted}"`,
    );

    // 2. HTTP method
    assert(
      formatted.includes("POST"),
      `Formatted request line must include HTTP method: "${formatted}"`,
    );

    // 3. Pathname
    assert(
      formatted.includes("/upload"),
      `Formatted request line must include pathname: "${formatted}"`,
    );

    // 4. HTTP status
    assert(
      formatted.includes("200"),
      `Formatted request line must include HTTP status code: "${formatted}"`,
    );

    // 5. Duration in ms
    assert(
      formatted.includes("14ms") || formatted.includes("14 ms"),
      `Formatted request line must include duration in ms: "${formatted}"`,
    );
  },
);

Deno.test(
  "Developer ergonomics: unhandled error in dev mode returns HTTP 500 JSON with code 'INTERNAL', ULID request_id in body and header, and actionable stack trace (PLAT-12, PLAT-14, AC3)",
  async () => {
    const tempDir = await Deno.makeTempDir({
      prefix: "railfog-unhandled-err-",
    });
    let server: LocalServer | null = null;

    try {
      const functionsDir = join(tempDir, "functions");
      await Deno.mkdir(functionsDir, { recursive: true });

      // Customer function throwing an unhandled Error
      const handlerCode = `
export default async function handler(_req: Request, _ctx: any): Promise<Response> {
  throw new Error("Intentional customer function failure in test");
}
`;
      await Deno.writeTextFile(join(functionsDir, "crash.ts"), handlerCode);

      const config: RailfogConfig = {
        name: "crash-app",
        functions: {
          crash: { entry: "functions/crash.ts" },
        },
        routes: [{ pattern: "/crash", function: "crash" }],
      };

      server = await startLocalServer(config, 0, {
        cwd: tempDir,
        watch: false,
      });
      const port = server.port;

      const res = await fetch(`http://localhost:${port}/crash`);

      // 1. HTTP 500 status per PLAT-12
      assertEquals(
        res.status,
        500,
        "Unhandled error must return HTTP 500 status",
      );

      // 2. ULID request_id in header per PLAT-12, PLAT-14
      const headerReqId = getResponseRequestId(res);
      assert(
        headerReqId !== null,
        "Response must contain x-request-id or request-id header",
      );
      assert(
        isValidUlid(headerReqId),
        `Header request_id must be valid ULID, got: ${headerReqId}`,
      );

      // 3. JSON body with code 'INTERNAL' and matching request_id
      const body = await res.json();
      const err = body.error ?? body;
      assertEquals(
        err.code,
        "INTERNAL",
        "Error code must be 'INTERNAL' per PLAT-12",
      );
      assertEquals(
        err.request_id,
        headerReqId,
        "Error body request_id must match header request_id",
      );

      // 4. Actionable details / stack trace in dev mode
      const hasStackTrace = Boolean(
        err.details ||
          err.stack ||
          body.details ||
          body.stack ||
          (err.message &&
            err.message.includes(
              "Intentional customer function failure in test",
            )),
      );
      assert(
        hasStackTrace,
        "Error response in local dev server must contain actionable details/stack trace",
      );
    } finally {
      if (server) {
        await server.close();
      }
      await delay(50);
      try {
        await Deno.remove(tempDir, { recursive: true });
      } catch {
        // Ignore
      }
    }
  },
);

Deno.test(
  "Hot-reload integration: modifying a function handler reloads logic for subsequent HTTP requests without dropping HTTP listener (AC1, FN-1, FN-8)",
  async () => {
    const tempDir = await Deno.makeTempDir({ prefix: "railfog-hot-reload-" });
    let server: LocalServer | null = null;

    try {
      const functionsDir = join(tempDir, "functions");
      await Deno.mkdir(functionsDir, { recursive: true });

      // Write initial handler returning version 1
      const initialHandler = `
export default async function handler(_req: Request, _ctx: any): Promise<Response> {
  return Response.json({ version: 1, message: "Initial handler" });
}
`;
      const fnPath = join(functionsDir, "api.ts");
      await Deno.writeTextFile(fnPath, initialHandler);

      const config: RailfogConfig = {
        name: "hot-reload-app",
        functions: {
          api: { entry: "functions/api.ts" },
        },
        routes: [{ pattern: "/api", function: "api" }],
      };

      // Start local server with file watching enabled (default or explicit)
      const options: LocalServerOptions = {
        cwd: tempDir,
        watch: true,
        debounceMs: 50,
      };
      server = await startLocalServer(config, 0, options);
      const port = server.port;

      // Initial request -> returns version 1
      const res1 = await fetch(`http://localhost:${port}/api`);
      assertEquals(res1.status, 200);
      const data1 = await res1.json();
      assertEquals(data1.version, 1, "Expected initial handler version 1");

      // Modify the function handler file to version 2
      const updatedHandler = `
export default async function handler(_req: Request, _ctx: any): Promise<Response> {
  return Response.json({ version: 2, message: "Reloaded handler" });
}
`;
      await Deno.writeTextFile(fnPath, updatedHandler);

      // Wait for watcher debounce & module reload (AC1 specifies within 200 ms)
      await delay(250);

      // Subsequent request -> executes updated version 2 without server restart
      const res2 = await fetch(`http://localhost:${port}/api`);
      assertEquals(res2.status, 200);
      const data2 = await res2.json();
      assertEquals(
        data2.version,
        2,
        `Expected reloaded handler version 2, got: ${JSON.stringify(data2)}`,
      );

      // Verify HTTP listener was preserved (same port)
      assertEquals(
        server.port,
        port,
        "HTTP listener port must remain identical across hot reloads",
      );
    } finally {
      if (server) {
        await server.close();
      }
      await delay(50);
      try {
        await Deno.remove(tempDir, { recursive: true });
      } catch {
        // Ignore
      }
    }
  },
);

Deno.test(
  "--no-watch behavior: disabling watcher prevents automatic handler reloading on file modifications (AC5)",
  async () => {
    const tempDir = await Deno.makeTempDir({ prefix: "railfog-no-watch-" });
    let server: LocalServer | null = null;

    try {
      const functionsDir = join(tempDir, "functions");
      await Deno.mkdir(functionsDir, { recursive: true });

      const initialHandler = `
export default async function handler(_req: Request, _ctx: any): Promise<Response> {
  return Response.json({ version: 1 });
}
`;
      const fnPath = join(functionsDir, "nowatch.ts");
      await Deno.writeTextFile(fnPath, initialHandler);

      const config: RailfogConfig = {
        name: "nowatch-app",
        functions: {
          nowatch: { entry: "functions/nowatch.ts" },
        },
        routes: [{ pattern: "/nowatch", function: "nowatch" }],
      };

      // spec: tasks/milestone-0.5-developer-experience/T-0508-local-dev-server-reload.md AC5
      // Start server with watch: false (--no-watch)
      const options: LocalServerOptions = { cwd: tempDir, watch: false };
      server = await startLocalServer(config, 0, options);
      const port = server.port;

      // Verify initial response
      const res1 = await fetch(`http://localhost:${port}/nowatch`);
      assertEquals(res1.status, 200);
      const data1 = await res1.json();
      assertEquals(data1.version, 1);

      // Modify the file on disk
      const modifiedHandler = `
export default async function handler(_req: Request, _ctx: any): Promise<Response> {
  return Response.json({ version: 2 });
}
`;
      await Deno.writeTextFile(fnPath, modifiedHandler);

      // Wait 250ms
      await delay(250);

      // Because watching is disabled, handler should NOT be reloaded
      const res2 = await fetch(`http://localhost:${port}/nowatch`);
      assertEquals(res2.status, 200);
      const data2 = await res2.json();
      assertEquals(
        data2.version,
        1,
        "Handler must NOT reload when watching is disabled via watch: false",
      );
    } finally {
      if (server) {
        await server.close();
      }
      await delay(50);
      try {
        await Deno.remove(tempDir, { recursive: true });
      } catch {
        // Ignore
      }
    }
  },
);
