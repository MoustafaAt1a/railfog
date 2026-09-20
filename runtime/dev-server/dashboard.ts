/**
 * Embedded Local Dev Dashboard for RailFog (`rail dev`).
 * Serves an offline single-file inspection UI at `/__railfog`.
 *
 * Spec references:
 * - PLAT-17: Local development parity
 * - PLAT-19: Developer experience and interactive terminal / browser tooling
 * - DESIGN.md: Visual design system (ink, paper, signal green lamp)
 */

import type { KVProvider } from "../../primitives/kv/kv-provider.ts";
import type { ObjectProvider } from "../../primitives/objects/object-provider.ts";
import type { QueueProvider } from "../../primitives/queues/queue-provider.ts";
import type { RouteConfig } from "../router/route-matcher.ts";
import type { RailfogConfig } from "./local-server.ts";

export interface DashboardContext {
  orgId: string;
  projectId: string;
  kvProvider: KVProvider;
  objectsProvider: ObjectProvider;
  queuesProvider: QueueProvider;
  routes: RouteConfig[];
}

export function renderDashboardHtml(
  config: RailfogConfig,
  ctx: DashboardContext,
): string {
  const appName = config.name ?? ctx.projectId;
  const routesJson = JSON.stringify(config.routes ?? []);
  const functionsJson = JSON.stringify(config.functions ?? {});

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>RailFog Local Dashboard — ${appName}</title>
  <style>
    :root {
      --ink: #0B2340;
      --ink-soft: #16335C;
      --paper: #F7F9FA;
      --canvas: #EBF0F3;
      --mist: #DFE6EB;
      --line: #C9D3DB;
      --haze: #B4C2CD;
      --steel: #6C8194;
      --slate: #3D5266;
      --mute: #4E6274;
      --lamp: #0FB88E;
      --lamp-press: #0A9E7A;
      --lamp-deep: #0A6B50;
      --lamp-tint: #C6F0E0;
      --stop: #B3261E;
      --stop-tint: #FBE4E1;
      --font-sans: Archivo, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      --font-mono: "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--canvas);
      color: var(--ink);
      font-family: var(--font-sans);
      line-height: 1.5;
      padding-bottom: 48px;
    }
    header {
      background: var(--ink);
      color: var(--paper);
      padding: 16px 32px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      border-bottom: 2px solid var(--ink-soft);
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 12px;
      font-size: 1.1rem;
      font-weight: 700;
      letter-spacing: -0.02em;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 3px 8px;
      border-radius: 2px;
      background: var(--lamp-tint);
      color: var(--lamp-deep);
      font-family: var(--font-mono);
      font-size: 0.75rem;
      font-weight: 700;
      border: 1px solid var(--lamp);
      letter-spacing: 0.04em;
    }
    .lamp-dot {
      width: 8px;
      height: 8px;
      border-radius: 2px;
      background: var(--lamp);
    }
    .container {
      max-width: 1120px;
      margin: 32px auto;
      padding: 0 24px;
    }
    .tabs {
      display: flex;
      gap: 6px;
      margin-bottom: 24px;
      border-bottom: 1px solid var(--line);
      padding-bottom: 8px;
    }
    .tab-btn {
      background: none;
      border: 1px solid transparent;
      padding: 8px 16px;
      font-weight: 600;
      color: var(--slate);
      cursor: pointer;
      border-radius: 2px;
      font-size: 0.875rem;
      transition: all 0.15s;
    }
    .tab-btn:hover {
      color: var(--ink);
      border-color: var(--line);
    }
    .tab-btn.active {
      background: var(--ink);
      color: var(--paper);
      border-color: var(--ink);
    }
    .panel {
      display: none;
      background: var(--paper);
      border-radius: 2px;
      border: 1px solid var(--line);
      padding: 24px 28px;
    }
    .panel.active { display: block; }
    h2 {
      font-size: 1.15rem;
      margin-bottom: 18px;
      font-weight: 700;
      letter-spacing: -0.01em;
      color: var(--ink);
    }
    table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 12px;
      font-family: var(--font-mono);
      font-size: 0.85rem;
      border: 1px solid var(--line);
    }
    th {
      text-align: left;
      padding: 10px 14px;
      background: var(--mist);
      border-bottom: 1px solid var(--line);
      font-weight: 700;
      font-size: 0.75rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--slate);
    }
    td {
      padding: 10px 14px;
      border-bottom: 1px solid var(--line);
      color: var(--ink);
    }
    tr:last-child td { border-bottom: none; }
    .method {
      display: inline-block;
      padding: 2px 6px;
      border-radius: 2px;
      font-size: 0.75rem;
      font-weight: 700;
      letter-spacing: 0.05em;
    }
    .method-get {
      background: var(--lamp-tint);
      color: var(--lamp-deep);
      border: 1px solid var(--lamp);
    }
    .method-post {
      background: var(--mist);
      color: var(--ink);
      border: 1px solid var(--steel);
    }
    .method-delete {
      background: var(--stop-tint);
      color: var(--stop);
      border: 1px solid var(--stop);
    }
    .card-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
      gap: 16px;
      margin-bottom: 24px;
    }
    .card {
      background: var(--paper);
      padding: 18px 20px;
      border-radius: 2px;
      border: 1px solid var(--line);
    }
    .card-title {
      font-size: 0.75rem;
      text-transform: uppercase;
      color: var(--steel);
      font-weight: 700;
      margin-bottom: 6px;
      letter-spacing: 0.05em;
    }
    .card-value {
      font-size: 1.15rem;
      font-weight: 700;
      font-family: var(--font-mono);
      color: var(--ink);
    }
    .form-row {
      display: flex;
      gap: 8px;
      margin-bottom: 16px;
    }
    input, button, select {
      padding: 8px 14px;
      border-radius: 2px;
      border: 1px solid var(--line);
      font-family: inherit;
      font-size: 0.875rem;
    }
    input {
      flex: 1;
      font-family: var(--font-mono);
      background: #ffffff;
      color: var(--ink);
    }
    input:focus {
      outline: none;
      border-color: var(--ink);
    }
    button.primary {
      background: var(--lamp);
      color: var(--ink);
      border: none;
      font-weight: 700;
      cursor: pointer;
      transition: background 0.15s;
    }
    button.primary:hover { background: var(--lamp-press); }
    button.secondary {
      background: var(--paper);
      color: var(--ink);
      border: 1px solid var(--line);
      font-weight: 600;
      cursor: pointer;
    }
    button.secondary:hover { border-color: var(--steel); }
    button.danger {
      background: var(--stop-tint);
      color: var(--stop);
      border: 1px solid var(--stop);
      cursor: pointer;
      padding: 4px 8px;
      font-size: 0.75rem;
      border-radius: 2px;
      font-weight: 600;
    }
    .test-link {
      color: var(--lamp-deep);
      text-decoration: none;
      font-weight: 600;
      font-family: var(--font-mono);
    }
    .test-link:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <header>
    <div class="brand">
      <span>RailFog Local Dashboard</span>
      <span class="badge"><span class="lamp-dot"></span> DEV SERVER ACTIVE</span>
    </div>
    <div style="font-family: var(--font-mono); font-size: 0.85rem; color: var(--haze);">
      Project: <strong style="color: var(--paper);">${appName}</strong>
    </div>
  </header>

  <div class="container">
    <div class="card-grid">
      <div class="card">
        <div class="card-title">Backing KV & Queues</div>
        <div class="card-value">SQLite (Local Parity)</div>
      </div>
      <div class="card">
        <div class="card-title">Backing Objects</div>
        <div class="card-value">LocalFS Storage</div>
      </div>
      <div class="card">
        <div class="card-title">Runtime Topology</div>
        <div class="card-value">Deno &bull; Trigger &rarr; Function</div>
      </div>
    </div>

    <div class="tabs">
      <button class="tab-btn active" onclick="switchTab('routes')">Routes & Functions</button>
      <button class="tab-btn" onclick="switchTab('kv')">KV Storage Explorer</button>
      <button class="tab-btn" onclick="switchTab('system')">Config & Environment</button>
    </div>

    <div id="panel-routes" class="panel active">
      <h2>Declared Routes</h2>
      <table>
        <thead>
          <tr>
            <th>Method</th>
            <th>Route Pattern</th>
            <th>Function</th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody id="routes-table-body"></tbody>
      </table>
    </div>

    <div id="panel-kv" class="panel">
      <h2>Local KV Explorer</h2>
      <div class="form-row">
        <input id="kv-key" placeholder="Key (e.g. user:123 or session:token)">
        <input id="kv-val" placeholder="JSON or string value">
        <button class="primary" onclick="setKvKey()">Set Key</button>
      </div>
      <table>
        <thead>
          <tr>
            <th>Key</th>
            <th>Value</th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody id="kv-table-body">
          <tr><td colspan="3" style="color: var(--steel);">Click Refresh to load KV keys...</td></tr>
        </tbody>
      </table>
      <div style="margin-top: 16px;">
        <button class="secondary" onclick="refreshKv()">↻ Refresh Keys</button>
      </div>
    </div>

    <div id="panel-system" class="panel">
      <h2>Project Manifest</h2>
      <pre id="config-json" style="background: var(--canvas); padding: 16px; border-radius: 2px; border: 1px solid var(--line); overflow-x: auto; font-family: var(--font-mono); font-size: 0.85rem; color: var(--ink);"></pre>
    </div>
  </div>

  <script>
    const routes = ${routesJson};
    const functions = ${functionsJson};

    function switchTab(name) {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
      event.target.classList.add('active');
      document.getElementById('panel-' + name).classList.add('active');
      if (name === 'kv') refreshKv();
    }

    function renderRoutes() {
      const tbody = document.getElementById('routes-table-body');
      tbody.innerHTML = '';
      if (!routes.length) {
        tbody.innerHTML = '<tr><td colspan="4" style="color: var(--steel);">No routes configured</td></tr>';
        return;
      }
      routes.forEach(r => {
        const tr = document.createElement('tr');
        const pattern = r.pattern || '/';
        const cleanPath = pattern.replace('/*', '');
        tr.innerHTML = \`
          <td><span class="method method-get">ANY</span></td>
          <td style="font-weight: 600;">\${pattern}</td>
          <td>\${r.function}</td>
          <td><a class="test-link" href="\${cleanPath || '/'}" target="_blank">Open ↗</a></td>
        \`;
        tbody.appendChild(tr);
      });
    }

    async function refreshKv() {
      const tbody = document.getElementById('kv-table-body');
      try {
        const res = await fetch('/__railfog/api/kv');
        const data = await res.json();
        tbody.innerHTML = '';
        if (!data.keys || !data.keys.length) {
          tbody.innerHTML = '<tr><td colspan="3" style="color: var(--steel);">No KV keys found</td></tr>';
          return;
        }
        data.keys.forEach(k => {
          const tr = document.createElement('tr');
          tr.innerHTML = \`
            <td style="font-weight: 600;">\${k.key}</td>
            <td><code>\${typeof k.value === 'object' ? JSON.stringify(k.value) : k.value}</code></td>
            <td><button class="danger" onclick="deleteKvKey('\${k.key}')">Delete</button></td>
          \`;
          tbody.appendChild(tr);
        });
      } catch (err) {
        tbody.innerHTML = \`<tr><td colspan="3" style="color: var(--stop);">Failed to load KV: \${err.message}</td></tr>\`;
      }
    }

    async function setKvKey() {
      const key = document.getElementById('kv-key').value.trim();
      const valStr = document.getElementById('kv-val').value.trim();
      if (!key) return;
      let val = valStr;
      try { val = JSON.parse(valStr); } catch {}
      await fetch('/__railfog/api/kv', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key, value: val })
      });
      document.getElementById('kv-key').value = '';
      document.getElementById('kv-val').value = '';
      refreshKv();
    }

    async function deleteKvKey(key) {
      await fetch('/__railfog/api/kv?key=' + encodeURIComponent(key), { method: 'DELETE' });
      refreshKv();
    }

    document.getElementById('config-json').textContent = JSON.stringify({ routes, functions }, null, 2);
    renderRoutes();
  </script>
</body>
</html>`;
}

export async function handleDashboardRequest(
  req: Request,
  url: URL,
  config: RailfogConfig,
  ctx: DashboardContext,
): Promise<Response> {
  const pathname = url.pathname;

  // 1. Dashboard UI HTML
  if (pathname === "/__railfog" || pathname === "/__railfog/") {
    const html = renderDashboardHtml(config, ctx);
    return new Response(html, {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }

  // 2. Local Dashboard API: GET /__railfog/api/info
  if (pathname === "/__railfog/api/info") {
    return Response.json({
      project: config.name ?? ctx.projectId,
      routes: config.routes ?? [],
      functions: config.functions ?? {},
    });
  }

  // 3. Local Dashboard API: KV explorer
  if (pathname === "/__railfog/api/kv") {
    if (req.method === "GET") {
      try {
        const listRes = await ctx.kvProvider.list([]);
        const items = listRes.keys.map((k) => ({
          key: k.key.join(":"),
          value: k.value,
        }));
        return Response.json({ keys: items });
      } catch {
        return Response.json({ keys: [] });
      }
    }

    if (req.method === "POST") {
      try {
        const body = await req.json();
        if (
          typeof body.key !== "string" ||
          body.key.trim() === "" ||
          body.value === undefined
        ) {
          return Response.json(
            { ok: false, error: "VALIDATION_FAILED: key and value required" },
            { status: 400 },
          );
        }
        const keyArr = body.key.includes(":")
          ? body.key.split(":")
          : [body.key];
        await ctx.kvProvider.set(keyArr, body.value);
        return Response.json({ ok: true });
      } catch {
        return Response.json({ ok: false }, { status: 400 });
      }
    }

    if (req.method === "DELETE") {
      const key = url.searchParams.get("key");
      if (key) {
        const keyArr = key.includes(":") ? key.split(":") : [key];
        await ctx.kvProvider.delete(keyArr);
        return Response.json({ ok: true });
      }
      return Response.json({ ok: false }, { status: 400 });
    }
  }

  return new Response("Not Found", { status: 404 });
}
