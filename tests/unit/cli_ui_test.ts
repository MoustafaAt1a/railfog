import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  animateSteamTrain,
  colors,
  getTerminalWidth,
  renderBoardingPass,
  renderBrandHeader,
  renderCard,
  renderErrorCard,
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

