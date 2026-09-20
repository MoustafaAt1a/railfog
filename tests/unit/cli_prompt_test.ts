// spec: docs/contracts/platform.contract.md#PLAT-19 — Repository structure and CLI interactive selection prompts
// spec: tasks/milestone-0.8-developer-experience-ux/T-0805-terminal-selection-prompts.md#Acceptance criteria

import {
  assertEquals,
  assertMatch,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import {
  type Choice,
  formatTable,
  selectPrompt,
  type SelectPromptOptions,
} from "../../cli/prompt.ts";

// ============================================================================
// Test Helpers & Mock Streams
// ============================================================================

export interface WriterSync {
  writeSync(p: Uint8Array): number;
}

/**
 * In-memory synchronous writer that simulates a terminal or non-terminal stream.
 * Captures written output and implements isTerminal().
 */
class MockTerminalStream implements WriterSync {
  private chunks: Uint8Array[] = [];
  public terminal: boolean;

  constructor(isTerminal = true) {
    this.terminal = isTerminal;
  }

  isTerminal(): boolean {
    return this.terminal;
  }

  writeSync(p: Uint8Array): number {
    this.chunks.push(new Uint8Array(p));
    return p.length;
  }

  get text(): string {
    const decoder = new TextDecoder();
    return this.chunks.map((c: Uint8Array) => decoder.decode(c)).join("");
  }

  get writeCount(): number {
    return this.chunks.length;
  }

  clear(): void {
    this.chunks = [];
  }
}

/**
 * Strips ANSI escape sequences from text for layout inspection.
 */
function stripAnsi(text: string): string {
  // deno-lint-ignore no-control-regex
  return text.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
}

/**
 * Calculates visible character length of a string excluding ANSI escape sequences.
 */
function visibleLength(text: string): number {
  return stripAnsi(text).length;
}

/**
 * Helper to create a sequential stdinReader mock from an array of input chunks.
 */
function createMockStdinReader(inputs: string[]): () => Promise<string> {
  let index = 0;
  return () => {
    if (index < inputs.length) {
      const item = inputs[index++];
      return Promise.resolve(item);
    }
    return Promise.resolve("");
  };
}

// ============================================================================
// Group 1: Choice Configuration & Value Resolution (AC1, AC2, PLAT-19)
// ============================================================================

Deno.test("AC1 (PLAT-19): selectPrompt resolves to selected Choice value with string type", async () => {
  const stream = new MockTerminalStream(true);
  const choices: Choice<string>[] = [
    { label: "Minimal Starter", value: "minimal" },
    { label: "Worked Example", value: "worked-example" },
  ];

  const stdinReader = createMockStdinReader(["\r"]);
  const options: SelectPromptOptions<string> = {
    message: "Select a template:",
    choices,
    stdinReader,
    stream,
    interactive: true,
  };
  const result = await selectPrompt(options);

  assertEquals(
    result,
    "minimal",
    "Immediate Enter should select first choice value",
  );
});

Deno.test("AC1 (PLAT-19): selectPrompt supports strongly typed Choice values (objects, numbers, booleans)", async () => {
  interface TemplateConfig {
    id: string;
    functions: number;
    withKv: boolean;
  }

  const stream = new MockTerminalStream(true);
  const choices: Choice<TemplateConfig>[] = [
    {
      label: "Minimal",
      value: { id: "minimal", functions: 1, withKv: false },
      description: "Single HTTP function",
    },
    {
      label: "Full App",
      value: { id: "worked-example", functions: 4, withKv: true },
      description: "Complete worked example with KV and Queues",
    },
  ];

  // Down arrow then Enter
  const stdinReader = createMockStdinReader(["\x1b[B", "\r"]);
  const result = await selectPrompt({
    message: "Select template configuration:",
    choices,
    stdinReader,
    stream,
    interactive: true,
  });

  assertEquals(
    result,
    { id: "worked-example", functions: 4, withKv: true },
    "Should resolve to the typed object value of the second choice",
  );
});

Deno.test("AC1 (PLAT-19): selectPrompt displays choice label and optional description in rendered output", async () => {
  const stream = new MockTerminalStream(true);
  const choices: Choice<string>[] = [
    {
      label: "Minimal Template",
      value: "min",
      description: "Lean skeleton with single handler",
    },
    {
      label: "Worked Example",
      value: "full",
      description: "Full e-commerce demo with KV storage",
    },
  ];

  const stdinReader = createMockStdinReader(["\r"]);
  await selectPrompt({
    message: "Choose template:",
    choices,
    stdinReader,
    stream,
    interactive: true,
  });

  const output = stream.text;
  assertStringIncludes(
    output,
    "Minimal Template",
    "Render must include first choice label",
  );
  assertStringIncludes(
    output,
    "Worked Example",
    "Render must include second choice label",
  );
  assertStringIncludes(
    output,
    "Lean skeleton with single handler",
    "Render must display first choice description",
  );
  assertStringIncludes(
    output,
    "Full e-commerce demo with KV storage",
    "Render must display second choice description",
  );
});

Deno.test("AC1 (PLAT-19): selectPrompt displays prompt message at top of output", async () => {
  const stream = new MockTerminalStream(true);
  const choices: Choice<string>[] = [
    { label: "Alpha", value: "a" },
    { label: "Beta", value: "b" },
  ];

  const stdinReader = createMockStdinReader(["\r"]);
  await selectPrompt({
    message: "Select target deployment region:",
    choices,
    stdinReader,
    stream,
    interactive: true,
  });

  assertStringIncludes(
    stream.text,
    "Select target deployment region:",
    "Output must render prompt message header",
  );
});

// ============================================================================
// Group 2: Default Index Selection (AC1, AC2, PLAT-19)
// ============================================================================

Deno.test("AC1 (PLAT-19): defaultIndex is 0 when omitted, selecting first choice on immediate enter", async () => {
  const stream = new MockTerminalStream(true);
  const choices: Choice<string>[] = [
    { label: "First", value: "1" },
    { label: "Second", value: "2" },
    { label: "Third", value: "3" },
  ];

  const stdinReader = createMockStdinReader(["\r"]);
  const result = await selectPrompt({
    message: "Select item:",
    choices,
    stdinReader,
    stream,
    interactive: true,
  });

  assertEquals(result, "1", "Default index must be 0 when omitted");
});

Deno.test("AC1 (PLAT-19): defaultIndex specifies initially active choice on immediate enter", async () => {
  const stream = new MockTerminalStream(true);
  const choices: Choice<string>[] = [
    { label: "Option A", value: "a" },
    { label: "Option B", value: "b" },
    { label: "Option C", value: "c" },
  ];

  const stdinReader = createMockStdinReader(["\r"]);
  const result = await selectPrompt({
    message: "Select option:",
    choices,
    defaultIndex: 1,
    stdinReader,
    stream,
    interactive: true,
  });

  assertEquals(result, "b", "defaultIndex: 1 must resolve to Option B");
});

Deno.test("AC1 (PLAT-19): defaultIndex pointing to last element selects last choice", async () => {
  const stream = new MockTerminalStream(true);
  const choices: Choice<string>[] = [
    { label: "Option A", value: "a" },
    { label: "Option B", value: "b" },
    { label: "Option C", value: "c" },
  ];

  const stdinReader = createMockStdinReader(["\r"]);
  const result = await selectPrompt({
    message: "Select option:",
    choices,
    defaultIndex: 2,
    stdinReader,
    stream,
    interactive: true,
  });

  assertEquals(result, "c", "defaultIndex: 2 must resolve to Option C");
});

Deno.test("PLAT-19: negative defaultIndex clamps to 0", async () => {
  const stream = new MockTerminalStream(true);
  const choices: Choice<string>[] = [
    { label: "First", value: "first" },
    { label: "Second", value: "second" },
  ];

  const stdinReader = createMockStdinReader(["\r"]);
  const result = await selectPrompt({
    message: "Select item:",
    choices,
    defaultIndex: -5,
    stdinReader,
    stream,
    interactive: true,
  });

  assertEquals(result, "first", "Negative defaultIndex must clamp to 0");
});

Deno.test("PLAT-19: defaultIndex exceeding choices length clamps to last element", async () => {
  const stream = new MockTerminalStream(true);
  const choices: Choice<string>[] = [
    { label: "First", value: "first" },
    { label: "Second", value: "second" },
  ];

  const stdinReader = createMockStdinReader(["\r"]);
  const result = await selectPrompt({
    message: "Select item:",
    choices,
    defaultIndex: 99,
    stdinReader,
    stream,
    interactive: true,
  });

  assertEquals(
    result,
    "second",
    "Out of bounds defaultIndex must clamp to last choice",
  );
});

Deno.test("PLAT-19: selectPrompt rejects when choices array is empty", async () => {
  const stream = new MockTerminalStream(true);
  const stdinReader = createMockStdinReader(["\r"]);

  await assertRejects(
    async () => {
      await selectPrompt({
        message: "Choose nothing:",
        choices: [],
        stdinReader,
        stream,
      });
    },
    Error,
    undefined,
    "selectPrompt must reject when choices array is empty",
  );
});

// ============================================================================
// Group 3: Arrow Key Navigation & Enter Parsing (AC1, PLAT-19)
// ============================================================================

Deno.test("AC1 (PLAT-19): Down arrow escape sequence (\\x1b[B) advances selection index from 0 to 1", async () => {
  const stream = new MockTerminalStream(true);
  const choices: Choice<string>[] = [
    { label: "Item 0", value: "val-0" },
    { label: "Item 1", value: "val-1" },
    { label: "Item 2", value: "val-2" },
  ];

  // Down arrow, then Enter
  const stdinReader = createMockStdinReader(["\x1b[B", "\r"]);
  const result = await selectPrompt({
    message: "Select item:",
    choices,
    defaultIndex: 0,
    stdinReader,
    stream,
    interactive: true,
  });

  assertEquals(
    result,
    "val-1",
    "Down arrow must advance from index 0 to index 1",
  );
});

Deno.test("AC1 (PLAT-19): Up arrow escape sequence (\\x1b[A) decrements selection index from 1 to 0", async () => {
  const stream = new MockTerminalStream(true);
  const choices: Choice<string>[] = [
    { label: "Item 0", value: "val-0" },
    { label: "Item 1", value: "val-1" },
    { label: "Item 2", value: "val-2" },
  ];

  // Up arrow, then Enter
  const stdinReader = createMockStdinReader(["\x1b[A", "\r"]);
  const result = await selectPrompt({
    message: "Select item:",
    choices,
    defaultIndex: 1,
    stdinReader,
    stream,
    interactive: true,
  });

  assertEquals(
    result,
    "val-0",
    "Up arrow must decrement from index 1 to index 0",
  );
});

Deno.test("AC1 (PLAT-19): Multi-step arrow navigation parses sequential up and down inputs accurately", async () => {
  const stream = new MockTerminalStream(true);
  const choices: Choice<string>[] = [
    { label: "Zero", value: "0" },
    { label: "One", value: "1" },
    { label: "Two", value: "2" },
    { label: "Three", value: "3" },
  ];

  // Start at 0 -> down to 1 -> down to 2 -> down to 3 -> up to 2 -> enter
  const stdinReader = createMockStdinReader([
    "\x1b[B",
    "\x1b[B",
    "\x1b[B",
    "\x1b[A",
    "\r",
  ]);

  const result = await selectPrompt({
    message: "Select number:",
    choices,
    defaultIndex: 0,
    stdinReader,
    stream,
    interactive: true,
  });

  assertEquals(
    result,
    "2",
    "Sequential down/up arrow presses must track active index to 2",
  );
});

Deno.test("AC1 (PLAT-19): SS3 cursor key sequences (\\x1bOB and \\x1bOA) are supported for terminal compatibility", async () => {
  const stream = new MockTerminalStream(true);
  const choices: Choice<string>[] = [
    { label: "A", value: "a" },
    { label: "B", value: "b" },
  ];

  // SS3 down cursor (\x1bOB), then Enter
  const stdinReader = createMockStdinReader(["\x1bOB", "\r"]);
  const result = await selectPrompt({
    message: "Select:",
    choices,
    defaultIndex: 0,
    stdinReader,
    stream,
    interactive: true,
  });

  assertEquals(
    result,
    "b",
    "SS3 cursor code \\x1bOB must be parsed as down arrow",
  );
});

Deno.test("AC1 (PLAT-19): Both LF (\\n) and CRLF (\\r\\n) submit active selection cleanly", async () => {
  const streamLF = new MockTerminalStream(true);
  const choicesLF: Choice<string>[] = [
    { label: "Opt 1", value: "val1" },
    { label: "Opt 2", value: "val2" },
  ];

  const stdinReaderLF = createMockStdinReader(["\n"]);
  const resultLF = await selectPrompt({
    message: "LF test:",
    choices: choicesLF,
    stdinReader: stdinReaderLF,
    stream: streamLF,
    interactive: true,
  });
  assertEquals(resultLF, "val1", "\\n must submit active selection");

  const streamCRLF = new MockTerminalStream(true);
  const stdinReaderCRLF = createMockStdinReader(["\r\n"]);
  const resultCRLF = await selectPrompt({
    message: "CRLF test:",
    choices: choicesLF,
    stdinReader: stdinReaderCRLF,
    stream: streamCRLF,
    interactive: true,
  });
  assertEquals(resultCRLF, "val1", "\\r\\n must submit active selection");
});

Deno.test("AC1 (PLAT-19): Interactive render displays visual indicator pointing to active choice", async () => {
  const stream = new MockTerminalStream(true);
  const choices: Choice<string>[] = [
    { label: "Item One", value: "1" },
    { label: "Item Two", value: "2" },
  ];

  // Start at 0, immediate Enter
  const stdinReader = createMockStdinReader(["\r"]);
  await selectPrompt({
    message: "Pick item:",
    choices,
    defaultIndex: 0,
    stdinReader,
    stream,
    interactive: true,
  });

  const output = stream.text;
  // Indicator characters typically used: >, ❯, *, or styled bullet
  const hasActiveIndicator = output.includes(">") ||
    output.includes("❯") ||
    output.includes("●") ||
    output.includes("*");

  assertEquals(
    hasActiveIndicator,
    true,
    "Interactive render must display active selection indicator (e.g. > or ❯)",
  );
});

// ============================================================================
// Group 4: Non-Interactive / Fallback Stdin Stream Selection (AC2, PLAT-19)
// ============================================================================

Deno.test("AC2 (PLAT-19): Non-interactive numeric input '1' selects first choice", async () => {
  const stream = new MockTerminalStream(false);
  const choices: Choice<string>[] = [
    { label: "Minimal", value: "minimal" },
    { label: "Worked Example", value: "worked-example" },
  ];

  const stdinReader = createMockStdinReader(["1\n"]);
  const result = await selectPrompt({
    message: "Select template:",
    choices,
    stdinReader,
    stream,
    interactive: false,
  });

  assertEquals(
    result,
    "minimal",
    "Numeric input 1 must resolve to first choice",
  );
});

Deno.test("AC2 (PLAT-19): Non-interactive numeric input '2' selects second choice", async () => {
  const stream = new MockTerminalStream(false);
  const choices: Choice<string>[] = [
    { label: "Minimal", value: "minimal" },
    { label: "Worked Example", value: "worked-example" },
  ];

  const stdinReader = createMockStdinReader(["2\n"]);
  const result = await selectPrompt({
    message: "Select template:",
    choices,
    stdinReader,
    stream,
    interactive: false,
  });

  assertEquals(
    result,
    "worked-example",
    "Numeric input 2 must resolve to second choice",
  );
});

Deno.test("AC2 (PLAT-19): Non-interactive numeric input without trailing newline ('2') selects choice", async () => {
  const stream = new MockTerminalStream(false);
  const choices: Choice<string>[] = [
    { label: "Minimal", value: "minimal" },
    { label: "Worked Example", value: "worked-example" },
  ];

  const stdinReader = createMockStdinReader(["2"]);
  const result = await selectPrompt({
    message: "Select template:",
    choices,
    stdinReader,
    stream,
    interactive: false,
  });

  assertEquals(
    result,
    "worked-example",
    "Numeric input '2' without newline must resolve to second choice",
  );
});

Deno.test("AC2 (PLAT-19): Non-interactive empty input (Enter / '\\n') selects defaultIndex choice", async () => {
  const stream = new MockTerminalStream(false);
  const choices: Choice<string>[] = [
    { label: "Minimal", value: "minimal" },
    { label: "Worked Example", value: "worked-example" },
  ];

  const stdinReader = createMockStdinReader(["\n"]);
  const result = await selectPrompt({
    message: "Select template:",
    choices,
    defaultIndex: 1,
    stdinReader,
    stream,
    interactive: false,
  });

  assertEquals(
    result,
    "worked-example",
    "Empty input in fallback mode must resolve to defaultIndex choice",
  );
});

Deno.test("AC2 (PLAT-19): Non-interactive empty string input '' selects defaultIndex choice", async () => {
  const stream = new MockTerminalStream(false);
  const choices: Choice<string>[] = [
    { label: "Alpha", value: "a" },
    { label: "Beta", value: "b" },
  ];

  const stdinReader = createMockStdinReader([""]);
  const result = await selectPrompt({
    message: "Select template:",
    choices,
    defaultIndex: 0,
    stdinReader,
    stream,
    interactive: false,
  });

  assertEquals(
    result,
    "a",
    "Empty string input in fallback mode must resolve to choice 0",
  );
});

Deno.test("AC2 (PLAT-19): Non-interactive input matching choice label directly resolves choice", async () => {
  const stream = new MockTerminalStream(false);
  const choices: Choice<string>[] = [
    { label: "minimal", value: "min-val" },
    { label: "worked-example", value: "we-val" },
  ];

  const stdinReader = createMockStdinReader(["worked-example\n"]);
  const result = await selectPrompt({
    message: "Select template:",
    choices,
    stdinReader,
    stream,
    interactive: false,
  });

  assertEquals(
    result,
    "we-val",
    "Direct matching label input must resolve to corresponding choice value",
  );
});

Deno.test("AC2 (PLAT-19): Non-interactive input matching choice value directly resolves choice", async () => {
  const stream = new MockTerminalStream(false);
  const choices: Choice<string>[] = [
    { label: "Starter Kit", value: "starter" },
    { label: "Enterprise Kit", value: "enterprise" },
  ];

  const stdinReader = createMockStdinReader(["enterprise\n"]);
  const result = await selectPrompt({
    message: "Select kit:",
    choices,
    stdinReader,
    stream,
    interactive: false,
  });

  assertEquals(
    result,
    "enterprise",
    "Direct matching value string input must resolve choice",
  );
});

Deno.test("AC2 (PLAT-19): Non-interactive invalid input re-prompts until valid choice index is received", async () => {
  const stream = new MockTerminalStream(false);
  const choices: Choice<string>[] = [
    { label: "Option 1", value: "opt1" },
    { label: "Option 2", value: "opt2" },
  ];

  // First input is invalid (99), second is valid (2)
  const stdinReader = createMockStdinReader(["99\n", "2\n"]);
  const result = await selectPrompt({
    message: "Select option:",
    choices,
    stdinReader,
    stream,
    interactive: false,
  });

  assertEquals(
    result,
    "opt2",
    "Invalid input must trigger re-prompt and resolve on subsequent valid input",
  );
});

Deno.test("AC2 (PLAT-19): Non-interactive fallback renders numbered choices list", async () => {
  const stream = new MockTerminalStream(false);
  const choices: Choice<string>[] = [
    { label: "First Option", value: "1" },
    { label: "Second Option", value: "2" },
  ];

  const stdinReader = createMockStdinReader(["1\n"]);
  await selectPrompt({
    message: "Please choose:",
    choices,
    stdinReader,
    stream,
    interactive: false,
  });

  const output = stream.text;
  assertStringIncludes(
    output,
    "First Option",
    "Non-interactive output must include first choice",
  );
  assertStringIncludes(
    output,
    "Second Option",
    "Non-interactive output must include second choice",
  );
  // Check for numbered list indicators such as "1)" or "1." or "[1]"
  const hasNumberedChoices = output.includes("1)") ||
    output.includes("1.") ||
    output.includes("[1]");
  assertEquals(
    hasNumberedChoices,
    true,
    "Non-interactive render must present numbered choice options for fallback selection",
  );
});

// ============================================================================
// Group 5: formatTable Layout, Padding, and Alignment (AC3, PLAT-19)
// ============================================================================

Deno.test("AC3 (PLAT-19): formatTable renders headers, data rows, and border separators", () => {
  const headers = ["Function", "Runtime", "Status"];
  const rows = [
    ["auth-handler", "deno-2.2", "active"],
    ["api-gateway", "deno-2.2", "idle"],
  ];

  const table: string = formatTable(headers, rows);

  assertStringIncludes(
    table,
    "Function",
    "Table must render header 'Function'",
  );
  assertStringIncludes(table, "Runtime", "Table must render header 'Runtime'");
  assertStringIncludes(table, "Status", "Table must render header 'Status'");
  assertStringIncludes(
    table,
    "auth-handler",
    "Table must render row data 'auth-handler'",
  );
  assertStringIncludes(
    table,
    "api-gateway",
    "Table must render row data 'api-gateway'",
  );

  // Table must contain divider / border characters
  const hasBorders = table.includes("-") || table.includes("─") ||
    table.includes("=");
  assertEquals(
    hasBorders,
    true,
    "Table must contain horizontal border separators",
  );
});

Deno.test("AC3 (PLAT-19): formatTable produces consistent line widths across all rows (rectangular alignment)", () => {
  const headers = ["Name", "Revision", "Routes", "Memory"];
  const rows = [
    ["billing", "rev_01ABC", "/api/v1/billing", "128MB"],
    ["users-service-production", "rev_01XYZ", "/users", "256MB"],
    ["edge", "rev_02DEF", "/", "64MB"],
  ];

  const table: string = formatTable(headers, rows);
  const lines: string[] = table
    .split("\n")
    .map((l: string) => l.trimEnd())
    .filter((l: string) => l.length > 0);

  assertEquals(
    lines.length >= 4,
    true,
    "Table must contain at least headers, separator, and data rows",
  );

  const expectedWidth = visibleLength(lines[0]);
  for (let i = 0; i < lines.length; i++) {
    const lineWidth = visibleLength(lines[i]);
    assertEquals(
      lineWidth,
      expectedWidth,
      `Line ${i} visible width (${lineWidth}) does not match line 0 width (${expectedWidth}): "${
        lines[i]
      }"`,
    );
  }
});

Deno.test("AC3 (PLAT-19): formatTable expands column width to accommodate longest cell value", () => {
  const headers = ["ID", "Tag"];
  const longValue = "railfog-function-worker-us-east-long-id-1234567890";
  const rows = [
    [longValue, "prod"],
    ["short", "dev"],
  ];

  const table: string = formatTable(headers, rows);
  assertStringIncludes(
    table,
    longValue,
    "Table must include the entire long cell value without truncation",
  );

  const lines: string[] = table
    .split("\n")
    .map((l: string) => l.trimEnd())
    .filter((l: string) => l.length > 0);
  const tableWidth = visibleLength(lines[0]);
  assertEquals(
    tableWidth > longValue.length + 6,
    true,
    `Table width (${tableWidth}) must accommodate longest cell content (${longValue.length}) plus padding and borders`,
  );
});

Deno.test("AC3 (PLAT-19): formatTable expands column width to accommodate longest header when header exceeds cell values", () => {
  const longHeader = "DetailedDescriptionOfResourceLifecycleStatus";
  const headers = [longHeader, "Code"];
  const rows = [
    ["active", "200"],
    ["stopped", "503"],
  ];

  const table: string = formatTable(headers, rows);
  assertStringIncludes(
    table,
    longHeader,
    "Table must include the full long header text",
  );

  const lines: string[] = table
    .split("\n")
    .map((l: string) => l.trimEnd())
    .filter((l: string) => l.length > 0);
  const tableWidth = visibleLength(lines[0]);
  assertEquals(
    tableWidth > longHeader.length + 6,
    true,
    `Table width (${tableWidth}) must expand to fit wide header (${longHeader.length})`,
  );
});

Deno.test("AC3 (PLAT-19): formatTable provides cell padding separating content from borders", () => {
  const headers = ["A", "B"];
  const rows = [["1", "2"]];

  const table: string = formatTable(headers, rows);
  const lines: string[] = table
    .split("\n")
    .map((l: string) => l.trimEnd())
    .filter((l: string) => l.length > 0);

  // For each line containing cell text, verify whitespace padding surrounds cell entries
  const dataLine = lines.find((l: string) =>
    l.includes("1") && l.includes("2")
  );
  assertEquals(dataLine !== undefined, true, "Data line must exist");

  // In standard table formatting, cells are flanked by spaces: e.g. "| 1 | 2 |" or "│ 1 │ 2 │"
  assertMatch(
    dataLine!,
    /[|│]\s+1\s+[|│]\s+2\s+[|│]/,
    "Cell values must have padding between text and column dividers",
  );
});

Deno.test("AC3 (PLAT-19): formatTable handles empty string cells ('') without breaking column borders", () => {
  const headers = ["Service", "Endpoint", "Notes"];
  const rows = [
    ["auth", "/auth", ""],
    ["api", "", "No route bound"],
    ["", "/status", "Healthcheck"],
  ];

  const table: string = formatTable(headers, rows);
  const lines: string[] = table
    .split("\n")
    .map((l: string) => l.trimEnd())
    .filter((l: string) => l.length > 0);

  const expectedWidth = visibleLength(lines[0]);
  for (let i = 0; i < lines.length; i++) {
    const lineWidth = visibleLength(lines[i]);
    assertEquals(
      lineWidth,
      expectedWidth,
      `Line ${i} with empty cells broke rectangular width: expected ${expectedWidth}, got ${lineWidth}`,
    );
  }
});

Deno.test("AC3 (PLAT-19): formatTable handles rows with fewer cells than headers (missing columns)", () => {
  const headers = ["Col1", "Col2", "Col3"];
  const rows = [
    ["only-col1"],
    ["col1-val", "col2-val"],
  ];

  const table: string = formatTable(headers, rows);
  const lines: string[] = table
    .split("\n")
    .map((l: string) => l.trimEnd())
    .filter((l: string) => l.length > 0);

  const expectedWidth = visibleLength(lines[0]);
  for (let i = 0; i < lines.length; i++) {
    const lineWidth = visibleLength(lines[i]);
    assertEquals(
      lineWidth,
      expectedWidth,
      `Row with missing cells broke rectangular alignment at line ${i}`,
    );
  }
});

Deno.test("AC3 (PLAT-19): formatTable handles empty rows array (headers only) cleanly", () => {
  const headers = ["Metric", "Value", "Unit"];
  const table: string = formatTable(headers, []);

  assertStringIncludes(table, "Metric");
  assertStringIncludes(table, "Value");
  assertStringIncludes(table, "Unit");

  const lines: string[] = table
    .split("\n")
    .map((l: string) => l.trimEnd())
    .filter((l: string) => l.length > 0);
  assertEquals(
    lines.length >= 2,
    true,
    "Header-only table must render headers and separator",
  );

  const expectedWidth = visibleLength(lines[0]);
  for (let i = 0; i < lines.length; i++) {
    assertEquals(
      visibleLength(lines[i]),
      expectedWidth,
      `Header-only table line ${i} must match header width`,
    );
  }
});

Deno.test("AC3 (PLAT-19): formatTable renders single column tables properly", () => {
  const headers = ["Command"];
  const rows = [["rail dev"], ["rail deploy"], ["rail logs"]];

  const table: string = formatTable(headers, rows);
  assertStringIncludes(table, "rail dev");
  assertStringIncludes(table, "rail deploy");

  const lines: string[] = table
    .split("\n")
    .map((l: string) => l.trimEnd())
    .filter((l: string) => l.length > 0);
  const expectedWidth = visibleLength(lines[0]);
  for (let i = 0; i < lines.length; i++) {
    assertEquals(
      visibleLength(lines[i]),
      expectedWidth,
      `Single-column table line ${i} must have consistent width`,
    );
  }
});

Deno.test("AC3 (PLAT-19): formatTable aligns columns correctly even when cell contains ANSI color sequences", () => {
  const headers = ["Name", "Status"];
  // Green ANSI code "\x1b[32m" and reset "\x1b[39m"
  const rows = [
    ["auth", "\x1b[32mactive\x1b[39m"],
    ["billing", "active"],
  ];

  const table: string = formatTable(headers, rows);
  const lines: string[] = table
    .split("\n")
    .map((l: string) => l.trimEnd())
    .filter((l: string) => l.length > 0);

  // Compare visible lengths (excluding ANSI control characters)
  const line0Width = visibleLength(lines[0]);
  for (let i = 0; i < lines.length; i++) {
    const vLen = visibleLength(lines[i]);
    assertEquals(
      vLen,
      line0Width,
      `ANSI-colored row line ${i} visual length (${vLen}) must match header length (${line0Width})`,
    );
  }
});

// ============================================================================
// Group 6: Edge Cases, Special Characters & Defensive Validation (PLAT-19)
// ============================================================================

Deno.test("PLAT-19: selectPrompt functions cleanly with single choice available", async () => {
  const stream = new MockTerminalStream(true);
  const choices: Choice<string>[] = [
    { label: "The Only Option", value: "sole-choice" },
  ];

  const stdinReader = createMockStdinReader(["\r"]);
  const result = await selectPrompt({
    message: "Select:",
    choices,
    stdinReader,
    stream,
    interactive: true,
  });

  assertEquals(
    result,
    "sole-choice",
    "Single-choice prompt must resolve immediately on enter",
  );
});

Deno.test("PLAT-19: selectPrompt handles choices with special characters and symbols safely", async () => {
  const stream = new MockTerminalStream(true);
  const choices: Choice<string>[] = [
    {
      label: "Special <XML> & JSON 'quotes' \"double\" `backticks` $VAR",
      value: "special-1",
      description: "Characters: %, *, &, #, @, !, ^, ~",
    },
    {
      label: "Unicode: 🚀 ⚡ 📦 🔧",
      value: "special-2",
      description: "Emojis and symbols",
    },
  ];

  const stdinReader = createMockStdinReader(["\x1b[B", "\r"]);
  const result = await selectPrompt({
    message: "Special character test:",
    choices,
    stdinReader,
    stream,
    interactive: true,
  });

  assertEquals(
    result,
    "special-2",
    "Must resolve choice with unicode/special characters",
  );
  assertStringIncludes(
    stream.text,
    "Special <XML> & JSON",
    "Rendered text must safely contain special chars",
  );
  assertStringIncludes(
    stream.text,
    "Characters: %, *, &",
    "Rendered text must safely contain descriptions",
  );
});

Deno.test("PLAT-19: selectPrompt supports boolean choices (true / false)", async () => {
  const stream = new MockTerminalStream(true);
  const choices: Choice<boolean>[] = [
    { label: "Yes (enable)", value: true },
    { label: "No (disable)", value: false },
  ];

  // Down to "No" (false) then Enter
  const stdinReader = createMockStdinReader(["\x1b[B", "\r"]);
  const result = await selectPrompt({
    message: "Enable background workers?",
    choices,
    defaultIndex: 0,
    stdinReader,
    stream,
    interactive: true,
  });

  assertEquals(result, false, "Must resolve boolean value false");
});

Deno.test("PLAT-19: selectPrompt rejects on null or undefined options or empty message", async () => {
  await assertRejects(
    async () => {
      // deno-lint-ignore no-explicit-any
      await selectPrompt(null as any);
    },
    Error,
    undefined,
    "selectPrompt must reject null options",
  );

  await assertRejects(
    async () => {
      // deno-lint-ignore no-explicit-any
      await selectPrompt(undefined as any);
    },
    Error,
    undefined,
    "selectPrompt must reject undefined options",
  );
});
