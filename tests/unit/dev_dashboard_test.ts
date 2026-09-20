// spec: contracts/platform.contract.md#PLAT-17 — Local development server parity
// spec: contracts/platform.contract.md#PLAT-19 — Developer experience and interactive local dashboard

import { assert, assertEquals, assertExists } from "@std/assert";
import { join } from "@std/path";
import {
  type LocalServer,
  startLocalServer,
} from "../../runtime/dev-server/local-server.ts";

const SAMPLE_TOML = `name = "dashboard-test-app"

[functions.api]
entry = "functions/api.ts"

[[routes]]
pattern = "/api/hello"
function = "api"
`;

Deno.test("Dashboard: GET /__railfog serves embedded HTML dashboard with 200 OK", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "railfog-dash-test-" });
  let server: LocalServer | null = null;

  try {
    await Deno.writeTextFile(join(tempDir, "railfog.toml"), SAMPLE_TOML);
    const fnDir = join(tempDir, "functions");
    await Deno.mkdir(fnDir, { recursive: true });
    await Deno.writeTextFile(
      join(fnDir, "api.ts"),
      "export default () => Response.json({ ok: true });",
    );

    server = await startLocalServer(
      {
        name: "dashboard-test-app",
        functions: { api: { entry: "functions/api.ts" } },
        routes: [{ pattern: "/api/hello", function: "api" }],
      },
      0,
      { cwd: tempDir, watch: false, logRequests: false },
    );

    const res = await fetch(`http://localhost:${server.port}/__railfog`);
    assertEquals(res.status, 200);
    assertEquals(res.headers.get("content-type"), "text/html; charset=utf-8");
    const html = await res.text();
    assert(html.includes("RailFog Local Dashboard"));
    assert(html.includes("dashboard-test-app"));
    assert(html.includes("/api/hello"));
  } finally {
    if (server) await server.close();
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("Dashboard: /__railfog/api/info and /__railfog/api/kv manage local dev state", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "railfog-dash-api-" });
  let server: LocalServer | null = null;

  try {
    server = await startLocalServer(
      {
        name: "dash-api-app",
        functions: { api: { entry: "functions/api.ts" } },
        routes: [{ pattern: "/api/hello", function: "api" }],
      },
      0,
      { cwd: tempDir, watch: false, logRequests: false },
    );

    // 1. Info endpoint
    const infoRes = await fetch(
      `http://localhost:${server.port}/__railfog/api/info`,
    );
    assertEquals(infoRes.status, 200);
    const infoJson = await infoRes.json();
    assertEquals(infoJson.project, "dash-api-app");
    assertEquals(infoJson.routes.length, 1);

    // 2. Set KV key via dashboard API
    const setRes = await fetch(
      `http://localhost:${server.port}/__railfog/api/kv`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: "user:1", value: { name: "Alice" } }),
      },
    );
    assertEquals(setRes.status, 200);

    // 3. List KV keys via dashboard API
    const listRes = await fetch(
      `http://localhost:${server.port}/__railfog/api/kv`,
    );
    assertEquals(listRes.status, 200);
    const listJson = await listRes.json();
    assertExists(listJson.keys);
    const found = listJson.keys.find((k: { key: string }) =>
      k.key === "user:1"
    );
    assertExists(found);
    assertEquals(found.value, { name: "Alice" });

    // 4. Delete KV key
    const delRes = await fetch(
      `http://localhost:${server.port}/__railfog/api/kv?key=user:1`,
      { method: "DELETE" },
    );
    assertEquals(delRes.status, 200);
  } finally {
    if (server) await server.close();
    await Deno.remove(tempDir, { recursive: true });
  }
});
