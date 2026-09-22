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
// deno-lint-ignore no-control-regex
const ANSI_PREFIX_REGEX = /^\x1b\[[0-9;?]*[a-zA-Z]/;

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
  accent: (t: string) =>
    colors.enabled ? `\x1b[38;2;89;168;216m${t}\x1b[39m` : t, // Fleet Electric Cyan #59A8D8
  brand: (t: string) =>
    colors.enabled ? `\x1b[38;2;152;118;170m${t}\x1b[39m` : t, // Darcula Field Violet #9876AA
  purple: (t: string) =>
    colors.enabled ? `\x1b[38;2;152;118;170m${t}\x1b[39m` : t, // Darcula Lilac #9876AA
  emerald: (t: string) =>
    colors.enabled ? `\x1b[38;2;98;151;85m${t}\x1b[39m` : t, // Darcula Doc Green #629755
  amber: (t: string) =>
    colors.enabled ? `\x1b[38;2;229;168;75m${t}\x1b[39m` : t, // IntelliJ Warning Amber #E5A84B
  coral: (t: string) => colors.enabled ? `\x1b[38;2;199;84;80m${t}\x1b[39m` : t, // IntelliJ Inspection Red #C75450
  orange: (t: string) =>
    colors.enabled ? `\x1b[38;2;204;120;50m${t}\x1b[39m` : t, // Darcula Keyword Orange #CC7832
  slate: (t: string) =>
    colors.enabled ? `\x1b[38;2;169;183;198m${t}\x1b[39m` : t, // Darcula Text Slate #A9B7C6
  border: (t: string) => colors.enabled ? `\x1b[38;2;85;85;85m${t}\x1b[39m` : t, // Darcula Gutter/Border #555555
  gutter: (t: string) =>
    colors.enabled ? `\x1b[38;2;96;99;102m${t}\x1b[39m` : t, // Darcula Gutter Line #606366

  // Background badges
  bgBrand: (t: string) =>
    colors.enabled
      ? `\x1b[48;2;49;46;129;38;2;224;231;255m ${t} \x1b[0m`
      : `[${t}]`,
  bgAccent: (t: string) =>
    colors.enabled
      ? `\x1b[48;2;12;74;110;38;2;224;242;254m ${t} \x1b[0m`
      : `[${t}]`,
  bgSuccess: (t: string) =>
    colors.enabled
      ? `\x1b[48;2;6;78;59;38;2;209;250;229m ${t} \x1b[0m`
      : `[${t}]`,
  bgWarn: (t: string) =>
    colors.enabled
      ? `\x1b[48;2;120;53;15;38;2;254;243;199m ${t} \x1b[0m`
      : `[${t}]`,
  bgError: (t: string) =>
    colors.enabled
      ? `\x1b[48;2;127;29;29;38;2;254;226;226m ${t} \x1b[0m`
      : `[${t}]`,
  bgMuted: (t: string) =>
    colors.enabled
      ? `\x1b[48;2;30;41;59;38;2;203;213;225m ${t} \x1b[0m`
      : `[${t}]`,
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
      return colors.enabled
        ? colors.slate(colors.bold(m.padEnd(6)))
        : m.padEnd(6);
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
      const cols = Deno.consoleSize().columns;
      if (typeof cols === "number" && cols > 0) {
        return Math.max(cols, 40);
      }
    }
  } catch {
    // Fallback
  }
  return 80;
}

/**
 * Wraps text into multiple lines respecting ANSI escape sequences and word boundaries.
 */
export function wrapText(text: string, maxWidth: number): string[] {
  if (maxWidth <= 10) maxWidth = 10;
  if (visibleWidth(text) <= maxWidth) {
    return [text];
  }

  const lines: string[] = [];
  const paragraphs = text.split("\n");

  for (const para of paragraphs) {
    if (visibleWidth(para) <= maxWidth) {
      lines.push(para);
      continue;
    }

    const indentMatch = para.match(/^(\s+)/);
    const lineIndent = indentMatch ? indentMatch[1] : "";
    const trimmedPara = para.trimStart();
    const words = trimmedPara.split(/\s+/);
    let currentLine = lineIndent;

    for (const word of words) {
      if (!word) continue;

      if (currentLine === lineIndent) {
        if (visibleWidth(currentLine + word) > maxWidth) {
          // Hard wrap a single word that exceeds maxWidth
          let rem = word;
          while (visibleWidth(currentLine + rem) > maxWidth) {
            let sliceIdx = 0;
            let curVis = visibleWidth(currentLine);
            while (sliceIdx < rem.length && curVis < maxWidth) {
              if (rem[sliceIdx] === "\x1b") {
                const m = rem.slice(sliceIdx).match(ANSI_PREFIX_REGEX);
                if (m) {
                  sliceIdx += m[0].length;
                  continue;
                }
              }
              sliceIdx++;
              curVis = visibleWidth(currentLine + rem.slice(0, sliceIdx));
            }
            lines.push(currentLine + rem.slice(0, sliceIdx));
            rem = rem.slice(sliceIdx);
            currentLine = lineIndent;
          }
          currentLine = lineIndent + rem;
        } else {
          currentLine += word;
        }
      } else {
        const candidate = currentLine + " " + word;
        if (visibleWidth(candidate) <= maxWidth) {
          currentLine = candidate;
        } else {
          lines.push(currentLine);
          currentLine = lineIndent + word;
        }
      }
    }

    if (currentLine && currentLine !== lineIndent) {
      lines.push(currentLine);
    }
  }

  return lines;
}

