/**
 * RailFog Terminal Design System & UI Components (UX/DX Kernel)
 *
 * Provides a unified, modern terminal visual design system inspired by
 * Claude Code, Cloudflare Wrangler, and Vercel:
 * - Color palettes (24-bit TrueColor with ANSI fallback & NO_COLOR compliance)
 * - Unicode rounded cards, boxes, and dividers
 * - Modern tables with alignment and padding
 * - Animated progress bars and step counters
 * - Structured, actionable error cards with "How to fix" remediation steps
 * - Brand headers, badges, method pills, and status glyphs
 *
 * Spec references:
 * - PLAT-19: CLI developer experience and interactive output
 * - PLAT-12: Error presentation and normalization
 * - PLAT-15: Zero credential leakage
 */

import { isColorSupported } from "./spinner.ts";

// deno-lint-ignore no-control-regex
const ANSI_REGEX = /\x1b\[[0-9;?]*[a-zA-Z]/g;

/**
 * Strips ANSI escape sequences from text to measure real visible width.
 */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_REGEX, "");
}

/**
 * Calculates the visible character width of a string.
 */
export function visibleWidth(text: string): number {
  return stripAnsi(text).length;
}

/**
 * Safe ANSI color & style wrappers respecting NO_COLOR environment standard.
 */
export const colors = {
  enabled: isColorSupported(),

  // Styles
  bold: (t: string) => colors.enabled ? `\x1b[1m${t}\x1b[22m` : t,
  dim: (t: string) => colors.enabled ? `\x1b[2m${t}\x1b[22m` : t,
  italic: (t: string) => colors.enabled ? `\x1b[3m${t}\x1b[23m` : t,
  underline: (t: string) => colors.enabled ? `\x1b[4m${t}\x1b[24m` : t,

  // Basic ANSI
  black: (t: string) => colors.enabled ? `\x1b[30m${t}\x1b[39m` : t,
  red: (t: string) => colors.enabled ? `\x1b[31m${t}\x1b[39m` : t,
  green: (t: string) => colors.enabled ? `\x1b[32m${t}\x1b[39m` : t,
  yellow: (t: string) => colors.enabled ? `\x1b[33m${t}\x1b[39m` : t,
  blue: (t: string) => colors.enabled ? `\x1b[34m${t}\x1b[39m` : t,
  magenta: (t: string) => colors.enabled ? `\x1b[35m${t}\x1b[39m` : t,
  cyan: (t: string) => colors.enabled ? `\x1b[36m${t}\x1b[39m` : t,
  white: (t: string) => colors.enabled ? `\x1b[37m${t}\x1b[39m` : t,
  gray: (t: string) => colors.enabled ? `\x1b[90m${t}\x1b[39m` : t,

  // JetBrains Fleet & Darcula Palette (subtle, high-contrast, professional)
  accent: (t: string) => colors.enabled ? `\x1b[38;2;89;168;216m${t}\x1b[39m` : t, // Fleet Electric Cyan #59A8D8
  brand: (t: string) => colors.enabled ? `\x1b[38;2;152;118;170m${t}\x1b[39m` : t,  // Darcula Field Violet #9876AA
  purple: (t: string) => colors.enabled ? `\x1b[38;2;152;118;170m${t}\x1b[39m` : t, // Darcula Lilac #9876AA
  emerald: (t: string) => colors.enabled ? `\x1b[38;2;98;151;85m${t}\x1b[39m` : t,  // Darcula Doc Green #629755
  amber: (t: string) => colors.enabled ? `\x1b[38;2;229;168;75m${t}\x1b[39m` : t,   // IntelliJ Warning Amber #E5A84B
  coral: (t: string) => colors.enabled ? `\x1b[38;2;199;84;80m${t}\x1b[39m` : t,    // IntelliJ Inspection Red #C75450
  orange: (t: string) => colors.enabled ? `\x1b[38;2;204;120;50m${t}\x1b[39m` : t,  // Darcula Keyword Orange #CC7832
  slate: (t: string) => colors.enabled ? `\x1b[38;2;169;183;198m${t}\x1b[39m` : t,  // Darcula Text Slate #A9B7C6
  border: (t: string) => colors.enabled ? `\x1b[38;2;85;85;85m${t}\x1b[39m` : t,    // Darcula Gutter/Border #555555
  gutter: (t: string) => colors.enabled ? `\x1b[38;2;96;99;102m${t}\x1b[39m` : t,  // Darcula Gutter Line #606366

  // Background badges
  bgBrand: (t: string) => colors.enabled ? `\x1b[48;2;49;46;129;38;2;224;231;255m ${t} \x1b[0m` : `[${t}]`,
  bgAccent: (t: string) => colors.enabled ? `\x1b[48;2;12;74;110;38;2;224;242;254m ${t} \x1b[0m` : `[${t}]`,
  bgSuccess: (t: string) => colors.enabled ? `\x1b[48;2;6;78;59;38;2;209;250;229m ${t} \x1b[0m` : `[${t}]`,
  bgWarn: (t: string) => colors.enabled ? `\x1b[48;2;120;53;15;38;2;254;243;199m ${t} \x1b[0m` : `[${t}]`,
  bgError: (t: string) => colors.enabled ? `\x1b[48;2;127;29;29;38;2;254;226;226m ${t} \x1b[0m` : `[${t}]`,
  bgMuted: (t: string) => colors.enabled ? `\x1b[48;2;30;41;59;38;2;203;213;225m ${t} \x1b[0m` : `[${t}]`,
};

