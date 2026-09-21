import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  animateSignalLantern,
  animateSteamTrain,
  colors,
  getTerminalWidth,
  renderBoardingPass,
  renderBrandHeader,
  renderCard,
  renderCompetitiveMatrix,
  renderDepartureBoard,
  renderErrorCard,
  renderFreightExpressCard,
  renderModernTable,
  renderProgressBar,
  renderReleaseTrainCard,
  renderRouteSimulatorCard,
  renderSignalLantern,
  renderStationSignalBoard,
  renderTrainLogo,
  stripAnsi,
  visibleWidth,
  wrapText,
} from "../../cli/ui.ts";

Deno.test("UI (Unit): wrapText wraps long lines at word boundaries", () => {
  const text = "This is a long sentence that should be wrapped across multiple lines cleanly.";
  const wrapped = wrapText(text, 25);
  for (const line of wrapped) {
    assertEquals(visibleWidth(line) <= 25, true, `Line should be <= 25 cols: "${line}"`);
  }
  assertEquals(wrapped.join(" "), text);
});

Deno.test("UI (Unit): wrapText preserves leading indentation on wrapped continuation lines", () => {
  const text = "   init, add, status, check, dev, deploy, undeploy, rollback, export, import, secrets";
  const wrapped = wrapText(text, 35);
  assertEquals(wrapped.length > 1, true, "Should wrap into multiple lines");
  for (const line of wrapped) {
    assertEquals(line.startsWith("   "), true, `Continuation line should preserve indent: "${line}"`);
    assertEquals(visibleWidth(line) <= 35, true, `Line width <= 35: "${line}"`);
  }
});

Deno.test("UI (Unit): wrapText handles ANSI escape sequences without measuring escape chars", () => {
  const colored = `${colors.coral("Error:")} ${colors.bold("This is a styled error message that must wrap without breaking color codes.")}`;
  const wrapped = wrapText(colored, 30);
  for (const line of wrapped) {
    assertEquals(visibleWidth(line) <= 30, true, `Visible width should be <= 30: "${stripAnsi(line)}"`);
  }
});

Deno.test("UI (Unit): renderCard produces uniform width across top border, content, and bottom border", () => {
  const card = renderCard("Test Card", [
    "Short line",
    "A much longer line that provides more details inside the card component",
  ], { width: 60 });

  const lines = card.split("\n");
  const firstLineWidth = visibleWidth(lines[0]);

  for (let i = 0; i < lines.length; i++) {
    const w = visibleWidth(lines[i]);
    assertEquals(w, firstLineWidth, `Line ${i} width (${w}) must equal first line width (${firstLineWidth})`);
  }
});

Deno.test("UI (Unit): renderCard automatically wraps long lines without overflowing box width", () => {
  const longContent = "A".repeat(120);
  const card = renderCard("Overflow Test", [longContent], { width: 50 });

  const lines = card.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const w = visibleWidth(lines[i]);
    assertEquals(w <= 50, true, `Line ${i} width (${w}) should be <= 50 cols`);
  }
});

Deno.test("UI (Unit): renderErrorCard formats UNKNOWN_COMMAND responsively without border corruption", () => {
  const card = renderErrorCard({
    code: "UNKNOWN_COMMAND",
    message: 'Error: Unknown command "xyz". Available commands: init, add, status, check, dev, deploy, undeploy, rollback, export, import, secrets, logs, usage, cost, login, logout, whoami, upgrade, update, sync, completions',
    solution: 'Did you mean "rail dev"?\nRun \'rail --help\' to see all available commands.',
  });

  const lines = card.split("\n");
  const expectedWidth = visibleWidth(lines[0]);

  for (let i = 0; i < lines.length; i++) {
    const w = visibleWidth(lines[i]);
    assertEquals(w, expectedWidth, `Error card line ${i} width (${w}) must match top border (${expectedWidth})`);
  }

  assertStringIncludes(card, "Unknown command");
  assertStringIncludes(card, "Available commands:");
  assertStringIncludes(card, "How to fix:");
});

