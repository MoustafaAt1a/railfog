// spec: docs/contracts/platform.contract.md#PLAT-19 — Repository structure and CLI interactive step indicator
// spec: tasks/milestone-0.8-developer-experience-ux/T-0804-terminal-status-spinners.md#Acceptance criteria

import { assertEquals, assertFalse, assertStringIncludes } from "@std/assert";
import {
  createSignalSpinner,
  createSpinner,
  createTrackSpinner,
  createWheelSpinner,
  type Spinner,
  type SpinnerOptions,
} from "../../cli/spinner.ts";

// ============================================================================
// Test Helpers & Mock Terminal Streams
// ============================================================================

interface WriterSync {
  writeSync(p: Uint8Array): number;
}

/**
 * In-memory synchronous writer that simulates a terminal or non-terminal stream.
 * Implements synchronous writing and includes isTerminal() matching Deno.stdout.isTerminal().
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
    return this.chunks.map((c) => decoder.decode(c)).join("");
  }

  get writeCount(): number {
    return this.chunks.length;
  }

  clear(): void {
    this.chunks = [];
  }
}

/**
 * Helper predicates for checking ANSI escape sequences.
 */
function hasAnsiEscape(text: string): boolean {
  // deno-lint-ignore no-control-regex
  return /\x1b\[[0-9;?]*[a-zA-Z]/.test(text);
}

function hasAnsiColor(text: string): boolean {
  // deno-lint-ignore no-control-regex
  return /\x1b\[(?:3[0-7]|9[0-7]|4[0-7]|10[0-7])m/.test(text);
}

function hasGreenOrCheckmark(text: string): boolean {
  // deno-lint-ignore no-control-regex
  const hasGreen = /\x1b\[(?:32|92)m/.test(text);
  return hasGreen || text.includes("✔") || text.includes("√") ||
    text.includes("[+]");
}

function hasRedOrCross(text: string): boolean {
  // deno-lint-ignore no-control-regex
  const hasRed = /\x1b\[(?:31|91)m/.test(text);
  return hasRed || text.includes("✖") || text.includes("×") ||
    text.includes("[-]");
}

/**
 * Executes a callback with custom environment variables and Deno.stdout.isTerminal override,
 * restoring original state in a finally block.
 */
async function withTerminalEnv(
  options: {
    isTerminal?: boolean;
    env?: Record<string, string | undefined>;
  },
  fn: () => Promise<void> | void,
): Promise<void> {
  const originalEnv: Record<string, string | undefined> = {};
  const originalIsTerminal = Deno.stdout.isTerminal?.bind(Deno.stdout);

  if (options.env) {
    for (const [key, value] of Object.entries(options.env)) {
      originalEnv[key] = Deno.env.get(key);
      if (value === undefined) {
        Deno.env.delete(key);
      } else {
        Deno.env.set(key, value);
      }
    }
  }

  if (options.isTerminal !== undefined && Deno.stdout.isTerminal) {
    Deno.stdout.isTerminal = () => options.isTerminal!;
  }

  try {
    await fn();
  } finally {
    if (options.env) {
      for (const [key, value] of Object.entries(originalEnv)) {
        if (value === undefined) {
          Deno.env.delete(key);
        } else {
          Deno.env.set(key, value);
        }
      }
    }
    if (originalIsTerminal && Deno.stdout.isTerminal) {
      Deno.stdout.isTerminal = originalIsTerminal;
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withInteractiveEnv(fn: () => Promise<void> | void): Promise<void> {
  return withTerminalEnv({
    isTerminal: true,
    env: { CI: undefined, NO_COLOR: undefined },
  }, fn);
}

// ============================================================================
// Group 1: Spinner Lifecycle Transitions (AC1, AC2, AC3, PLAT-19)
// ============================================================================

Deno.test("AC1 (PLAT-19): start() sets initial message, returns spinner instance for method chaining, and writes initial frame", async () => {
  await withInteractiveEnv(() => {
    const stream = new MockTerminalStream(true);
    const options: SpinnerOptions = { stream, intervalMs: 100 };
    const spinner: Spinner = createSpinner(options);

    const returned = spinner.start("Packaging functions...");
    try {
      assertEquals(
        returned,
        spinner,
        "start() must return the spinner instance for chaining",
      );
      assertStringIncludes(
        stream.text,
        "Packaging functions...",
        "Initial render must include start message",
      );
    } finally {
      spinner.stop();
    }
  });
});

Deno.test("AC1 (PLAT-19): setText() updates current message dynamically and returns spinner instance for method chaining", async () => {
  await withInteractiveEnv(() => {
    const stream = new MockTerminalStream(true);
    const options: SpinnerOptions = { stream, intervalMs: 100 };
    const spinner: Spinner = createSpinner(options);

    spinner.start("Packaging functions...");
    const returned = spinner.setText("Optimizing bundle assets...");
    try {
      assertEquals(
        returned,
        spinner,
        "setText() must return the spinner instance for chaining",
      );
      assertStringIncludes(
        stream.text,
        "Optimizing bundle assets...",
        "Render after setText must include updated message",
      );
    } finally {
      spinner.stop();
    }
  });
});

Deno.test("AC2 (PLAT-19): succeed() with message halts the spinner, restores cursor, and prints persistent green checkmark with message", async () => {
  await withInteractiveEnv(() => {
    const stream = new MockTerminalStream(true);
    const options: SpinnerOptions = { stream, intervalMs: 50 };
    const spinner: Spinner = createSpinner(options);

    spinner.start("Packaging functions...");
    spinner.succeed("Packaged successfully");

    const output = stream.text;
    assertStringIncludes(
      output,
      "Packaged successfully",
      "succeed() must print the provided message",
    );
    assertStringIncludes(
      output,
      "\x1b[?25h",
      "succeed() must write cursor restore sequence (\\x1b[?25h)",
    );
    assertStringIncludes(output, "\n", "succeed() must end with a newline");
    assertEquals(
      hasGreenOrCheckmark(output),
      true,
      "succeed() must include green ANSI styling or checkmark symbol",
    );
  });
});

Deno.test("AC2 (PLAT-19): succeed() without argument uses previously set message from start or setText", async () => {
  await withInteractiveEnv(() => {
    const stream = new MockTerminalStream(true);
    const options: SpinnerOptions = { stream, intervalMs: 50 };
    const spinner: Spinner = createSpinner(options);

    spinner.start("Deploying revision...");
    spinner.succeed();

    const output = stream.text;
    assertStringIncludes(
      output,
      "Deploying revision...",
      "succeed() without arguments must retain existing message",
    );
    assertStringIncludes(output, "\x1b[?25h", "succeed() must restore cursor");
    assertStringIncludes(
      output,
      "\n",
      "succeed() must terminate line with newline",
    );
  });
});

Deno.test("AC3 (PLAT-19): fail() with message halts the spinner, restores cursor, and prints persistent red cross with message", async () => {
  await withInteractiveEnv(() => {
    const stream = new MockTerminalStream(true);
    const options: SpinnerOptions = { stream, intervalMs: 50 };
    const spinner: Spinner = createSpinner(options);

    spinner.start("Building snapshot...");
    spinner.fail("Build failed");

    const output = stream.text;
    assertStringIncludes(
      output,
      "Build failed",
      "fail() must print the provided failure message",
    );
    assertStringIncludes(
      output,
      "\x1b[?25h",
      "fail() must write cursor restore sequence (\\x1b[?25h)",
    );
    assertStringIncludes(output, "\n", "fail() must end with a newline");
    assertEquals(
      hasRedOrCross(output),
      true,
      "fail() must include red ANSI styling or error cross symbol",
    );
  });
});

Deno.test("AC3 (PLAT-19): fail() without argument uses previously set message", async () => {
  await withInteractiveEnv(() => {
    const stream = new MockTerminalStream(true);
    const options: SpinnerOptions = { stream, intervalMs: 50 };
    const spinner: Spinner = createSpinner(options);

    spinner.start("Validating permissions...");
    spinner.fail();

    const output = stream.text;
    assertStringIncludes(
      output,
      "Validating permissions...",
      "fail() without arguments must retain existing message",
    );
    assertStringIncludes(output, "\x1b[?25h", "fail() must restore cursor");
    assertStringIncludes(
      output,
      "\n",
      "fail() must terminate line with newline",
    );
  });
});

Deno.test("PLAT-19: stop() halts animation and restores cursor without printing status mark", async () => {
  await withInteractiveEnv(() => {
    const stream = new MockTerminalStream(true);
    const options: SpinnerOptions = { stream, intervalMs: 50 };
    const spinner: Spinner = createSpinner(options);

    spinner.start("Compiling handler...");
    spinner.stop();

    const output = stream.text;
    assertStringIncludes(output, "\x1b[?25h", "stop() must restore cursor");
    assertFalse(
      output.includes("✔") || output.includes("[+]"),
      "stop() must not print success indicator",
    );
    assertFalse(
      output.includes("✖") || output.includes("[-]"),
      "stop() must not print failure indicator",
    );
  });
});

Deno.test("PLAT-19: calling stop(), succeed(), or fail() multiple times is idempotent", async () => {
  await withInteractiveEnv(() => {
    const stream = new MockTerminalStream(true);
    const options: SpinnerOptions = { stream, intervalMs: 50 };
    const spinner: Spinner = createSpinner(options);

    spinner.start("Idempotent test");
    spinner.succeed("First completion");
    // Redundant terminal calls should not throw or leak
    spinner.succeed("Second completion");
    spinner.stop();
    spinner.fail("Late failure");

    assertStringIncludes(stream.text, "First completion");
  });
});

Deno.test("PLAT-19: calling start() while already running resets/restarts cleanly without leaking timers", async () => {
  await withInteractiveEnv(() => {
    const stream = new MockTerminalStream(true);
    const options: SpinnerOptions = { stream, intervalMs: 50 };
    const spinner: Spinner = createSpinner(options);

    spinner.start("Initial task");
    spinner.start("Restarted task");
    spinner.stop();

    assertStringIncludes(stream.text, "Restarted task");
  });
});

// ============================================================================
// Group 2: Interactive TTY Stream Writing & Animation (AC1, PLAT-19)
// ============================================================================

Deno.test("AC1 (PLAT-19): Interactive TTY hides cursor on start and writes animated frames across intervals", async () => {
  await withTerminalEnv({
    isTerminal: true,
    env: { CI: undefined, NO_COLOR: undefined },
  }, async () => {
    const stream = new MockTerminalStream(true);
    const spinner = createSpinner({ stream, intervalMs: 25 });

    spinner.start("Packaging functions...");
    try {
      assertStringIncludes(
        stream.text,
        "\x1b[?25l",
        "Interactive start() must emit cursor hide sequence (\\x1b[?25l)",
      );
      const initialCount = stream.writeCount;

      // Wait for at least 3 interval ticks (25ms * 3 = 75ms)
      await delay(90);

      const animatedCount = stream.writeCount;
      assertEquals(
        animatedCount > initialCount,
        true,
        `Expected animated frames to write on interval, wrote ${animatedCount} chunks vs initial ${initialCount}`,
      );

      // Verify carriage return or line clear sequences are emitted during animated redraws
      const hasTerminalControls = stream.text.includes("\r") ||
        stream.text.includes("\x1b[2K") || stream.text.includes("\x1b[K");
      assertEquals(
        hasTerminalControls,
        true,
        "Animated frames must use \\r or line clear sequence (\\x1b[2K)",
      );
    } finally {
      spinner.stop();
    }
  });
});

Deno.test("AC1 (PLAT-19): Animation cycles through spinner frames (e.g. braille spinner characters)", async () => {
  await withTerminalEnv({
    isTerminal: true,
    env: { CI: undefined, NO_COLOR: undefined },
  }, async () => {
    const stream = new MockTerminalStream(true);
    const spinner = createSpinner({ stream, intervalMs: 20 });

    spinner.start("Crunching numbers...");
    try {
      await delay(80);
      const text = stream.text;
      // Braille spinner characters: ⠋, ⠙, ⠹, ⠸, ⠼, ⠴, ⠦, ⠧, ⠇, ⠏
      const braillePattern = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/g;
      const matches = text.match(braillePattern);
      assertEquals(
        matches !== null && matches.length >= 2,
        true,
        "Animation must cycle through multiple distinct spinner characters across intervals",
      );
    } finally {
      spinner.stop();
    }
  });
});

Deno.test("AC1 (PLAT-19): Interactive mode renders text update on subsequent animation tick", async () => {
  await withTerminalEnv({
    isTerminal: true,
    env: { CI: undefined, NO_COLOR: undefined },
  }, async () => {
    const stream = new MockTerminalStream(true);
    const spinner = createSpinner({ stream, intervalMs: 25 });

    spinner.start("Phase 1");
    try {
      await delay(35);
      spinner.setText("Phase 2 in progress");
      await delay(45);
      assertStringIncludes(
        stream.text,
        "Phase 2 in progress",
        "Stream must contain updated text after interval tick",
      );
    } finally {
      spinner.stop();
    }
  });
});

// ============================================================================
// Group 3: Static Fallback Mode (AC4, PLAT-19)
// ============================================================================

Deno.test("AC4 (PLAT-19): Non-interactive TTY omits ANSI escape sequences and animation timers", async () => {
  await withTerminalEnv({
    isTerminal: false,
    env: { CI: undefined, NO_COLOR: undefined },
  }, async () => {
    const stream = new MockTerminalStream(false);
    const spinner = createSpinner({ stream, intervalMs: 25 });

    spinner.start("Non-interactive task...");
    const initialCount = stream.writeCount;

    // Wait to verify no interval timer animation writes to stream
    await delay(60);
    assertEquals(
      stream.writeCount,
      initialCount,
      "Non-interactive mode must not schedule recurring animation writes",
    );

    // Output must NOT contain cursor controls or ANSI escape codes
    assertFalse(
      stream.text.includes("\x1b[?25l"),
      "Non-interactive mode must not hide cursor",
    );
    assertFalse(
      hasAnsiEscape(stream.text),
      "Non-interactive mode must not emit ANSI escape codes",
    );

    spinner.succeed("Completed non-interactively");
    assertStringIncludes(stream.text, "Completed non-interactively");
    assertFalse(
      hasAnsiEscape(stream.text),
      "succeed() in non-interactive mode must omit all ANSI codes",
    );
  });
});

Deno.test("AC4 (PLAT-19): NO_COLOR=1 suppresses ANSI color escape sequences", async () => {
  await withTerminalEnv({
    isTerminal: true,
    env: { NO_COLOR: "1", CI: undefined },
  }, () => {
    const stream = new MockTerminalStream(true);
    const spinner = createSpinner({ stream, intervalMs: 50 });

    spinner.start("Uncolored task");
    spinner.succeed("Uncolored finish");

    const text = stream.text;
    assertStringIncludes(text, "Uncolored finish");
    // Verify no ANSI color sequences (\x1b[30m - \x1b[37m, \x1b[90m - \x1b[97m)
    assertFalse(
      hasAnsiColor(text),
      "NO_COLOR=1 must suppress all ANSI color sequences",
    );
  });
});

Deno.test("AC4 (PLAT-19): CI=true activates static fallback mode without terminal animation", async () => {
  await withTerminalEnv({
    isTerminal: true,
    env: { CI: "true", NO_COLOR: undefined },
  }, async () => {
    const stream = new MockTerminalStream(true);
    const spinner = createSpinner({ stream, intervalMs: 25 });

    spinner.start("CI pipeline build...");
    const initialCount = stream.writeCount;

    await delay(60);
    assertEquals(
      stream.writeCount,
      initialCount,
      "CI environment must not animate frames on interval",
    );

    spinner.succeed("CI build finished");
    assertStringIncludes(stream.text, "CI build finished");
    assertFalse(
      stream.text.includes("\x1b[?25l"),
      "CI environment must not emit cursor hide escape code",
    );
  });
});

Deno.test("AC4 (PLAT-19): fail() in non-interactive mode outputs static error message without ANSI codes", async () => {
  await withTerminalEnv({
    isTerminal: false,
    env: { CI: undefined, NO_COLOR: undefined },
  }, () => {
    const stream = new MockTerminalStream(false);
    const spinner = createSpinner({ stream });

    spinner.start("Checking routes");
    spinner.fail("Route validation failed");

    const text = stream.text;
    assertStringIncludes(text, "Route validation failed");
    assertFalse(
      hasAnsiEscape(text),
      "fail() in non-interactive mode must not contain ANSI codes",
    );
  });
});

// ============================================================================
// Group 4: Interval Timer Cleanup (AC1, AC2, AC3, PLAT-19)
// ============================================================================

Deno.test("PLAT-19: succeed() halts interval timer and produces zero subsequent writes", async () => {
  await withTerminalEnv({
    isTerminal: true,
    env: { CI: undefined, NO_COLOR: undefined },
  }, async () => {
    const stream = new MockTerminalStream(true);
    const spinner = createSpinner({ stream, intervalMs: 20 });

    spinner.start("Processing batch");
    await delay(35);

    spinner.succeed("Batch processed");
    const countAtSuccess = stream.writeCount;

    // Wait past multiple potential interval ticks
    await delay(60);
    assertEquals(
      stream.writeCount,
      countAtSuccess,
      "No additional writes must occur after succeed() is called",
    );
  });
});

Deno.test("PLAT-19: fail() halts interval timer and produces zero subsequent writes", async () => {
  await withTerminalEnv({
    isTerminal: true,
    env: { CI: undefined, NO_COLOR: undefined },
  }, async () => {
    const stream = new MockTerminalStream(true);
    const spinner = createSpinner({ stream, intervalMs: 20 });

    spinner.start("Uploading asset");
    await delay(35);

    spinner.fail("Upload error");
    const countAtFail = stream.writeCount;

    // Wait past multiple potential interval ticks
    await delay(60);
    assertEquals(
      stream.writeCount,
      countAtFail,
      "No additional writes must occur after fail() is called",
    );
  });
});

Deno.test("PLAT-19: stop() halts interval timer and produces zero subsequent writes", async () => {
  await withTerminalEnv({
    isTerminal: true,
    env: { CI: undefined, NO_COLOR: undefined },
  }, async () => {
    const stream = new MockTerminalStream(true);
    const spinner = createSpinner({ stream, intervalMs: 20 });

    spinner.start("Starting worker");
    await delay(35);

    spinner.stop();
    const countAtStop = stream.writeCount;

    // Wait past multiple potential interval ticks
    await delay(60);
    assertEquals(
      stream.writeCount,
      countAtStop,
      "No additional writes must occur after stop() is called",
    );
  });
});

Deno.test("PLAT-19: stopping immediately after start() clears timer cleanly with no leaks", async () => {
  await withTerminalEnv({
    isTerminal: true,
    env: { CI: undefined, NO_COLOR: undefined },
  }, async () => {
    const stream = new MockTerminalStream(true);
    const spinner = createSpinner({ stream, intervalMs: 50 });

    spinner.start("Immediate abort");
    spinner.stop();

    await delay(70);
    // Verified by Deno's async op & scheduled timer leak detector
  });
});

// ============================================================================
// Group 5: Options, Edge Cases & Sanitization (PLAT-19)
// ============================================================================

Deno.test("PLAT-19: createSpinner() without arguments instantiates a valid Spinner with default options", () => {
  const spinner: Spinner = createSpinner();
  assertEquals(typeof spinner.start, "function");
  assertEquals(typeof spinner.setText, "function");
  assertEquals(typeof spinner.succeed, "function");
  assertEquals(typeof spinner.fail, "function");
  assertEquals(typeof spinner.stop, "function");
});

Deno.test("PLAT-19: custom intervalMs option dictates animation frequency", async () => {
  await withTerminalEnv({
    isTerminal: true,
    env: { CI: undefined, NO_COLOR: undefined },
  }, async () => {
    const stream = new MockTerminalStream(true);
    const spinner = createSpinner({ stream, intervalMs: 15 });

    spinner.start("High frequency check");
    try {
      await delay(50);
      assertEquals(
        stream.writeCount >= 2,
        true,
        `Expected at least 2 writes with 15ms interval over 50ms, got ${stream.writeCount}`,
      );
    } finally {
      spinner.stop();
    }
  });
});

Deno.test("PLAT-19: message containing format specifiers or special characters is handled safely without interpolation errors", async () => {
  await withInteractiveEnv(() => {
    const stream = new MockTerminalStream(true);
    const spinner = createSpinner({ stream });

    const trickyMessage = "Uploading 100% complete (%s, %d, ${env}) [test]";
    spinner.start(trickyMessage);
    spinner.succeed("Completed 100% (%s, %x)");

    assertStringIncludes(stream.text, trickyMessage);
    assertStringIncludes(stream.text, "Completed 100% (%s, %x)");
  });
});

Deno.test("Railway DX: createWheelSpinner cycles through locomotive wheel rotation frames", async () => {
  await withTerminalEnv({
    isTerminal: true,
    env: { CI: undefined, NO_COLOR: undefined },
  }, async () => {
    const stream = new MockTerminalStream(true);
    const spinner = createWheelSpinner({ stream, intervalMs: 20 });
    spinner.start("Coupling locomotive cars...");
    try {
      await delay(80);
      const text = stream.text;
      const wheelPattern = /[◜◠◝◞◡◟]/g;
      const matches = text.match(wheelPattern);
      assertEquals(
        matches !== null && matches.length >= 2,
        true,
        "Wheel spinner must cycle through locomotive wheel frames",
      );
    } finally {
      spinner.stop();
    }
  });
});

Deno.test("Railway DX: createSignalSpinner cycles through railway signal disc frames", async () => {
  await withTerminalEnv({
    isTerminal: true,
    env: { CI: undefined, NO_COLOR: undefined },
  }, async () => {
    const stream = new MockTerminalStream(true);
    const spinner = createSignalSpinner({ stream, intervalMs: 20 });
    spinner.start("Checking track signals...");
    try {
      await delay(80);
      const text = stream.text;
      const signalPattern = /[◐◓◑◒]/g;
      const matches = text.match(signalPattern);
      assertEquals(
        matches !== null && matches.length >= 2,
        true,
        "Signal spinner must cycle through signal disc aspects",
      );
    } finally {
      spinner.stop();
    }
  });
});

Deno.test("Railway DX: createTrackSpinner cycles through track switch frames", async () => {
  await withTerminalEnv({
    isTerminal: true,
    env: { CI: undefined, NO_COLOR: undefined },
  }, async () => {
    const stream = new MockTerminalStream(true);
    const spinner = createTrackSpinner({ stream, intervalMs: 20 });
    spinner.start("Switching track junctions...");
    try {
      await delay(80);
      const text = stream.text;
      const hasTrackChars = text.includes("━") || text.includes("╸");
      assertEquals(
        hasTrackChars,
        true,
        "Track spinner must cycle through track switch frames",
      );
    } finally {
      spinner.stop();
    }
  });
});

Deno.test("Railway DX: createSpinner accepts custom frames array", async () => {
  await withTerminalEnv({
    isTerminal: true,
    env: { CI: undefined, NO_COLOR: undefined },
  }, async () => {
    const stream = new MockTerminalStream(true);
    const customFrames = ["▲", "►", "▼", "◄"];
    const spinner = createSpinner({
      stream,
      intervalMs: 20,
      frames: customFrames,
    });
    spinner.start("Custom gauge running...");
    try {
      await delay(80);
      const text = stream.text;
      const hasCustom = text.includes("▲") || text.includes("►") ||
        text.includes("▼") || text.includes("◄");
      assertEquals(
        hasCustom,
        true,
        "Spinner must use custom frames when provided",
      );
    } finally {
      spinner.stop();
    }
  });
});
