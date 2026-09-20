// spec: docs/contracts/platform.contract.md#PLAT-19 — Repository structure and CLI interactive selection prompts
// spec: tasks/milestone-0.8-developer-experience-ux/T-0805-terminal-selection-prompts.md#Acceptance criteria

// Named constants for ANSI escape sequences per docs/ANTI-SLOP.md Rule 3
const ESC_UP = "\x1b[A";
const ESC_DOWN = "\x1b[B";
const SS3_UP = "\x1bOA";
const SS3_DOWN = "\x1bOB";
const CURSOR_LINE_CLEAR = "\r\x1b[2K";

// deno-lint-ignore no-control-regex
const ANSI_ESCAPE_REGEX = /\x1b\[[0-9;?]*[a-zA-Z]/g;
// deno-lint-ignore no-control-regex
const KEY_TOKEN_REGEX = /\x1b\[[AB]|\x1bO[AB]|\r\n|[\r\n]/g;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export interface Choice<T = string> {
  label: string;
  value: T;
  description?: string;
}

export interface WriterSync {
  writeSync(p: Uint8Array): number;
}

export interface SelectPromptOptions<T = string> {
  message: string;
  choices: Choice<T>[];
  defaultIndex?: number;
  stdinReader?: () => Promise<string>;
  outputWriter?: WriterSync;
  stream?: WriterSync;
  isInteractive?: boolean;
  interactive?: boolean;
}

/**
 * Strips ANSI escape sequences from a string to measure its visible terminal width.
 */
function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE_REGEX, "");
}

/**
 * Calculates visible character width of a string excluding ANSI escape codes.
 */
function visibleWidth(text: string): number {
  return stripAnsi(text).length;
}

/**
 * Pads a cell to the target visible width, preserving any embedded ANSI sequences.
 */
function padCell(text: string, width: number): string {
  const vLen = visibleWidth(text);
  const pad = Math.max(0, width - vLen);
  return text + " ".repeat(pad);
}

/**
 * Default standard input reader reading from Deno.stdin.
 */
async function defaultStdinReader(): Promise<string> {
  const buf = new Uint8Array(1024);
  const n = await Deno.stdin.read(buf);
  if (n === null || n === 0) {
    return "";
  }
  return textDecoder.decode(buf.subarray(0, n));
}

/**
 * Renders the interactive prompt view or re-renders updated choices on arrow navigation.
 */
function renderInteractivePrompt<T>(
  writer: WriterSync,
  message: string,
  choices: Choice<T>[],
  activeIndex: number,
  isInitial: boolean,
): void {
  let text = "";
  if (isInitial) {
    text += `${message}\n`;
    for (let i = 0; i < choices.length; i++) {
      const choice = choices[i];
      const indicator = i === activeIndex ? "> " : "  ";
      const desc = choice.description ? ` - ${choice.description}` : "";
      text += `${indicator}${choice.label}${desc}\n`;
    }
  } else {
    // Move cursor up by choices.length lines to overwrite existing choice lines
    text += `\x1b[${choices.length}A`;
    for (let i = 0; i < choices.length; i++) {
      const choice = choices[i];
      const indicator = i === activeIndex ? "> " : "  ";
      const desc = choice.description ? ` - ${choice.description}` : "";
      text += `${CURSOR_LINE_CLEAR}${indicator}${choice.label}${desc}\n`;
    }
  }
  writer.writeSync(textEncoder.encode(text));
}

/**
 * Prompts user to select from a list of choices via interactive arrow-key navigation
 * or fallback numbered index input.
 *
 * spec: docs/contracts/platform.contract.md#PLAT-19 — Repository structure and CLI interactive selection prompts
 * spec: tasks/milestone-0.8-developer-experience-ux/T-0805-terminal-selection-prompts.md#Acceptance criteria AC1, AC2
 */