/**
 * Renders a clean card with pure ASCII borders.
 * Automatically wraps content to fit within the terminal boundaries.
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
    maxWidth?: number;
    padding?: boolean;
    borderStyle?: "ascii" | "unicode";
  },
): string {
  const colorFn = options?.borderColor ?? colors.border;
  const termWidth = getTerminalWidth();
  const isUnicode = options?.borderStyle !== "ascii";

  // Border characters
  const cTopLeft = isUnicode ? "┌──" : "+--";
  const cTopRight = isUnicode ? "┐" : "+";
  const cHoriz = isUnicode ? "─" : "-";
  const cVert = isUnicode ? "│" : "|";
  const cBottomLeft = isUnicode ? "└" : "+";
  const cBottomRight = isUnicode ? "┘" : "+";

  // Calculate natural content width first to know how much width content actually needs
  const titleVis = title ? visibleWidth(title) + 2 : 0;
  let rawContentMax = Math.max(titleVis + 2, 20);
  for (const l of lines) {
    if (l) {
      const w = visibleWidth(l);
      if (w > rawContentMax) rawContentMax = w;
    }
  }

  const isTerm = typeof Deno.stdout?.isTerminal === "function"
    ? Deno.stdout.isTerminal()
    : false;

  // Cap outer card to avoid exceeding terminal width
  let targetOuterMax: number;
  if (options?.maxWidth) {
    targetOuterMax = options.maxWidth;
  } else if (isTerm) {
    targetOuterMax = Math.min(
      Math.max(80, rawContentMax + 4),
      Math.max(36, termWidth - 2),
    );
  } else {
    // Non-interactive / tests / pipe: allow card to expand to content width cleanly
    targetOuterMax = Math.max(80, rawContentMax + 4);
  }

  // Available width for content inside "| " and " |" (4 characters total)
  let maxInnerWidth = Math.max(20, targetOuterMax - 4);
  if (options?.width) {
    maxInnerWidth = Math.max(20, options.width - 4);
  }

  // Pre-wrap lines, protecting dividers and ensuring they fit maxInnerWidth
  const wrappedLines: string[] = [];
  let maxContentWidth = Math.max(titleVis + 2, 20);

  for (const l of lines) {
    if (!l) {
      wrappedLines.push("");
      continue;
    }
    const stripped = stripAnsi(l);
    // Protect horizontal divider lines (e.g. ────── or ------), sizing them to maxInnerWidth
    if (/^\s*[─\-=━]{4,}\s*$/.test(stripped)) {
      const indentMatch = stripped.match(/^(\s*)/);
      const indent = indentMatch ? indentMatch[1] : "  ";
      const ruleWidth = Math.max(4, maxInnerWidth - visibleWidth(indent));
      wrappedLines.push(colorFn(indent + cHoriz.repeat(ruleWidth)));
      maxContentWidth = Math.max(
        maxContentWidth,
        visibleWidth(indent) + ruleWidth,
      );
      continue;
    }
    const chunks = wrapText(l, maxInnerWidth);
    for (const chunk of chunks) {
      wrappedLines.push(chunk);
      maxContentWidth = Math.max(maxContentWidth, visibleWidth(chunk));
    }
  }

  // Clamp inner width between content width and maxInnerWidth
  const innerWidth = Math.max(
    Math.min(maxContentWidth, maxInnerWidth),
    titleVis + 2,
  );
  const cardWidth = innerWidth + 4;

  const out: string[] = [];

  // Top border
  const titlePart = title ? ` ${colors.bold(title)} ` : "";
  const topDashes = Math.max(0, cardWidth - titleVis - 4);
  out.push(
    colorFn(cTopLeft) + titlePart +
      colorFn(cHoriz.repeat(topDashes) + cTopRight),
  );

  const pad = options?.padding !== false;

  // Padding top
  if (pad) {
    out.push(colorFn(cVert) + " ".repeat(innerWidth + 2) + colorFn(cVert));
  }

  // Content lines
  for (const l of wrappedLines) {
    const paddedLine = padText(l, innerWidth);
    out.push(colorFn(`${cVert} `) + paddedLine + colorFn(` ${cVert}`));
  }

  // Padding bottom
  if (pad) {
    out.push(colorFn(cVert) + " ".repeat(innerWidth + 2) + colorFn(cVert));
  }

  // Bottom border
  out.push(colorFn(cBottomLeft + cHoriz.repeat(innerWidth + 2) + cBottomRight));

  return out.join("\n");
}

/**
 * Renders an actionable ASCII error card with remediation hints.
 * Automatically structures and wraps messages, locations, and solution hints.
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

  // If the error message has "Available commands:", split into structured blocks
  const rawMsg = err.message;
  if (rawMsg.includes(". Available commands: ")) {
    const parts = rawMsg.split(". Available commands: ");
    lines.push(
      `${colors.coral(colors.bold("[-]"))}  ${colors.bold(parts[0] + ".")}`,
    );
    lines.push("");
    lines.push(`   ${colors.dim("Available commands:")}`);
    lines.push(`   ${colors.slate(parts[1])}`);
  } else {
    lines.push(`${colors.coral(colors.bold("[-]"))}  ${colors.bold(rawMsg)}`);
  }

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
    lines.push(
      `   ${colors.dim("Reference:")} ${
        colors.underline(colors.brand(err.docs))
      }`,
    );
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

export interface ModernTableOptions {
  alignments?: Array<"left" | "right" | "center">;
  style?: "unicode" | "ascii" | "clean";
  title?: string;
  maxWidth?: number;
  borderColor?: (t: string) => string;
}

/**
 * Renders a responsive table with JetBrains Unicode single-line box drawing.
 * Automatically wraps cells and shrinks columns to fit within terminal width.
 */
export function renderModernTable(
  headers: string[],
  rows: string[][],
  options?: ModernTableOptions,
): string {
  if (!headers || headers.length === 0) return "";
  const safeRows = rows || [];
  const colCount = Math.max(headers.length, ...safeRows.map((r) => r.length));
  if (colCount === 0) return "";

  const style = options?.style ?? "unicode";
  const isUnicode = style === "unicode";
  const isClean = style === "clean";
  const colorFn = options?.borderColor ?? colors.border;
  const alignments = options?.alignments ?? [];

  // Measure natural column widths
  const naturalWidths: number[] = new Array(colCount).fill(0);
  for (let c = 0; c < colCount; c++) {
    const h = headers[c] ?? "";
    let maxW = visibleWidth(h);
    for (const r of safeRows) {
      const cell = r[c] ?? "";
      maxW = Math.max(maxW, visibleWidth(cell));
    }
    naturalWidths[c] = Math.max(1, maxW);
  }

  if (isClean) {
    // Clean / minimal borderless style
    const out: string[] = [];
    if (options?.title) {
      out.push(colors.bold(colors.accent(options.title)));
      out.push("");
    }
    const hCells = headers.map((h, i) =>
      colors.bold(
        colors.accent(padText(h, naturalWidths[i], alignments[i] ?? "left")),
      )
    );
    out.push("  " + hCells.join("   "));

    const divCells = naturalWidths.map((w) => "─".repeat(w));
    out.push(colorFn("  " + divCells.join("   ")));

    for (const row of safeRows) {
      const cells = [];
      for (let i = 0; i < colCount; i++) {
        const val = row[i] ?? "";
        cells.push(padText(val, naturalWidths[i], alignments[i] ?? "left"));
      }
      out.push("  " + cells.join("   "));
    }
    return out.join("\n");
  }

  // Box border characters (JetBrains Unicode vs ASCII)
  const cTopLeft = isUnicode ? "┌" : "+";
  const cTopMid = isUnicode ? "┬" : "+";
  const cTopRight = isUnicode ? "┐" : "+";
  const cMidLeft = isUnicode ? "├" : "+";
  const cMidMid = isUnicode ? "┼" : "+";
  const cMidRight = isUnicode ? "┤" : "+";
  const cBottomLeft = isUnicode ? "└" : "+";
  const cBottomMid = isUnicode ? "┴" : "+";
  const cBottomRight = isUnicode ? "┘" : "+";
  const cHoriz = isUnicode ? "─" : "-";
  const cVert = isUnicode ? "│" : "|";
  const cTitleTopLeft = isUnicode ? "┌──" : "+--";

  // Calculate table width & responsive column shrinking
  // Overhead: each col has " " + cell + " " plus dividers = (colCount * 3) + 1
  const overhead = (colCount * 3) + 1;
  const termWidth = getTerminalWidth();
  const isTerm = typeof Deno.stdout?.isTerminal === "function"
    ? Deno.stdout.isTerminal()
    : false;
  const sumNatural = naturalWidths.reduce((a, b) => a + b, 0);
  const naturalTableWidth = sumNatural + overhead;

  let targetMax: number;
  if (options?.maxWidth) {
    targetMax = options.maxWidth;
  } else if (isTerm) {
    targetMax = Math.max(40, termWidth - 2);
  } else {
    targetMax = Math.max(naturalTableWidth, 80);
  }

  const titleVis = options?.title ? visibleWidth(options.title) + 2 : 0;
  targetMax = Math.max(titleVis + 4, targetMax);
  const availableContent = targetMax - overhead;

  const colWidths = [...naturalWidths];

  if (availableContent > 0 && sumNatural > availableContent) {
    // Columns exceed available width — shrink columns responsively
    const minColWidth = Math.max(
      4,
      Math.floor(availableContent / (colCount * 2)),
    );
    const remaining = availableContent - (colCount * minColWidth);
    const excessSum = naturalWidths.reduce(
      (acc, w) => acc + Math.max(0, w - minColWidth),
      0,
    );

    for (let c = 0; c < colCount; c++) {
      if (excessSum > 0) {
        const excess = Math.max(0, naturalWidths[c] - minColWidth);
        const share = Math.floor((excess / excessSum) * remaining);
        colWidths[c] = Math.max(minColWidth, minColWidth + share);
      } else {
        colWidths[c] = minColWidth;
      }
    }
  }

  // If table with title is narrower than title, expand last column
  const currentTotal = colWidths.reduce((a, b) => a + b, 0) + overhead;
  if (options?.title && currentTotal < titleVis + 4) {
    colWidths[colCount - 1] += (titleVis + 4) - currentTotal;
  }

  const out: string[] = [];
  const finalTableWidth = colWidths.reduce((a, b) => a + b, 0) + overhead;

  // 1. Top border (with or without title)
  if (options?.title) {
    const titlePart = ` ${colors.bold(options.title)} `;
    const topDashes = Math.max(0, finalTableWidth - titleVis - 4);
    out.push(
      colorFn(cTitleTopLeft) + titlePart +
        colorFn(cHoriz.repeat(topDashes) + cTopRight),
    );
  } else {
    const top = cTopLeft + colWidths.map((w) =>
      cHoriz.repeat(w + 2)
    ).join(cTopMid) + cTopRight;
    out.push(colorFn(top));
  }

  // 2. Header row (with multi-line cell wrapping)
  const headerLinesByCol = headers.map((h, i) => wrapText(h, colWidths[i]));
  const headerRowHeight = Math.max(1, ...headerLinesByCol.map((l) => l.length));

  for (let lineIdx = 0; lineIdx < headerRowHeight; lineIdx++) {
    const cells = [];
    for (let c = 0; c < colCount; c++) {
      const cellText = headerLinesByCol[c]?.[lineIdx] ?? "";
      cells.push(
        " " +
          colors.bold(
            colors.accent(
              padText(cellText, colWidths[c], alignments[c] ?? "left"),
            ),
          ) + " ",
      );
    }
    out.push(colorFn(cVert) + cells.join(colorFn(cVert)) + colorFn(cVert));
  }

  // 3. Header separator
  const mid = cMidLeft +
    colWidths.map((w) => cHoriz.repeat(w + 2)).join(cMidMid) + cMidRight;
  out.push(colorFn(mid));

  // 4. Data rows (with multi-line cell wrapping)
  for (const row of safeRows) {
    const rowLinesByCol: string[][] = [];
    for (let c = 0; c < colCount; c++) {
      const val = row[c] ?? "";
      rowLinesByCol.push(wrapText(val, colWidths[c]));
    }
    const rowHeight = Math.max(1, ...rowLinesByCol.map((l) => l.length));

    for (let lineIdx = 0; lineIdx < rowHeight; lineIdx++) {
      const cells = [];
      for (let c = 0; c < colCount; c++) {
        const cellText = rowLinesByCol[c]?.[lineIdx] ?? "";
        cells.push(
          " " + padText(cellText, colWidths[c], alignments[c] ?? "left") + " ",
        );
      }
      out.push(colorFn(cVert) + cells.join(colorFn(cVert)) + colorFn(cVert));
    }
  }

  // 5. Bottom border
  const bot = cBottomLeft +
    colWidths.map((w) => cHoriz.repeat(w + 2)).join(cBottomMid) + cBottomRight;
  out.push(colorFn(bot));

  return out.join("\n");
}