Deno.test("UI (Unit): getTerminalWidth returns a safe positive number", () => {
  const w = getTerminalWidth();
  assertEquals(w >= 40, true, `Terminal width should be at least 40: ${w}`);
});

Deno.test("UI (Unit): renderTrainLogo produces the clean 8-line pixel-art train locomotive with track", () => {
  const train = renderTrainLogo({ colored: false });
  assertEquals(train.length, 9);
  assertEquals(train[0], "       ┌──────┐");
  assertEquals(train[1], "         ████");
  assertEquals(train[2], "   ┌──────────────┐");
  assertEquals(train[3], "   │████  ██  ████│");
  assertEquals(train[4], "   │██████████████│");
  assertEquals(train[5], "   │██████████████│");
  assertEquals(train[6], "   │██  ██  ██  ██│");
  assertEquals(train[7], "   │██  ██  ██  ██│");
  assertEquals(train[8], "  ══════════════════");
});

Deno.test("UI (Unit): renderTrainLogo supports compact mode without track", () => {
  const compact = renderTrainLogo({ includeTrack: false, colored: false });
  assertEquals(compact.length, 8);
  assertEquals(compact[0], "       ┌──────┐");
});

Deno.test("UI (Unit): renderTrainLogo with pulseFrame renders valid ANSI strings", () => {
  const framed = renderTrainLogo({ pulseFrame: 2, colored: true });
  assertEquals(framed.length, 9);
  assertStringIncludes(stripAnsi(framed[0]), "┌──────┐");
});

Deno.test("UI (Unit): renderTrainLogo supports white, gray, and white-gray monochrome schemes", () => {
  const whiteScheme = renderTrainLogo({ colorScheme: "white", colored: true });
  assertEquals(whiteScheme.length, 9);
  assertStringIncludes(whiteScheme[0], "┌──────┐");

  const grayScheme = renderTrainLogo({ colorScheme: "gray", colored: true });
  assertEquals(grayScheme.length, 9);
  assertStringIncludes(grayScheme[0], "┌──────┐");

  const hybridScheme = renderTrainLogo({ colorScheme: "white-gray", colored: true });
  assertEquals(hybridScheme.length, 9);
  assertStringIncludes(hybridScheme[0], "┌──────┐");
});

Deno.test("UI (Unit): renderBoardingPass outputs formatted boarding pass card", () => {
  const pass = renderBoardingPass({
    orgId: "acme-corp",
    callerId: "dev-laptop",
    tokenDisplay: "rfk_..._xyz",
    controlUrl: "https://control.railway.app",
  });
  assertStringIncludes(pass, "RailFog Cloud Boarding Pass");
  assertStringIncludes(pass, "PASSENGER:");
  assertStringIncludes(pass, "acme-corp");
  assertStringIncludes(pass, "dev-laptop");
  assertStringIncludes(pass, "rfk_..._xyz");
  assertStringIncludes(pass, "┌──────┐");
  assertStringIncludes(pass, "══════════════════");
});

Deno.test("UI (Unit): animateSteamTrain executes in duration mode without throwing", async () => {
  await animateSteamTrain({ durationMs: 1, fps: 10, version: "0.8.0" });
});

Deno.test("UI (Unit): renderBrandHeader renders side-by-side Claude Code style layout on wide screens", () => {
  const banner = renderBrandHeader("0.8.0", "production", { width: 80 });
  assertStringIncludes(banner, "RailFog");
  assertStringIncludes(banner, "v0.8.0");
  assertStringIncludes(banner, "production");
  assertStringIncludes(banner, "┌──────┐");
  assertStringIncludes(banner, "Engine:");
  assertStringIncludes(banner, "Storage:");
});

Deno.test("UI (Unit): renderBrandHeader renders stacked layout on narrow screens", () => {
  const banner = renderBrandHeader("0.8.0", "production", { width: 50 });
  assertStringIncludes(banner, "RailFog");
  assertStringIncludes(banner, "┌──────┐");
  assertStringIncludes(banner, "Minimal Application Infrastructure");
});