/**
 * Clean ASCII icons and status tags.
 * Pure 7-bit ASCII characters guarantee universal cross-platform rendering
 * on all terminal emulators, codepages, and shell environments.
 */
export const glyphs = {
  success: colors.green("[+]"),
  fail: colors.red("[-]"),
  info: colors.accent("[i]"),
  warn: colors.amber("[!]"),
  arrow: colors.accent("-->"),
  subArrow: colors.slate("|-->"),
  bullet: colors.brand("*"),
  sparkle: colors.purple("*"),
  cloud: colors.accent("[cloud]"),
  shield: colors.brand("[sec]"),
  key: colors.amber("[key]"),
  box: colors.accent("[pkg]"),
  rocket: colors.accent("=>"),
  dot: colors.dim("-"),
};

/**
 * Renders an HTTP method pill.
 */
export function renderMethodBadge(method: string): string {
  const m = method.toUpperCase().trim();
  switch (m) {
    case "GET":
      return colors.enabled ? colors.accent(colors.bold("GET   ")) : "GET   ";
    case "POST":
      return colors.enabled ? colors.emerald(colors.bold("POST  ")) : "POST  ";
    case "PUT":
      return colors.enabled ? colors.amber(colors.bold("PUT   ")) : "PUT   ";
    case "DELETE":
      return colors.enabled ? colors.coral(colors.bold("DELETE")) : "DELETE";
    case "PATCH":
      return colors.enabled ? colors.purple(colors.bold("PATCH ")) : "PATCH ";
    default:
      return colors.enabled ? colors.slate(colors.bold(m.padEnd(6))) : m.padEnd(6);
  }
}

/**
 * Pads a string to a given visible width with alignment.
 */
export function padText(
  text: string,
  width: number,
  align: "left" | "right" | "center" = "left",
): string {
  const vLen = visibleWidth(text);
  if (vLen >= width) return text;
  const totalPad = width - vLen;
  if (align === "right") {
    return " ".repeat(totalPad) + text;
  }
  if (align === "center") {
    const leftPad = Math.floor(totalPad / 2);
    const rightPad = totalPad - leftPad;
    return " ".repeat(leftPad) + text + " ".repeat(rightPad);
  }
  return text + " ".repeat(totalPad);
}

/**
 * Gets the current terminal width with safe fallback.
 */
export function getTerminalWidth(): number {
  try {
    if (typeof Deno.consoleSize === "function") {
      return Math.min(Deno.consoleSize().columns || 80, 100);
    }
  } catch {
    // Fallback
  }
  return 80;
}

/**
 * Renders a clean card with pure ASCII borders.
 *
 * +-- Title -----------------------------+
 * |   Content                            |
 * +--------------------------------------+
 */