export async function selectPrompt<T = string>(
  options: SelectPromptOptions<T>,
): Promise<T> {
  if (!options || typeof options !== "object") {
    throw new Error("selectPrompt: options must be provided");
  }
  if (
    !options.message ||
    typeof options.message !== "string" ||
    options.message.trim().length === 0
  ) {
    throw new Error("selectPrompt: message must be a non-empty string");
  }
  if (
    !options.choices ||
    !Array.isArray(options.choices) ||
    options.choices.length === 0
  ) {
    throw new Error("selectPrompt: choices array must not be empty");
  }

  // spec: tasks/milestone-0.8-developer-experience-ux/T-0805-terminal-selection-prompts.md#Acceptance criteria AC1 — Clamp defaultIndex within valid bounds [0, choices.length - 1]
  let defaultIndex = options.defaultIndex ?? 0;
  if (defaultIndex < 0) {
    defaultIndex = 0;
  } else if (defaultIndex >= options.choices.length) {
    defaultIndex = options.choices.length - 1;
  }

  const writer: WriterSync = options.outputWriter ?? options.stream ??
    Deno.stdout;
  const isInteractive = options.interactive ??
    options.isInteractive ??
    (
      writer &&
        "isTerminal" in writer &&
        typeof (writer as unknown as { isTerminal: () => boolean })
            .isTerminal === "function"
        ? (writer as unknown as { isTerminal: () => boolean }).isTerminal()
        : typeof Deno.stdout.isTerminal === "function" &&
          Deno.stdout.isTerminal()
    );

  const stdinFn = options.stdinReader ?? defaultStdinReader;

  if (isInteractive) {
    // spec: tasks/milestone-0.8-developer-experience-ux/T-0805-terminal-selection-prompts.md#Acceptance criteria AC1 — Interactive arrow key navigation and active selection indicator
    let activeIndex = defaultIndex;

    const isRealTerminal = !options.stdinReader &&
      typeof Deno.stdin.setRaw === "function" &&
      typeof Deno.stdin.isTerminal === "function" &&
      Deno.stdin.isTerminal();

    if (isRealTerminal) {
      try {
        Deno.stdin.setRaw(true);
      } catch {
        // Continue if raw mode cannot be set
      }
    }

    try {
      renderInteractivePrompt(
        writer,
        options.message,
        options.choices,
        activeIndex,
        true,
      );

      while (true) {
        const input = await stdinFn();
        if (!input) {
          return options.choices[activeIndex].value;
        }

        if (input === "\x03") {
          Deno.exit(130);
        }

        if (input === "\r" || input === "\n" || input === "\r\n") {
          return options.choices[activeIndex].value;
        }

        let updated = false;
        const tokens = input.match(KEY_TOKEN_REGEX);
        if (tokens && tokens.length > 0) {
          for (const token of tokens) {
            if (token === "\r" || token === "\n" || token === "\r\n") {
              return options.choices[activeIndex].value;
            } else if (token === ESC_UP || token === SS3_UP) {
              activeIndex = Math.max(0, activeIndex - 1);
              updated = true;
            } else if (token === ESC_DOWN || token === SS3_DOWN) {
              activeIndex = Math.min(
                options.choices.length - 1,
                activeIndex + 1,
              );
              updated = true;
            }
          }
        } else {
          if (input.includes(ESC_UP) || input.includes(SS3_UP)) {
            activeIndex = Math.max(0, activeIndex - 1);
            updated = true;
          } else if (input.includes(ESC_DOWN) || input.includes(SS3_DOWN)) {
            activeIndex = Math.min(options.choices.length - 1, activeIndex + 1);
            updated = true;
          } else if (input.includes("\r") || input.includes("\n")) {
            return options.choices[activeIndex].value;
          }
        }

        if (updated) {
          renderInteractivePrompt(
            writer,
            options.message,
            options.choices,
            activeIndex,
            false,
          );
        }
      }
    } finally {
      if (isRealTerminal) {
        try {
          Deno.stdin.setRaw(false);
        } catch {
          // Cleanup ignore
        }
      }
    }
  }

  // spec: tasks/milestone-0.8-developer-experience-ux/T-0805-terminal-selection-prompts.md#Acceptance criteria AC2 — Non-interactive numbered choice fallback and input resolution
  let promptText = `${options.message}\n`;
  for (let i = 0; i < options.choices.length; i++) {
    const choice = options.choices[i];
    const desc = choice.description ? ` - ${choice.description}` : "";
    promptText += `  ${i + 1}) ${choice.label}${desc}\n`;
  }
  promptText += `Enter choice [1-${options.choices.length}] (default: ${
    defaultIndex + 1
  }): `;
  writer.writeSync(textEncoder.encode(promptText));

  while (true) {
    const rawInput = await stdinFn();
    const trimmed = rawInput.trim();

    // Empty input resolves to defaultIndex choice
    if (trimmed === "") {
      return options.choices[defaultIndex].value;
    }

    // 1-based numeric choice index
    if (/^\d+$/.test(trimmed)) {
      const parsedIndex = parseInt(trimmed, 10);
      if (parsedIndex >= 1 && parsedIndex <= options.choices.length) {
        return options.choices[parsedIndex - 1].value;
      }
    }

    // Match by choice label
    const matchByLabel = options.choices.find(
      (c) =>
        c.label === trimmed || c.label.toLowerCase() === trimmed.toLowerCase(),
    );
    if (matchByLabel) {
      return matchByLabel.value;
    }

    // Match by choice value string/primitive representation
    const matchByValue = options.choices.find((c) => {
      if (typeof c.value === "string") {
        return c.value === trimmed ||
          c.value.toLowerCase() === trimmed.toLowerCase();
      }
      if (typeof c.value === "number" || typeof c.value === "boolean") {
        return (
          String(c.value) === trimmed ||
          String(c.value).toLowerCase() === trimmed.toLowerCase()
        );
      }
      return false;
    });
    if (matchByValue) {
      return matchByValue.value;
    }

    // Invalid input: re-prompt cleanly
    writer.writeSync(
      textEncoder.encode(
        `Invalid choice. Please enter 1-${options.choices.length} or a choice name: `,
      ),
    );
  }
}