Deno.test("UI (Unit): renderBrandHeader renders ultra-compact badge on tiny screens", () => {
  const banner = renderBrandHeader("0.8.0", "production", { width: 35 });
  assertStringIncludes(banner, "RailFog");
  assertStringIncludes(banner, "v0.8.0");
});

Deno.test("UI (Unit): renderReleaseTrainCard outputs structured train deployment manifest", () => {
  const card = renderReleaseTrainCard({
    project: "demo-service",
    revision: "rev_01J8Z...",
    duration: "24ms",
    runtimeUrl: "http://127.0.0.1:8080",
    functionsCount: 3,
    routesCount: 5,
  });
  assertStringIncludes(card, "Release Train: Deployment Manifest");
  assertStringIncludes(card, "demo-service");
  assertStringIncludes(card, "rev_01J8Z...");
  assertStringIncludes(card, "┌──────┐");
  assertStringIncludes(card, "ALL CARS COUPLED & ACTIVE");
});

Deno.test("UI (Unit): renderDepartureBoard formats station timetable table", () => {
  const board = renderDepartureBoard("demo-service", [
    { track: 1, platform: "HTTP", route: "/api/*", functionName: "api", target: "functions/api.ts", status: "READY" },
    { track: 2, platform: "QUEUE", route: "job-events", functionName: "worker", target: "functions/worker.ts", status: "READY" },
  ]);
  assertStringIncludes(board, "Station Departure Board");
  assertStringIncludes(board, "TRACK");
  assertStringIncludes(board, "PLATFORM");
  assertStringIncludes(board, "/api/*");
  assertStringIncludes(board, "job-events");
});

Deno.test("UI (Unit): renderFreightExpressCard formats state export and restore manifests", () => {
  const expCard = renderFreightExpressCard({
    mode: "export",
    projectName: "demo-service",
    backupId: "bak_01...",
    location: "./backup.json",
    stats: [["• KV:", "12 keys"], ["• Objects:", "4 objs"]],
  });
  assertStringIncludes(expCard, "Freight Express: State Export");
  assertStringIncludes(expCard, "demo-service");
  assertStringIncludes(expCard, "bak_01...");
  assertStringIncludes(expCard, "┌──────┐");

  const resCard = renderFreightExpressCard({
    mode: "restore",
    projectName: "demo-service",
    stats: [["• KV Keys:", "12 restored"]],
  });
  assertStringIncludes(resCard, "Freight Express: State Restore");
  assertStringIncludes(resCard, "RESTORE COMPLETE");
});

Deno.test("UI (Unit): renderSignalLantern formats 3-aspect railway signal lantern correctly", () => {
  const aspect0 = stripAnsi(renderSignalLantern(0));
  assertEquals(aspect0, "[ ● ── ○ ── ○ ]");

  const aspect1 = stripAnsi(renderSignalLantern(1));
  assertEquals(aspect1, "[ ○ ── ● ── ○ ]");

  const aspect2 = stripAnsi(renderSignalLantern(2));
  assertEquals(aspect2, "[ ○ ── ○ ── ● ]");

  const aspect3 = stripAnsi(renderSignalLantern(3));
  assertEquals(aspect3, "[ ● ── ● ── ● ]");
});

Deno.test("UI (Unit): animateSignalLantern executes without throwing", async () => {
  await animateSignalLantern({ delayMs: 1, steps: ["Step 1", "Step 2"] });
});

Deno.test("UI (Unit): renderStationSignalBoard formats multi-track diagnostics correctly", () => {
  const board = renderStationSignalBoard({
    projectName: "test-station",
    isolateBootMs: 0.42,
    overallHealthy: true,
    signals: [
      { id: 1, name: "V8 Cold Start", status: "active", statusText: "PASS", detail: "Local isolate ready in 0.42ms" },
      { id: 2, name: "Storage Twin", status: "active", statusText: "PASS", detail: "SQLite backend responsive" },
    ],
  });
  assertStringIncludes(board, "RailFog Station Signal Board");
  assertStringIncludes(board, "test-station");
  assertStringIncludes(board, "V8 Cold Start");
  assertStringIncludes(board, "Storage Twin");
  assertStringIncludes(board, "0.42ms");
  assertStringIncludes(board, "PASS");
});