export function renderCard(
  title: string,
  lines: string[],
  options?: {
    borderColor?: (t: string) => string;
    width?: number;
    padding?: boolean;
  },
): string {
  const colorFn = options?.borderColor ?? colors.border;
  const termWidth = options?.width ?? Math.min(getTerminalWidth(), 80);

  // Measure content lines
  const pad = options?.padding !== false;
  let maxContentWidth = title ? visibleWidth(title) + 6 : 20;
  for (const l of lines) {
    maxContentWidth = Math.max(maxContentWidth, visibleWidth(l));
  }
  const innerWidth = Math.max(maxContentWidth, Math.min(termWidth - 4, 76));

  const out: string[] = [];

  // Top border: +-- Title --------------------+
  const titlePart = title ? ` ${colors.bold(title)} ` : "-";
  const titleVis = title ? visibleWidth(title) + 2 : 1;
  const topDashes = Math.max(0, innerWidth - titleVis + 1);
  out.push(colorFn("+--") + titlePart + colorFn("-".repeat(topDashes) + "+"));

  // Padding top
  if (pad) {
    out.push(colorFn("|") + " ".repeat(innerWidth + 2) + colorFn("|"));
  }

  // Content lines
  for (const l of lines) {
    const paddedLine = padText(l, innerWidth);
    out.push(colorFn("| ") + paddedLine + colorFn(" |"));
  }

  // Padding bottom
  if (pad) {
    out.push(colorFn("|") + " ".repeat(innerWidth + 2) + colorFn("|"));
  }

  // Bottom border: +---------------------------+
  out.push(colorFn("+" + "-".repeat(innerWidth + 2) + "+"));

  return out.join("\n");
}

/**
 * Renders an actionable ASCII error card with remediation hints.
 */
export function renderErrorCard(err: {
  code: string;
  message: string;
  location?: string;
  hint?: string;
  solution?: string;
  docs?: string;
  requestId?: string;
}): string {
  const lines: string[] = [];

  lines.push(`${colors.coral(colors.bold("[-]"))}  ${colors.bold(err.message)}`);

  if (err.location) {
    lines.push("");
    lines.push(`   ${colors.dim("Location:")} ${colors.slate(err.location)}`);
  }

  const remedy = err.solution || err.hint;
  if (remedy) {
    lines.push("");
    lines.push(`   ${colors.amber(colors.bold(">> How to fix:"))}`);
    const remedyLines = remedy.split("\n");
    for (const r of remedyLines) {
      lines.push(`   ${colors.slate(r)}`);
    }
  }

  if (err.docs) {
    lines.push("");
    lines.push(`   ${colors.dim("Reference:")} ${colors.underline(colors.brand(err.docs))}`);
  }

  if (err.requestId) {
    lines.push("");
    lines.push(`   ${colors.dim("Request ID:")} ${colors.dim(err.requestId)}`);
  }

  return renderCard(`Error [${err.code}]`, lines, {
    borderColor: colors.coral,
    padding: true,
  });
}

/**
 * Renders a table with pure ASCII borders.
 */
export function renderModernTable(
  headers: string[],
  rows: string[][],
  options?: {
    alignments?: Array<"left" | "right" | "center">;
    style?: "ascii" | "clean";
  },
): string {
  if (!headers || headers.length === 0) return "";
  const safeRows = rows || [];
  const colCount = Math.max(headers.length, ...safeRows.map((r) => r.length));
  const colWidths: number[] = new Array(colCount).fill(0);

  for (let c = 0; c < colCount; c++) {
    const h = headers[c] ?? "";
    let maxW = visibleWidth(h);
    for (const r of safeRows) {
      const cell = r[c] ?? "";
      maxW = Math.max(maxW, visibleWidth(cell));
    }
    colWidths[c] = Math.max(1, maxW);
  }

  const alignments = options?.alignments ?? [];
  const style = options?.style ?? "ascii";

  if (style === "ascii") {
    const out: string[] = [];
    // +------+------+
    const top = "+" + colWidths.map((w) => "-".repeat(w + 2)).join("+") + "+";
    out.push(colors.border(top));

    // | Header | Header |
    const hCells = headers.map((h, i) =>
      " " + colors.bold(colors.accent(padText(h, colWidths[i], alignments[i] ?? "left"))) + " "
    );
    out.push(colors.border("|") + hCells.join(colors.border("|")) + colors.border("|"));

    // +------+------+
    const mid = "+" + colWidths.map((w) => "-".repeat(w + 2)).join("+") + "+";
    out.push(colors.border(mid));

    // | Data | Data |
    for (const row of safeRows) {
      const cells = [];
      for (let i = 0; i < colCount; i++) {
        const val = row[i] ?? "";
        cells.push(" " + padText(val, colWidths[i], alignments[i] ?? "left") + " ");
      }
      out.push(colors.border("|") + cells.join(colors.border("|")) + colors.border("|"));
    }

    // +------+------+
    const bot = "+" + colWidths.map((w) => "-".repeat(w + 2)).join("+") + "+";
    out.push(colors.border(bot));
    return out.join("\n");
  }

  // Clean / minimal style
  const out: string[] = [];
  const hCells = headers.map((h, i) =>
    colors.bold(colors.accent(padText(h, colWidths[i], alignments[i] ?? "left")))
  );
  out.push("  " + hCells.join("   "));

  const divCells = colWidths.map((w) => "-".repeat(w));
  out.push(colors.border("  " + divCells.join("   ")));

  for (const row of safeRows) {
    const cells = [];
    for (let i = 0; i < colCount; i++) {
      const val = row[i] ?? "";
      cells.push(padText(val, colWidths[i], alignments[i] ?? "left"));
    }
    out.push("  " + cells.join("   "));
  }

  return out.join("\n");
}