export type ProgressBarStyle = "track" | "sleepers" | "fleet" | "ascii";

export interface ProgressBarOptions {
  width?: number;
  label?: string;
  unit?: string;
  frame?: number;
  speed?: string;
  style?: ProgressBarStyle;
  color?: (s: string) => string;
  showArrival?: boolean;
}

/**
 * Renders a visual railway-themed progress bar.
 *
 * Styles:
 * - "track" (default): Moving locomotive on rails with terminal bumpers:
 *     ╟════════════►────────────╢  50%  (2.5/5.0 MB)  1.8 MB/s
 *     ╟════════════════════════■╢ 100%  [ARRIVED]
 * - "sleepers": Cross-tie railroad sleepers gauge:
 *     ╞══╤══╤══╤══●──┬──┬──┬──╡  50%  (2.5/5.0 MB)
 * - "fleet": JetBrains high-density solid gauge:
 *     ╟▰▰▰▰▰▰▰▰▰▰▰▰▱▱▱▱▱▱▱▱▱▱▱▱╢  50%
 * - "ascii": Classic pure ASCII:
 *     [==========----------]  50%
 */
export function renderProgressBar(
  current: number,
  total: number,
  options?: ProgressBarOptions,
): string {
  const width = Math.max(6, options?.width ?? 24);
  const pct = total > 0 ? Math.min(1, Math.max(0, current / total)) : 0;
  const style = options?.style ?? "track";
  const colorFn = options?.color ?? colors.emerald;
  const percentText = `${Math.round(pct * 100)}%`.padStart(4);

  let bar: string;

  if (style === "track") {
    // Locomotive on Rails with Terminal Bumpers: ╟════════►────────╢
    const filledCount = Math.round(pct * width);
    const emptyCount = Math.max(0, width - filledCount);

    if (filledCount === 0) {
      bar = colors.border("╟") + colors.border("─".repeat(width)) +
        colors.border("╢");
    } else if (filledCount >= width) {
      // Arrived at destination station bumper
      const rails = "═".repeat(Math.max(0, width - 1));
      bar = colors.border("╟") + colorFn(rails) + colors.bold(colorFn("■")) +
        colors.border("╢");
    } else {
      const traversedLen = filledCount - 1;
      let railStr = "";
      if (options?.frame !== undefined && traversedLen >= 2) {
        const pulsePos = options.frame % traversedLen;
        for (let i = 0; i < traversedLen; i++) {
          railStr += i === pulsePos ? "o" : "═";
        }
      } else {
        railStr = "═".repeat(traversedLen);
      }
      const engine = colors.bold(colors.white("►"));
      const ahead = colors.border("─".repeat(emptyCount));
      bar = colors.border("╟") + colorFn(railStr) + engine + ahead +
        colors.border("╢");
    }
  } else if (style === "sleepers") {
    // Cross-Tie Railroad Sleepers: ╞══╤══╤══●──┬──┬──╡
    const filledCount = Math.round(pct * width);
    const emptyCount = Math.max(0, width - filledCount);
    let filledStr = "";
    for (let i = 0; i < filledCount; i++) {
      filledStr += (i % 3 === 2) ? "╤" : "═";
    }
    let emptyStr = "";
    for (let i = 0; i < emptyCount; i++) {
      emptyStr += (i % 3 === 2) ? "┬" : "─";
    }
    const engine = (filledCount > 0 && filledCount < width)
      ? colors.bold(colors.white("●"))
      : "";
    bar = colors.border("╞") + colorFn(filledStr) + engine +
      colors.border(emptyStr) + colors.border("╡");
  } else if (style === "fleet") {
    // JetBrains High-Density Block Gauge: ╟▰▰▰▰▱▱▱▱╢
    const filledCount = Math.round(pct * width);
    const emptyCount = Math.max(0, width - filledCount);
    bar = colors.border("╟") + colorFn("▰".repeat(filledCount)) +
      colors.border("▱".repeat(emptyCount)) + colors.border("╢");
  } else {
    // Classic pure ASCII: [==========----------]
    const filledCount = Math.round(pct * width);
    const emptyCount = Math.max(0, width - filledCount);
    let filledStr = "";
    if (options?.frame !== undefined && filledCount >= 3) {
      const sweepPos = options.frame % filledCount;
      for (let i = 0; i < filledCount; i++) {
        filledStr += i === sweepPos ? ">" : "=";
      }
    } else {
      filledStr = "=".repeat(filledCount);
    }
    bar = "[" + colors.accent(filledStr) +
      colors.border("-".repeat(emptyCount)) + "]";
  }

  let extra = "";
  if (options?.label) {
    extra = ` ${colors.dim(options.label)}`;
  } else if (options?.unit) {
    extra = ` ${colors.dim(`(${current}/${total} ${options.unit})`)}`;
  }
  if (options?.speed) {
    extra += ` ${colors.slate(options.speed)}`;
  }
  if (pct >= 1 && style === "track" && options?.showArrival !== false) {
    extra += ` ${colors.bold(colors.emerald("[ARRIVED]"))}`;
  }

  return `${bar} ${colors.bold(percentText)}${extra}`;
}