Deno.test("UI (Unit): renderRouteSimulatorCard displays route simulation metrics", () => {
  const card = renderRouteSimulatorCard({
    method: "POST",
    path: "/api/orders/checkout",
    matchedPattern: "/api/orders/*",
    specificityScore: 21,
    functionName: "orders-api",
    entrypoint: "functions/orders.ts",
    isolateBootMs: 0.35,
    permissions: {
      kv: ["orders_kv"],
      objects: [],
      queues: ["order_events"],
      network: ["api.stripe.com"],
    },
  });
  assertStringIncludes(card, "Edge Route Dispatch Simulator");
  assertStringIncludes(card, "/api/orders/checkout");
  assertStringIncludes(card, "/api/orders/*");
  assertStringIncludes(card, "orders-api");
  assertStringIncludes(card, "functions/orders.ts");
  assertStringIncludes(card, "orders_kv");
  assertStringIncludes(card, "api.stripe.com");
});

Deno.test("UI (Unit): renderCompetitiveMatrix formats architecture comparison table without emojis", () => {
  const matrix = renderCompetitiveMatrix();
  assertStringIncludes(matrix, "RailFog vs AWS Lambda vs Cloudflare Workers");
  assertStringIncludes(matrix, "AWS Lambda");
  assertStringIncludes(matrix, "Cloudflare Workers");
  assertStringIncludes(matrix, "Local Offline Parity");
  assertStringIncludes(matrix, "100% Digital Twin (SQLite/FS)");
  assertStringIncludes(matrix, "Disaster Recovery");
  // Ensure no emojis
  assertEquals(/[\u{1F300}-\u{1F9FF}]/u.test(matrix), false, "Competitive matrix must have 0 emojis");
});

Deno.test("UI (Unit): renderProgressBar defaults to locomotive track style with bumpers and engine head", () => {
  const bar = stripAnsi(renderProgressBar(50, 100, { width: 20 }));
  assertStringIncludes(bar, "╟");
  assertStringIncludes(bar, "╢");
  assertStringIncludes(bar, "►");
  assertStringIncludes(bar, "50%");
});

Deno.test("UI (Unit): renderProgressBar renders 100% arrival state with station buffer", () => {
  const bar = stripAnsi(renderProgressBar(100, 100, { width: 20 }));
  assertStringIncludes(bar, "╟");
  assertStringIncludes(bar, "╢");
  assertStringIncludes(bar, "■");
  assertStringIncludes(bar, "100%");
  assertStringIncludes(bar, "[ARRIVED]");
});

Deno.test("UI (Unit): renderProgressBar renders cross-tie sleepers style", () => {
  const bar = stripAnsi(renderProgressBar(50, 100, { width: 24, style: "sleepers" }));
  assertStringIncludes(bar, "╞");
  assertStringIncludes(bar, "╡");
  assertStringIncludes(bar, "●");
  assertStringIncludes(bar, "50%");
});

Deno.test("UI (Unit): renderProgressBar renders JetBrains fleet block style", () => {
  const bar = stripAnsi(renderProgressBar(50, 100, { width: 20, style: "fleet" }));
  assertStringIncludes(bar, "╟");
  assertStringIncludes(bar, "╢");
  assertStringIncludes(bar, "▰");
  assertStringIncludes(bar, "▱");
  assertStringIncludes(bar, "50%");
});

Deno.test("UI (Unit): renderProgressBar renders classic ASCII fallback", () => {
  const bar = stripAnsi(renderProgressBar(50, 100, { width: 20, style: "ascii" }));
  assertStringIncludes(bar, "[");
  assertStringIncludes(bar, "]");
  assertStringIncludes(bar, "=");
  assertStringIncludes(bar, "-");
  assertStringIncludes(bar, "50%");
});

Deno.test("UI (Unit): renderProgressBar renders animated shimmer pulse on track", () => {
  const bar = stripAnsi(renderProgressBar(50, 100, { width: 24, frame: 2 }));
  assertStringIncludes(bar, "o");
  assertStringIncludes(bar, "►");
});