/**
 * Renders an ASCII visual progress bar.
 * Example: [==========----------] 50%  (2.4 MB / 4.8 MB)
 */
export function renderProgressBar(
  current: number,
  total: number,
  options?: {
    width?: number;
    label?: string;
    unit?: string;
  },
): string {
  const width = options?.width ?? 24;
  const pct = total > 0 ? Math.min(1, Math.max(0, current / total)) : 0;
  const filledCount = Math.round(pct * width);
  const emptyCount = width - filledCount;

  const filledChar = "=";
  const emptyChar = "-";

  const bar = colors.accent(filledChar.repeat(filledCount)) +
    colors.border(emptyChar.repeat(emptyCount));
  const percentText = `${Math.round(pct * 100)}%`.padStart(4);

  let extra = "";
  if (options?.label) {
    extra = ` ${colors.dim(options.label)}`;
  } else if (options?.unit) {
    extra = ` ${colors.dim(`(${current}/${total} ${options.unit})`)}`;
  }

  return `[${bar}] ${colors.bold(percentText)}${extra}`;
}

/**
 * Renders the official RailFog CLI Brand Header in pure ASCII.
 */
export function renderBrandHeader(version: string, envName: string = "production"): string {
  const logo = colors.brand(colors.bold("[RailFog]"));
  const verBadge = colors.bgMuted(`v${version}`);
  const envBadge = envName === "production"
    ? colors.bgSuccess("production")
    : colors.bgAccent(envName);
  const tagline = colors.dim("Minimal Edge Infrastructure - Functions - KV - Objects - Queues");

  return [
    `  ${logo}  ${verBadge}  ${envBadge}`,
    `  ${tagline}`,
  ].join("\n");
}

/**
 * Formats a key-value list with consistent label padding and subtle colors.
 */
export function renderKvList(entries: Array<[string, string]>): string {
  const maxKeyLen = Math.max(...entries.map(([k]) => visibleWidth(k)));
  return entries
    .map(([k, v]) => `  ${colors.dim(padText(k + ":", maxKeyLen + 2))} ${v}`)
    .join("\n");
}

/**
 * Node in a JetBrains-style hierarchical tree structure.
 */
export interface TreeNode {
  label: string;
  value?: string;
  badge?: string;
  children?: TreeNode[];
}

/**
 * Renders an IntelliJ Project / Services style tree view in pure ASCII.
 *
 * [Project] cloud-demo (C:\path\to\dir)
 *  |
 *  +-- [Functions]
 *  |    |-- api                         --> functions/api.ts
 *  |    \-- worker                      --> functions/worker.ts
 *  |
 *  \-- [Storage]
 *       |-- KV                          --> SQLite
 *       \-- Objects                     --> LocalFS
 */
export function renderTree(
  rootTitle: string,
  nodes: TreeNode[],
  options?: {
    rootPrefix?: string;
    showRoot?: boolean;
  },
): string {
  const lines: string[] = [];
  const rootPref = options?.rootPrefix ?? "[Project]";

  if (options?.showRoot !== false) {
    lines.push(`${colors.bold(colors.brand(rootPref))} ${colors.bold(rootTitle)}`);
    lines.push(` ${colors.border("|")}`);
  }

  function walk(items: TreeNode[], prefix: string, isRootLevel: boolean): void {
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const isLast = i === items.length - 1;
      const connector = isLast ? "\\-- " : "|-- ";
      const branch = isRootLevel
        ? (isLast ? "\\-- " : "+-- ")
        : connector;

      const badgeStr = item.badge ? ` ${colors.dim(`[${item.badge}]`)}` : "";
      const valStr = item.value ? `  ${colors.accent("-->")}  ${colors.slate(item.value)}` : "";
      const labelStr = item.children && item.children.length > 0
        ? colors.bold(colors.accent(item.label))
        : colors.slate(item.label);

      lines.push(`${prefix}${colors.border(branch)}${labelStr}${badgeStr}${valStr}`);

      if (item.children && item.children.length > 0) {
        const nextPrefix = prefix + (isLast ? "    " : "|   ");
        walk(item.children, nextPrefix, false);
      }
    }
  }

  walk(nodes, " ", true);
  return lines.join("\n");
}