const HEADLIGHT_PULSE_COLORS = [
  (t: string) => colors.bold(colors.white(t)),
  (t: string) => `\x1b[1;97m${t}\x1b[0m`,
  (t: string) => colors.white(t),
  (t: string) => colors.gray(t),
  (t: string) => colors.white(t),
  (t: string) => `\x1b[1;97m${t}\x1b[0m`,
];

export interface TrainLogoOptions {
  colored?: boolean;
  indent?: string;
  pulseFrame?: number;
  includeTrack?: boolean;
  colorScheme?: "white-gray" | "white" | "gray";
}

/**
 * Renders the official RailFog pixel-art train locomotive logo.
 * Clean, minimalist monochrome geometry in crisp white and gray.
 *
 *        ┌──────┐
 *          ████
 *    ┌──────────────┐
 *    │████  ██  ████│
 *    │██████████████│
 *    │██████████████│
 *    │██  ██  ██  ██│
 *    │██  ██  ██  ██│
 *   ══════════════════
 */
export function renderTrainLogo(options?: TrainLogoOptions): string[] {
  const c = options?.colored !== false && colors.enabled;
  const ind = options?.indent ?? "";
  const includeTrack = options?.includeTrack ?? true;
  const scheme = options?.colorScheme ?? "white-gray";
  const lines: string[] = [];

  const headlightColor = options?.pulseFrame !== undefined && c
    ? HEADLIGHT_PULSE_COLORS[
      Math.abs(options.pulseFrame) % HEADLIGHT_PULSE_COLORS.length
    ]
    : (t: string) =>
      colors.bold(scheme === "gray" ? colors.gray(t) : colors.white(t));

  if (!c) {
    lines.push(
      `${ind}       ┌──────┐`,
      `${ind}         ████`,
      `${ind}   ┌──────────────┐`,
      `${ind}   │████  ██  ████│`,
      `${ind}   │██████████████│`,
      `${ind}   │██████████████│`,
      `${ind}   │██  ██  ██  ██│`,
      `${ind}   │██  ██  ██  ██│`,
    );
  } else {
    const g = scheme === "white" ? colors.white : colors.gray;
    const w = (t: string) =>
      colors.bold(scheme === "gray" ? colors.gray(t) : colors.white(t));
    const b = scheme === "gray" ? colors.gray : colors.white;
    const wheels = scheme === "white" ? colors.white : colors.gray;

    lines.push(
      `${ind}       ${g("┌──────┐")}`,
      `${ind}         ${headlightColor("████")}`,
      `${ind}   ${g("┌──────────────┐")}`,
      `${ind}   ${g("│")}${b("████")}  ${w("██")}  ${b("████")}${g("│")}`,
      `${ind}   ${g("│")}${b("██████████████")}${g("│")}`,
      `${ind}   ${g("│")}${b("██████████████")}${g("│")}`,
      `${ind}   ${g("│")}${wheels("██  ██  ██  ██")}${g("│")}`,
      `${ind}   ${g("│")}${wheels("██  ██  ██  ██")}${g("│")}`,
    );
  }

  if (includeTrack) {
    const track = "  ══════════════════";
    const trackColor = scheme === "white" ? colors.white : colors.gray;
    lines.push(ind + (c ? trackColor(track) : track));
  }

  return lines;
}

export interface BrandHeaderOptions {
  width?: number;
  details?: Array<[string, string]>;
  tagline?: string;
  showTrain?: boolean;
  pulseFrame?: number;
  colorScheme?: "white-gray" | "white" | "gray";
}

/**
 * Renders the official RailFog CLI Brand Header in Claude Code style.
 * Responsively renders a side-by-side train mascot on wide terminals (>= 66 columns),
 * a clean stacked layout on medium terminals (42-65 columns), and a compact badge
 * on narrow terminals (< 42 columns).
 */
export function renderBrandHeader(
  version: string,
  envName: string = "production",
  options?: BrandHeaderOptions,
): string {
  const termWidth = options?.width ?? getTerminalWidth();
  const brandName = colors.bold(colors.brand("RailFog"));
  const cleanVer = version.startsWith("v") ? version : `v${version}`;
  const verBadge = colors.bgMuted(cleanVer);
  const envBadge = envName === "production"
    ? colors.bgSuccess("production")
    : colors.bgAccent(envName);

  if (options?.showTrain === false) {
    return [
      `  ${brandName}  ${verBadge}  ${envBadge}`,
      `  ${
        colors.dim(options?.tagline ?? "Minimal Application Infrastructure")
      }`,
    ].join("\n");
  }

  const trainLines = renderTrainLogo({
    pulseFrame: options?.pulseFrame,
    colorScheme: options?.colorScheme,
    includeTrack: true,
  });
  const logoWidth = 24;

  if (termWidth >= 66) {
    // Two-column responsive layout (Claude Code style)
    const rightLines: string[] = [
      `${brandName}  ${verBadge}  ${envBadge}`,
      colors.dim(options?.tagline ?? "Minimal Application Infrastructure"),
      `${colors.dim("Trigger")} ${colors.accent("→")} ${
        colors.dim("Function")
      } ${colors.accent("→")} ${colors.dim("{KV, Objects, Queues}")}`,
      "",
    ];

    if (options?.details && options.details.length > 0) {
      for (const [k, v] of options.details) {
        rightLines.push(`${colors.slate(k.padEnd(10))} ${v}`);
      }
    } else {
      rightLines.push(
        `${colors.slate("Engine:")}    ${colors.bold("Deno LTS")} ${
          colors.dim("•")
        } ${colors.slate("V8 Isolates")}`,
        `${colors.slate("Storage:")}   ${colors.accent("KV")} ${
          colors.dim("•")
        } ${colors.emerald("Objects")} ${colors.dim("•")} ${
          colors.amber("Queues")
        }`,
        `${colors.slate("Docs:")}      ${colors.dim("docs/contracts/")}`,
        `${colors.dim("Tips:")}      ${colors.dim("Run")} ${
          colors.accent("rail --help")
        } ${colors.dim("for all commands")}`,
      );
    }

    const out: string[] = [];
    const maxRows = Math.max(trainLines.length, rightLines.length);
    for (let i = 0; i < maxRows; i++) {
      const left = trainLines[i] ?? " ".repeat(logoWidth);
      const right = rightLines[i] ?? "";
      const leftPad = logoWidth - visibleWidth(left);
      out.push(left + " ".repeat(Math.max(0, leftPad)) + right);
    }
    return out.join("\n");
  } else if (termWidth >= 42) {
    // Stacked responsive layout
    return [
      ...trainLines,
      "",
      `  ${brandName}  ${verBadge}  ${envBadge}`,
      `  ${
        colors.dim(options?.tagline ?? "Minimal Application Infrastructure")
      }`,
      `  ${colors.dim("Trigger")} ${colors.accent("→")} ${
        colors.dim("Function")
      } ${colors.accent("→")} ${colors.dim("{KV, Objects, Queues}")}`,
    ].join("\n");
  } else {
    // Ultra-compact fallback
    return [
      `  ${brandName}  ${verBadge}  ${envBadge}`,
      `  ${
        colors.dim(options?.tagline ?? "Minimal Application Infrastructure")
      }`,
    ].join("\n");
  }
}

export interface BoardingPassInfo {
  orgId: string;
  callerId: string;
  tokenDisplay: string;
  controlUrl: string;
  tier?: string;
}

/**
 * Renders an official RailFog Cloud Boarding Pass ticket featuring the train locomotive.
 */