/**
 * Formats data into a structured ASCII/Unicode table with aligned columns,
 * consistent cell padding, and horizontal borders.
 *
 * spec: docs/contracts/platform.contract.md#PLAT-19 — Repository structure and CLI interactive selection prompts
 * spec: tasks/milestone-0.8-developer-experience-ux/T-0805-terminal-selection-prompts.md#Acceptance criteria AC3 — Column-aligned table formatting with ANSI-safe width calculation
 */
export function formatTable(headers: string[], rows: string[][]): string {
  if (!headers || !Array.isArray(headers) || headers.length === 0) {
    return "";
  }

  const safeRows = rows && Array.isArray(rows) ? rows : [];
  const colCount = Math.max(
    headers.length,
    ...safeRows.map((r) => (r && Array.isArray(r) ? r.length : 0)),
  );

  // Calculate maximum visible column width for each column
  const colWidths: number[] = new Array(colCount).fill(0);

  for (let c = 0; c < colCount; c++) {
    const headerText = headers[c] !== undefined && headers[c] !== null
      ? String(headers[c])
      : "";
    let maxW = visibleWidth(headerText);
    for (const row of safeRows) {
      if (!row || !Array.isArray(row)) continue;
      const cellText = row[c] !== undefined && row[c] !== null
        ? String(row[c])
        : "";
      const w = visibleWidth(cellText);
      if (w > maxW) {
        maxW = w;
      }
    }
    colWidths[c] = Math.max(1, maxW);
  }

  // Format header row: | Header 1 | Header 2 |
  const headerCells = [];
  for (let c = 0; c < colCount; c++) {
    const h = headers[c] !== undefined && headers[c] !== null
      ? String(headers[c])
      : "";
    headerCells.push(padCell(h, colWidths[c]));
  }
  const headerLine = `| ${headerCells.join(" | ")} |`;

  // Format separator line: |----------|----------|
  const dividerCells = [];
  for (let c = 0; c < colCount; c++) {
    dividerCells.push("-".repeat(colWidths[c] + 2));
  }
  const dividerLine = `|${dividerCells.join("|")}|`;

  const lines: string[] = [headerLine, dividerLine];

  // Format data rows: | Data 1   | Data 2   |
  for (const row of safeRows) {
    const rowCells = [];
    for (let c = 0; c < colCount; c++) {
      const cell = row && row[c] !== undefined && row[c] !== null
        ? String(row[c])
        : "";
      rowCells.push(padCell(cell, colWidths[c]));
    }
    lines.push(`| ${rowCells.join(" | ")} |`);
  }

  return lines.join("\n") + "\n";
}