/**
 * Diagnostic issue representation for JetBrains Qodana style inspection.
 */
export interface InspectionIssue {
  severity: "error" | "warning" | "info";
  code: string;
  message: string;
  file?: string;
  line?: number;
  column?: number;
  snippet?: string;
  hint?: string;
  ruleUrl?: string;
}

/**
 * Renders a Qodana-inspired code inspection gutter with line numbers and caret underlines.
 *
 * [!] WARN  [PLAT-11] RouteShadowed: Pattern '/api/users' shadows '/api/*'
 *     --> railfog.toml:14:5
 *      |
 *   14 | pattern = "/api/users"
 *      |           ^^^^^^^^^^^^ route pattern declaration
 *      |
 *     [Fix] Place more specific routes before wildcards in railfog.toml
 */
export function renderInspectionGutter(issue: InspectionIssue): string {
  const lines: string[] = [];
  const tag = issue.severity === "error"
    ? `${colors.red(colors.bold("[-] ERROR"))} [${colors.bold(issue.code)}]`
    : issue.severity === "warning"
    ? `${colors.amber(colors.bold("[!] WARN "))} [${colors.bold(issue.code)}]`
    : `${colors.accent(colors.bold("[i] INFO "))} [${colors.bold(issue.code)}]`;

  lines.push(`${tag} ${colors.bold(issue.message)}`);

  const fileLoc = issue.file
    ? `    ${colors.accent("-->")} ${colors.slate(issue.file)}${issue.line ? `:${issue.line}` : ""}${issue.column ? `:${issue.column}` : ""}`
    : "";
  if (fileLoc) {
    lines.push(fileLoc);
    lines.push(`     ${colors.border("|")}`);
  }

  if (issue.snippet && issue.line) {
    const lineNum = String(issue.line).padStart(4, " ");
    lines.push(`  ${colors.border(lineNum)} ${colors.border("|")} ${issue.snippet}`);
    if (issue.column !== undefined) {
      const padCol = " ".repeat(Math.max(0, issue.column - 1));
      const underline = "^".repeat(8);
      lines.push(`       ${colors.border("|")} ${padCol}${colors.coral(underline)}`);
    }
    lines.push(`     ${colors.border("|")}`);
  }

  if (issue.hint) {
    lines.push(`     ${colors.border("|")}  ${colors.amber(colors.bold("[Fix]"))} ${colors.slate(issue.hint)}`);
  }

  if (issue.ruleUrl) {
    lines.push(`     ${colors.border("|")}  ${colors.dim("[Ref]")} ${colors.underline(colors.brand(issue.ruleUrl))}`);
  }

  return lines.join("\n");
}

/**
 * Renders an IDE status bar telemetry strip.
 *
 * [ Project: cloud-demo | Functions: 3 | Routes: 6 | Status: Ready ]
 */
export function renderStatusBar(
  sections: Array<{ label: string; value: string }>,
): string {
  const formatted = sections.map((s) => {
    return `${colors.dim(s.label)}: ${colors.bold(colors.accent(s.value))}`;
  });
  return `  [ ${formatted.join(colors.border(" | "))} ]`;
}

/**
 * Renders a discrete build & deployment step in JetBrains Build Timeline style.
 *
 * [1/4] Inspecting configuration & capabilities ...   [DONE] (12ms)
 */
export function renderBuildStep(
  step: number,
  total: number,
  title: string,
  status: "RUNNING" | "DONE" | "FAIL",
  durationMs?: number,
): string {
  const stepPrefix = `[${step}/${total}]`;
  const durStr = durationMs !== undefined ? ` ${colors.dim(`(${durationMs}ms)`)}` : "";
  let badge = "";

  switch (status) {
    case "DONE":
      badge = colors.green("[DONE]");
      break;
    case "FAIL":
      badge = colors.red("[FAIL]");
      break;
    case "RUNNING":
      badge = colors.amber("[BUSY]");
      break;
  }

  return `  ${colors.bold(colors.accent(stepPrefix))} ${title.padEnd(46)} ${badge}${durStr}`;
}