export function renderBoardingPass(info: BoardingPassInfo): string {
  const trainLines = renderTrainLogo({ includeTrack: true });
  const logoWidth = 24;

  const cleanUrl = info.controlUrl.replace(/^https?:\/\//, "");
  const maxUrlLen = Math.max(28, getTerminalWidth() - 48);
  const displayStation = cleanUrl.length > maxUrlLen
    ? cleanUrl.slice(0, maxUrlLen - 3) + "..."
    : cleanUrl;

  const rightLines = [
    `${
      colors.bold(
        colors.emerald("[+] Connected to Control Plane (Status: Active)"),
      )
    }`,
    "",
    `${colors.dim("PASSENGER:")}     ${
      colors.emerald(colors.bold(info.orgId))
    }`,
    `${colors.dim("KEY NAME:")}      ${colors.slate(info.callerId)}`,
    `${colors.dim("ACCESS PASS:")}   ${colors.amber(info.tokenDisplay)}`,
    `${colors.dim("STATION:")}       ${colors.accent(displayStation)}`,
    `${colors.dim("CLASS:")}         ${
      colors.bold(info.tier ?? "Production Tier")
    }`,
    `${colors.dim("PRIMITIVES:")}    ${colors.accent("FN")} ${
      colors.dim("•")
    } ${colors.emerald("KV")} ${colors.dim("•")} ${colors.cyan("OBJ")} ${
      colors.dim("•")
    } ${colors.amber("QUEUES")}`,
    `${colors.dim("VALIDATION:")}    ${
      colors.emerald("[+] ACTIVE & VERIFIED")
    }`,
  ];

  const termWidth = getTerminalWidth();
  const contentLines: string[] = [];
  if (termWidth >= 70) {
    const maxRows = Math.max(trainLines.length, rightLines.length);
    for (let i = 0; i < maxRows; i++) {
      const left = trainLines[i] ?? " ".repeat(logoWidth);
      const right = rightLines[i] ?? "";
      const leftPad = logoWidth - visibleWidth(left);
      contentLines.push(left + " ".repeat(Math.max(0, leftPad)) + right);
    }
  } else {
    contentLines.push(...trainLines);
    contentLines.push("");
    contentLines.push(...rightLines);
  }

  return renderCard("RailFog Cloud Boarding Pass", contentLines, {
    borderColor: colors.emerald,
    padding: true,
  });
}

/**
 * Executes a live animation of the RailFog locomotive with a pulsing headlight.
 */
export async function animateSteamTrain(options?: {
  durationMs?: number;
  fps?: number;
  version?: string;
  signal?: AbortSignal;
}): Promise<void> {
  const isTerm = typeof Deno.stdout.isTerminal === "function" &&
    Deno.stdout.isTerminal();
  const fps = options?.fps ?? 6;
  const intervalMs = Math.round(1000 / fps);
  const encoder = new TextEncoder();
  const ver = options?.version ?? "0.9.0";

  if (!isTerm || !colors.enabled) {
    console.log(renderBrandHeader(ver));
    return;
  }

  let frame = 0;
  const hideCursor = "\x1b[?25l";
  const showCursor = "\x1b[?25h";

  Deno.stdout.writeSync(encoder.encode(hideCursor));

  const cleanup = () => {
    try {
      Deno.stdout.writeSync(encoder.encode(showCursor + "\n"));
    } catch {
      // Ignore
    }
  };

  const startTime = Date.now();
  const duration = options?.durationMs ?? 0;

  try {
    while (!options?.signal?.aborted) {
      const banner = renderBrandHeader(ver, "production", {
        pulseFrame: frame,
      });
      const renderedLines = banner.split("\n");
      const numLines = renderedLines.length;

      if (frame > 0) {
        Deno.stdout.writeSync(encoder.encode(`\x1b[${numLines}A\r`));
      }
      Deno.stdout.writeSync(encoder.encode(banner + "\n"));

      frame++;
      if (duration > 0 && Date.now() - startTime >= duration) {
        break;
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  } finally {
    cleanup();
  }
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
 * Renders an IntelliJ Project / Services style tree view with JetBrains Unicode single-line drawing.
 *
 * [Project] cloud-demo (C:\path\to\dir)
 *  │
 *  ├── [Functions]
 *  │    ├── api                         --> functions/api.ts
 *  │    └── worker                      --> functions/worker.ts
 *  │
 *  └── [Storage]
 *       ├── KV                          --> SQLite
 *       └── Objects                     --> LocalFS
 */
export function renderTree(
  rootTitle: string,
  nodes: TreeNode[],
  options?: {
    rootPrefix?: string;
    showRoot?: boolean;
    style?: "unicode" | "ascii";
  },
): string {
  const lines: string[] = [];
  const rootPref = options?.rootPrefix ?? "[Project]";
  const isUnicode = options?.style !== "ascii";

  const vLine = isUnicode ? "│" : "|";
  const branchMid = isUnicode ? "├── " : "|-- ";
  const branchEnd = isUnicode ? "└── " : "\\-- ";
  const contMid = isUnicode ? "│   " : "|   ";
  const contEnd = "    ";

  if (options?.showRoot !== false) {
    lines.push(
      `${colors.bold(colors.brand(rootPref))} ${colors.bold(rootTitle)}`,
    );
    lines.push(` ${colors.border(vLine)}`);
  }

  function walk(
    items: TreeNode[],
    prefix: string,
    _isRootLevel: boolean,
  ): void {
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const isLast = i === items.length - 1;
      const branch = isLast ? branchEnd : branchMid;

      const badgeStr = item.badge ? ` ${colors.dim(`[${item.badge}]`)}` : "";
      const valStr = item.value
        ? `  ${colors.accent("-->")}  ${colors.slate(item.value)}`
        : "";
      const labelStr = item.children && item.children.length > 0
        ? colors.bold(colors.accent(item.label))
        : colors.slate(item.label);

      lines.push(
        `${prefix}${colors.border(branch)}${labelStr}${badgeStr}${valStr}`,
      );

      if (item.children && item.children.length > 0) {
        const nextPrefix = prefix + (isLast ? contEnd : contMid);
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
 *      │
 *   14 │ pattern = "/api/users"
 *      │           ^^^^^^^^^^^^ route pattern declaration
 *      │
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
    ? `    ${colors.accent("-->")} ${colors.slate(issue.file)}${
      issue.line ? `:${issue.line}` : ""
    }${issue.column ? `:${issue.column}` : ""}`
    : "";
  if (fileLoc) {
    lines.push(fileLoc);
    lines.push(`     ${colors.border("│")}`);
  }

  if (issue.snippet && issue.line) {
    const lineNum = String(issue.line).padStart(4, " ");
    lines.push(
      `  ${colors.border(lineNum)} ${colors.border("│")} ${issue.snippet}`,
    );
    if (issue.column !== undefined) {
      const padCol = " ".repeat(Math.max(0, issue.column - 1));
      const underline = "^".repeat(8);
      lines.push(
        `       ${colors.border("│")} ${padCol}${colors.coral(underline)}`,
      );
    }
    lines.push(`     ${colors.border("│")}`);
  }

  if (issue.hint) {
    lines.push(
      `     ${colors.border("│")}  ${colors.amber(colors.bold("[Fix]"))} ${
        colors.slate(issue.hint)
      }`,
    );
  }

  if (issue.ruleUrl) {
    lines.push(
      `     ${colors.border("│")}  ${colors.dim("[Ref]")} ${
        colors.underline(colors.brand(issue.ruleUrl))
      }`,
    );
  }

  return lines.join("\n");
}

/**
 * Renders an IDE status bar telemetry strip.
 *
 * [ Project: cloud-demo │ Functions: 3 │ Routes: 6 │ Status: Ready ]
 */
export function renderStatusBar(
  sections: Array<{ label: string; value: string }>,
): string {
  const formatted = sections.map((s) => {
    return `${colors.dim(s.label)}: ${colors.bold(colors.accent(s.value))}`;
  });
  return `  [ ${formatted.join(colors.border(" │ "))} ]`;
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
  const durStr = durationMs !== undefined
    ? ` ${colors.dim(`(${durationMs}ms)`)}`
    : "";
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

  return `  ${colors.bold(colors.accent(stepPrefix))} ${
    title.padEnd(46)
  } ${badge}${durStr}`;
}

export interface ReleaseTrainInfo {
  project: string;
  revision: string;
  duration: string;
  runtimeUrl: string;
  routesCount?: number;
  functionsCount?: number;
}

/**
 * Renders the Release Train deployment manifest card.
 * Features the white & gray monochrome locomotive coupled with architectural payload telemetry.
 * 100% pure ASCII and JetBrains styling with zero emojis.
 */
export function renderReleaseTrainCard(info: ReleaseTrainInfo): string {
  const trainLines = renderTrainLogo({ includeTrack: true });
  const logoWidth = 24;

  const rightLines = [
    `${
      colors.bold(colors.emerald("[+] Release Train Arrived at Edge Station"))
    }`,
    "",
    `${colors.dim("PROJECT:")}     ${colors.accent(colors.bold(info.project))}`,
    `${colors.dim("REVISION:")}    ${colors.amber(info.revision)}`,
    `${colors.dim("DURATION:")}    ${colors.slate(info.duration)}`,
    `${colors.dim("RUNTIME:")}     ${colors.emerald(info.runtimeUrl)}`,
    `${colors.dim("MANIFEST:")}    ${
      colors.bold(String(info.functionsCount ?? 1))
    } functions ${colors.dim("•")} ${
      colors.bold(String(info.routesCount ?? 1))
    } routes`,
    `${colors.dim("PRIMITIVES:")}  ${colors.accent("FN")} ${colors.dim("•")} ${
      colors.emerald("KV")
    } ${colors.dim("•")} ${colors.cyan("OBJ")} ${colors.dim("•")} ${
      colors.amber("QUEUES")
    }`,
    `${colors.dim("STATUS:")}      ${
      colors.emerald("[+] ALL CARS COUPLED & ACTIVE")
    }`,
  ];

  const termWidth = getTerminalWidth();
  const contentLines: string[] = [];
  if (termWidth >= 70) {
    const maxRows = Math.max(trainLines.length, rightLines.length);
    for (let i = 0; i < maxRows; i++) {
      const left = trainLines[i] ?? " ".repeat(logoWidth);
      const right = rightLines[i] ?? "";
      const leftPad = logoWidth - visibleWidth(left);
      contentLines.push(left + " ".repeat(Math.max(0, leftPad)) + right);
    }
  } else {
    contentLines.push(...trainLines);
    contentLines.push("");
    contentLines.push(...rightLines);
  }

  return renderCard("Release Train: Deployment Manifest", contentLines, {
    borderColor: colors.emerald,
    padding: true,
  });
}

export interface DepartureItem {
  track: number;
  platform: string;
  route: string;
  functionName: string;
  target: string;
  status?: string;
}

/**
 * Renders the Station Departure Board table for 'rail status'.
 * Formats routes, functions, and platforms in a clean JetBrains Unicode timetable.
 */
export function renderDepartureBoard(
  projectName: string,
  items: DepartureItem[],
): string {
  if (items.length === 0) {
    return renderCard(`Station Departure Board [${projectName}]`, [
      `${colors.dim("No active tracks or routes configured in railfog.toml.")}`,
      "",
      `   ${
        colors.amber(">> Next step:")
      } Run 'rail add sdk' or configure [functions] in railfog.toml.`,
    ], { borderColor: colors.accent });
  }

  const headers = [
    "TRACK",
    "PLATFORM",
    "ROUTE",
    "FUNCTION",
    "TARGET",
    "STATUS",
  ];
  const rows = items.map((item) => {
    const trackNum = String(item.track).padStart(2, "0");
    const platTag = `[${item.platform.toUpperCase()}]`;
    const st = item.status ?? "ON-TIME";
    const statusFormatted = st === "ON-TIME" || st === "READY"
      ? colors.emerald(`[${st}]`)
      : colors.amber(`[${st}]`);

    return [
      colors.slate(trackNum),
      colors.accent(platTag),
      colors.bold(item.route),
      colors.slate(item.functionName),
      colors.dim(item.target),
      statusFormatted,
    ];
  });

  return renderModernTable(headers, rows, {
    title: `RailFog Station Departure Board [${projectName}]`,
    alignments: ["center", "left", "left", "left", "left", "center"],
    style: "unicode",
    borderColor: colors.accent,
  });
}

export interface FreightExpressInfo {
  mode: "export" | "restore";
  projectName: string;
  backupId?: string;
  location?: string;
  stats: Array<[string, string]>;
}

/**
 * Renders the Freight Express manifest card for state backup and restore operations.
 */
export function renderFreightExpressCard(info: FreightExpressInfo): string {
  const trainLines = renderTrainLogo({ includeTrack: true });
  const logoWidth = 24;
  const isExport = info.mode === "export";

  const title = isExport
    ? "Freight Express: State Export"
    : "Freight Express: State Restore";
  const headerStatus = isExport
    ? colors.bold(colors.emerald("[+] Sealed Freight Container (AES-256-GCM)"))
    : colors.bold(
      colors.emerald("[+] Freight Delivered & Cluster State Restored"),
    );

  const rightLines = [
    headerStatus,
    "",
    `${colors.dim("PROJECT:")}     ${
      colors.accent(colors.bold(info.projectName))
    }`,
    ...(info.backupId
      ? [`${colors.dim("BACKUP ID:")}   ${colors.slate(info.backupId)}`]
      : []),
    ...(info.location
      ? [`${colors.dim("LOCATION:")}    ${colors.slate(info.location)}`]
      : []),
    ...info.stats.map(([k, v]) =>
      `${colors.dim(k.padEnd(12))} ${colors.bold(v)}`
    ),
    `${colors.dim("SECURITY:")}    ${
      colors.emerald("[+] AES-256-GCM SEAL VERIFIED")
    }`,
    `${colors.dim("STATUS:")}      ${
      colors.emerald(isExport ? "[+] EXPORT COMPLETE" : "[+] RESTORE COMPLETE")
    }`,
  ];

  const termWidth = getTerminalWidth();
  const contentLines: string[] = [];
  if (termWidth >= 70) {
    const maxRows = Math.max(trainLines.length, rightLines.length);
    for (let i = 0; i < maxRows; i++) {
      const left = trainLines[i] ?? " ".repeat(logoWidth);
      const right = rightLines[i] ?? "";
      const leftPad = logoWidth - visibleWidth(left);
      contentLines.push(left + " ".repeat(Math.max(0, leftPad)) + right);
    }
  } else {
    contentLines.push(...trainLines);
    contentLines.push("");
    contentLines.push(...rightLines);
  }

  return renderCard(title, contentLines, {
    borderColor: colors.emerald,
    padding: true,
  });
}

/**
 * Formats a 3-aspect railway signal lantern with pure ASCII circles.
 * Aspect 0: [ ● ── ○ ── ○ ]
 * Aspect 1: [ ○ ── ● ── ○ ]
 * Aspect 2: [ ○ ── ○ ── ● ]
 * Aspect 3: [ ● ── ● ── ● ] (All signals green)
 */
export function renderSignalLantern(aspect: number): string {
  const on = (t: string) => colors.emerald(colors.bold(t));
  const off = (t: string) => colors.slate(t);
  const track = colors.border("──");

  if (aspect >= 3) {
    return `[ ${on("●")} ${track} ${on("●")} ${track} ${on("●")} ]`;
  }
  const l1 = aspect === 0 ? on("●") : off("○");
  const l2 = aspect === 1 ? on("●") : off("○");
  const l3 = aspect === 2 ? on("●") : off("○");
  return `[ ${l1} ${track} ${l2} ${track} ${l3} ]`;
}

/**
 * Executes a smooth signal lantern animation for deployment or isolate startup.
 */
export async function animateSignalLantern(options?: {
  steps?: string[];
  delayMs?: number;
}): Promise<void> {
  const steps = options?.steps ?? [
    "Switching track & allocating V8 isolate...",
    "Coupling function isolates & sealing capabilities...",
    "All signals green • Ready for departure!",
  ];
  const delay = options?.delayMs ?? 150;
  const isTerm = typeof Deno.stdout.isTerminal === "function" &&
    Deno.stdout.isTerminal();

  if (!isTerm || !colors.enabled) {
    for (let i = 0; i < steps.length; i++) {
      console.log(`${renderSignalLantern(i)} ${steps[i]}`);
    }
    return;
  }

  const encoder = new TextEncoder();
  for (let i = 0; i < steps.length; i++) {
    const line = `\r\x1b[2K  ${renderSignalLantern(i)}  ${
      colors.bold(steps[i])
    }`;
    Deno.stdout.writeSync(encoder.encode(line));
    await new Promise((r) => setTimeout(r, delay));
  }
  Deno.stdout.writeSync(encoder.encode("\n"));
}

export interface StationSignalItem {
  id: number;
  name: string;
  status: "active" | "warn" | "error";
  statusText: string;
  detail: string;
}

export interface StationSignalReport {
  projectName: string;
  isolateBootMs: number;
  signals: StationSignalItem[];
  overallHealthy: boolean;
}

/**
 * Renders the RailFog Station Signal Board for platform health diagnosis.
 */
export function renderStationSignalBoard(report: StationSignalReport): string {
  const trainLines = renderTrainLogo({ includeTrack: true });
  const logoWidth = 24;

  const headerStatus = report.overallHealthy
    ? colors.bold(
      colors.emerald("[+] All Track Signals Green • Platform Ready"),
    )
    : colors.bold(
      colors.coral("[-] Signal Warnings Detected • Attention Required"),
    );

  const rightLines = [
    headerStatus,
    "",
    `${colors.dim("STATION:")}      ${
      colors.accent(colors.bold(report.projectName))
    }`,
    `${colors.dim("ENGINE:")}       ${colors.bold("Deno LTS")} ${
      colors.dim("•")
    } ${colors.slate("V8 Isolates")}`,
    `${colors.dim("COLD START:")}   ${
      colors.emerald(
        colors.bold(`< ${report.isolateBootMs.toFixed(2)}ms (Sub-millisecond)`),
      )
    }`,
    `${colors.dim("ARCHITECTURE:")} ${colors.accent("Zero-IAM")} ${
      colors.dim("•")
    } ${colors.emerald("4-Primitive Twin")} ${colors.dim("•")} ${
      colors.amber("Deterministic")
    }`,
    "",
  ];

  const termWidth = getTerminalWidth();
  const topBlock: string[] = [];
  if (termWidth >= 70) {
    const maxRows = Math.max(trainLines.length, rightLines.length);
    for (let i = 0; i < maxRows; i++) {
      const left = trainLines[i] ?? " ".repeat(logoWidth);
      const right = rightLines[i] ?? "";
      const leftPad = logoWidth - visibleWidth(left);
      topBlock.push(left + " ".repeat(Math.max(0, leftPad)) + right);
    }
  } else {
    topBlock.push(...trainLines);
    topBlock.push("");
    topBlock.push(...rightLines);
  }

  const signalLines: string[] = [
    ...topBlock,
    "",
    colors.bold("  Station Track Signals:"),
    colors.border(
      "  ───────────────────────────────────────────────────────────────────",
    ),
  ];

  for (const sig of report.signals) {
    const isGreen = sig.status === "active";
    const isWarn = sig.status === "warn";
    const dot = isGreen
      ? colors.emerald(" [●] ")
      : isWarn
      ? colors.amber(" [●] ")
      : colors.coral(" [●] ");
    const badge = isGreen
      ? colors.emerald(sig.statusText)
      : isWarn
      ? colors.amber(sig.statusText)
      : colors.coral(sig.statusText);
    const title = colors.bold(sig.name.padEnd(28));
    signalLines.push(`  ${dot}${title} ${badge}`);
    signalLines.push(`        ${colors.dim("└─ ")}${colors.slate(sig.detail)}`);
  }

  return renderCard("RailFog Station Signal Board", signalLines, {
    borderColor: report.overallHealthy ? colors.emerald : colors.coral,
    borderStyle: "unicode",
    padding: true,
  });
}

export interface RouteSimulationResult {
  path: string;
  method?: string;
  matchedPattern: string;
  specificityScore: number;
  functionName: string;
  entrypoint: string;
  isolateBootMs: number;
  permissions: {
    kv?: string[];
    objects?: string[];
    queues?: string[];
    network?: string[];
  };
  shadowedBy?: string[];
}

/**
 * Renders the Edge Route Dispatch Simulator card.
 */
export function renderRouteSimulatorCard(sim: RouteSimulationResult): string {
  const lines: string[] = [
    `${
      colors.bold(colors.accent("[+] Edge Dispatch Engine Simulation Complete"))
    }`,
    "",
    `  ${colors.dim("Request Path:")}     ${
      colors.bold(colors.white(sim.path))
    }`,
    `  ${colors.dim("Matched Route:")}    ${
      colors.emerald(colors.bold(sim.matchedPattern))
    }`,
    `  ${colors.dim("PLAT-11 Score:")}    ${
      colors.amber(colors.bold(String(sim.specificityScore)))
    } ${colors.dim("(Specific > Wildcard)")}`,
    `  ${colors.dim("Target Isolate:")}   ${colors.accent(sim.functionName)} ${
      colors.dim(`(${sim.entrypoint})`)
    }`,
    `  ${colors.dim("Simulated Boot:")}   ${
      colors.emerald(`< ${sim.isolateBootMs.toFixed(2)}ms (V8 Isolate Density)`)
    }`,
    "",
    colors.bold("  Injected Sandbox Capabilities (Zero-IAM Boundary):"),
    colors.border(
      "  ─────────────────────────────────────────────────────────────────",
    ),
  ];

  const kvText = sim.permissions.kv && sim.permissions.kv.length > 0
    ? sim.permissions.kv.map((k) => colors.emerald(k)).join(", ")
    : colors.dim("(none granted - storage handle blocked)");
  lines.push(`    ${colors.dim("• KV Namespaces:")}      ${kvText}`);

  const objText = sim.permissions.objects && sim.permissions.objects.length > 0
    ? sim.permissions.objects.map((o) => colors.accent(o)).join(", ")
    : colors.dim("(none granted - binary access blocked)");
  lines.push(`    ${colors.dim("• Object Buckets:")}     ${objText}`);

  const qText = sim.permissions.queues && sim.permissions.queues.length > 0
    ? sim.permissions.queues.map((q) => colors.amber(q)).join(", ")
    : colors.dim("(none granted - queue dispatch blocked)");
  lines.push(`    ${colors.dim("• Queues:")}             ${qText}`);

  const netText = sim.permissions.network && sim.permissions.network.length > 0
    ? sim.permissions.network.map((n) => colors.cyan(n)).join(", ") +
      colors.dim(" [SSRF Filtered]")
    : colors.dim("(none granted - outbound sockets blocked)");
  lines.push(`    ${colors.dim("• Network Egress:")}     ${netText}`);

  if (sim.shadowedBy && sim.shadowedBy.length > 0) {
    lines.push("");
    lines.push(
      `  ${
        colors.amber("[!] Warning:")
      } Shadowed by routes with equal or higher score: ${
        sim.shadowedBy.join(", ")
      }`,
    );
  }

  return renderCard("Edge Route Dispatch Simulator", lines, {
    borderColor: colors.accent,
    borderStyle: "unicode",
    padding: true,
  });
}

/**
 * Renders the architectural comparison matrix contrasting RailFog with AWS Lambda and Cloudflare Workers.
 */
export function renderCompetitiveMatrix(): string {
  const headers = [
    "Architectural Dimension",
    "RailFog",
    "AWS Lambda",
    "Cloudflare Workers",
  ];
  const rows = [
    [
      "Cold Start Latency",
      colors.emerald("< 1ms (V8 Isolates)"),
      colors.slate("150ms - 1,500ms (MicroVM)"),
      colors.slate("5ms - 50ms (Workers)"),
    ],
    [
      "Security Model",
      colors.emerald("Zero-IAM (3 lines TOML)"),
      colors.slate("50+ lines IAM JSON & ARNs"),
      colors.slate("Proprietary Bindings"),
    ],
    [
      "Local Offline Parity",
      colors.emerald("100% Digital Twin (SQLite/FS)"),
      colors.coral("Broken (Heavy 4GB LocalStack)"),
      colors.amber("Partial (Miniflare mock)"),
    ],
    [
      "Disaster Recovery",
      colors.emerald("1-File AES-256 Freight Archive"),
      colors.coral("Manual Multi-service Pipelines"),
      colors.amber("Disjoint D1/R2/KV Exports"),
    ],
    [
      "Routing Determinism",
      colors.emerald("PLAT-11 Math Specificity Score"),
      colors.slate("API Gateway Regex Order Traps"),
      colors.slate("Manual Imperative Code"),
    ],
    [
      "Developer SDK",
      colors.emerald("1 Unified RailFogContext"),
      colors.slate("4 Heavy @aws-sdk Packages"),
      colors.slate("Disjoint Global Objects"),
    ],
  ];

  return renderModernTable(headers, rows, {
    title: "RailFog vs AWS Lambda vs Cloudflare Workers",
    alignments: ["left", "left", "left", "left"],
    style: "unicode",
    borderColor: colors.brand,
  });
}

export interface BarChartItem {
  label: string;
  value: number;
  formattedValue?: string;
  color?: (s: string) => string;
}

export interface BarChartOptions {
  width?: number;
  title?: string;
  unit?: string;
}

/**
 * Renders an ASCII horizontal bar chart formatted in the JetBrains Darcula aesthetic.
 */
export function renderHorizontalBarChart(
  items: BarChartItem[],
  options?: BarChartOptions,
): string {
  const width = Math.max(10, options?.width ?? 24);
  const total = items.reduce((acc, item) => acc + Math.max(0, item.value), 0);
  const maxVal = Math.max(...items.map((i) => Math.max(0, i.value)), 0);

  const maxLabelWidth = Math.max(
    ...items.map((i) => visibleWidth(i.label)),
    4,
  );

  const lines: string[] = [];
  if (options?.title) {
    lines.push(colors.bold(colors.accent(`[ ${options.title} ]`)));
    lines.push("");
  }

  for (const item of items) {
    const val = Math.max(0, item.value);
    const barLen = maxVal > 0 ? Math.round((val / maxVal) * width) : 0;
    const pct = total > 0 ? ((val / total) * 100).toFixed(0) : "0";
    const colorFn = item.color ?? colors.brand;

    const barStr = barLen > 0 ? colorFn("■".repeat(barLen)) : "";
    const emptyStr = colors.dim("·".repeat(width - barLen));
    const labelPadded = item.label.padEnd(maxLabelWidth);
    const formatted = item.formattedValue ??
      (options?.unit ? `${options.unit}${val.toFixed(2)}` : val.toFixed(2));

    lines.push(
      `  ${colors.bold(labelPadded)}  ${barStr}${emptyStr}  ${
        colors.bold(formatted.padStart(10))
      } ${colors.dim(`(${pct.padStart(3)}%)`)}`,
    );
  }

  return lines.join("\n");
}

/**
 * Renders a segmented proportional single-line horizontal distribution bar.
 */
export function renderDistributionBar(
  items: Array<{ label: string; value: number; color?: (s: string) => string }>,
  width: number = 32,
): string {
  const total = items.reduce((acc, i) => acc + Math.max(0, i.value), 0);
  if (total <= 0) {
    return colors.dim(`[ ${"·".repeat(width)} ] 0% allocated`);
  }

  let filled = 0;
  const segments: string[] = [];
  const chars = ["■", "▒", "░", "■"];
  const defaultColors = [
    colors.emerald,
    colors.cyan,
    colors.amber,
    colors.purple,
  ];

  items.forEach((item, idx) => {
    const val = Math.max(0, item.value);
    const fraction = val / total;
    const segLen = Math.round(fraction * width);
    filled += segLen;
    const colorFn = item.color ?? defaultColors[idx % defaultColors.length];
    const ch = chars[idx % chars.length];
    if (segLen > 0) {
      segments.push(colorFn(ch.repeat(segLen)));
    }
  });

  if (filled < width) {
    segments.push(colors.dim("·".repeat(width - filled)));
  }

  return `[${segments.join("")}]`;
}

export interface TopologyNode {
  name: string;
  routes: string[];
  entrypoint?: string;
  kv?: string[];
  objects?: string[];
  queues?: string[];
  network?: string[];
}

/**
 * Renders a clean ASCII architecture topology diagram linking HTTP Triggers -> Functions -> Primitives.
 */
export function renderTopologyGraph(options: {
  projectName: string;
  functions: TopologyNode[];
}): string {
  const lines: string[] = [];
  lines.push(colors.bold(colors.accent(`Topology: ${options.projectName}`)));
  lines.push(
    colors.dim(
      "Trigger (HTTP) ──────► Function (Isolate) ──────► Primitives {KV, OBJ, QUEUE}",
    ),
  );
  lines.push("");

  if (options.functions.length === 0) {
    lines.push(`  ${colors.dim("(no functions declared)")}`);
    return lines.join("\n");
  }

  for (let i = 0; i < options.functions.length; i++) {
    const fn = options.functions[i];
    const isLastFn = i === options.functions.length - 1;
    const fnBranch = isLastFn ? "└─" : "├─";
    const fnPipe = isLastFn ? "  " : "│ ";

    const routesStr = fn.routes.length > 0
      ? fn.routes.map((r) => colors.bold(colors.emerald(r))).join(", ")
      : colors.dim("(no routes)");

    lines.push(
      `${colors.dim(fnBranch)}─┬─ ${colors.bold(colors.brand(fn.name))} ${
        colors.dim(`[${fn.entrypoint ?? "entrypoint"}]`)
      }`,
    );
    lines.push(`${colors.dim(fnPipe)} ├─ Routes:       ${routesStr}`);

    const bindings: string[] = [];
    if (fn.kv && fn.kv.length > 0) {
      bindings.push(`KV: ${fn.kv.join(", ")}`);
    }
    if (fn.objects && fn.objects.length > 0) {
      bindings.push(`OBJ: ${fn.objects.join(", ")}`);
    }
    if (fn.queues && fn.queues.length > 0) {
      bindings.push(`QUEUE: ${fn.queues.join(", ")}`);
    }
    if (fn.network && fn.network.length > 0) {
      bindings.push(`NET: ${fn.network.join(", ")}`);
    }

    if (bindings.length > 0) {
      lines.push(
        `${colors.dim(fnPipe)} └─ Capabilities: ${
          colors.slate(bindings.join(" • "))
        }`,
      );
    } else {
      lines.push(
        `${colors.dim(fnPipe)} └─ Capabilities: ${
          colors.dim("None (pure function)")
        }`,
      );
    }
    if (!isLastFn) {
      lines.push(`${colors.dim(fnPipe)}`);
    }
  }

  return lines.join("\n");
}
