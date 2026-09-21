// spec: docs/contracts/platform.contract.md#PLAT-19 — Repository structure and CLI interactive step indicator
// spec: tasks/milestone-0.8-developer-experience-ux/T-0804-terminal-status-spinners.md#Acceptance criteria

// spec: tasks/milestone-0.8-developer-experience-ux/T-0804-terminal-status-spinners.md#Scope
// Named constants for ANSI escape sequences and spinner frames per docs/ANTI-SLOP.md Rule 3
const CURSOR_HIDE = "\x1b[?25l";
const CURSOR_SHOW = "\x1b[?25h";
const CLEAR_LINE = "\r\x1b[2K";

const COLOR_CYAN = "\x1b[36m";
const COLOR_GREEN = "\x1b[32m";
const COLOR_RED = "\x1b[31m";
const COLOR_YELLOW = "\x1b[33m";
const COLOR_RESET = "\x1b[39m";

const STYLE_BOLD = "\x1b[1m";
const STYLE_DIM = "\x1b[2m";
const STYLE_RESET = "\x1b[22m";

const SYMBOL_SUCCESS = "✔";
const SYMBOL_FAIL = "✖";

// spec: tasks/milestone-0.8-developer-experience-ux/T-0804-terminal-status-spinners.md#Acceptance criteria AC1
// Cycling frames: Braille step indicator characters
export const SPINNER_FRAMES = [
  "⠋",
  "⠙",
  "⠹",
  "⠸",
  "⠼",
  "⠴",
  "⠦",
  "⠧",
  "⠇",
  "⠏",
] as const;

export type SpinnerStyle = "braille" | "wheel" | "signal" | "track";

export const SPINNER_STYLES: Record<SpinnerStyle, readonly string[]> = {
  braille: SPINNER_FRAMES,
  wheel: ["◜", "◠", "◝", "◞", "◡", "◟"],
  signal: ["◐", "◓", "◑", "◒"],
  track: ["╸━  ", " ━╸ ", "  ━╾", "  ━╼", " ━╸ ", "╸━  "],
};

const DEFAULT_INTERVAL_MS = 80;

const textEncoder = new TextEncoder();

export interface WriterSync {
  writeSync(p: Uint8Array): number;
}

/**
 * Determines whether ANSI color and cursor escapes should be enabled, respecting
 * NO_COLOR standard, CI environment flags, and terminal stream capabilities.
 *
 * spec: docs/contracts/platform.contract.md#PLAT-19 — Interactive vs non-interactive terminal step indicator
 * spec: tasks/milestone-0.8-developer-experience-ux/T-0804-terminal-status-spinners.md#Acceptance criteria AC4
 */
export function isColorSupported(stream?: WriterSync): boolean {
  try {
    const noColor = Deno.env.get("NO_COLOR");
    if (noColor !== undefined && noColor !== "") {
      return false;
    }
    const ci = Deno.env.get("CI");
    if (ci !== undefined && ci !== "" && ci !== "0" && ci !== "false") {
      return false;
    }
    if (
      stream &&
      "isTerminal" in stream &&
      typeof (stream as unknown as { isTerminal: () => boolean }).isTerminal ===
        "function"
    ) {
      return (stream as unknown as { isTerminal: () => boolean }).isTerminal();
    }
    if (typeof Deno.stdout.isTerminal === "function") {
      return Deno.stdout.isTerminal();
    }
    return false;
  } catch {
    return false;
  }
}

// spec: tasks/milestone-0.8-developer-experience-ux/T-0804-terminal-status-spinners.md#Scope
// ANSI formatting primitives with automatic detection of NO_COLOR and non-interactive environments
export function bold(text: string): string {
  return isColorSupported() ? `${STYLE_BOLD}${text}${STYLE_RESET}` : text;
}

export function dim(text: string): string {
  return isColorSupported() ? `${STYLE_DIM}${text}${STYLE_RESET}` : text;
}

export function green(text: string): string {
  return isColorSupported() ? `${COLOR_GREEN}${text}${COLOR_RESET}` : text;
}

export function red(text: string): string {
  return isColorSupported() ? `${COLOR_RED}${text}${COLOR_RESET}` : text;
}

export function cyan(text: string): string {
  return isColorSupported() ? `${COLOR_CYAN}${text}${COLOR_RESET}` : text;
}

export function yellow(text: string): string {
  return isColorSupported() ? `${COLOR_YELLOW}${text}${COLOR_RESET}` : text;
}

export interface SpinnerOptions {
  stream?: WriterSync;
  intervalMs?: number;
  style?: SpinnerStyle;
  frames?: readonly string[] | string[];
}

export interface Spinner {
  start(message: string): this;
  setText(message: string): this;
  succeed(message?: string): void;
  fail(message?: string): void;
  stop(): void;
}

/**
 * Interactive terminal step indicator class implementing animated spinner transitions
 * and graceful non-interactive static fallback.
 *
 * spec: docs/contracts/platform.contract.md#PLAT-19 — CLI interactive step indicator
 */
export class TerminalSpinner implements Spinner {
  private stream: WriterSync;
  private intervalMs: number;
  private message = "";
  private frameIndex = 0;
  private timerId: ReturnType<typeof setInterval> | undefined = undefined;
  private running = false;
  private startTime = 0;
  private frames: readonly string[];

  constructor(options?: SpinnerOptions) {
    this.stream = options?.stream ?? Deno.stdout;
    this.intervalMs = options?.intervalMs ?? DEFAULT_INTERVAL_MS;
    if (options?.frames && options.frames.length > 0) {
      this.frames = options.frames;
    } else if (options?.style && SPINNER_STYLES[options.style]) {
      this.frames = SPINNER_STYLES[options.style];
    } else {
      this.frames = SPINNER_STYLES.braille;
    }
  }

  // spec: tasks/milestone-0.8-developer-experience-ux/T-0804-terminal-status-spinners.md#Acceptance criteria AC4
  private get isInteractive(): boolean {
    return isColorSupported(this.stream);
  }

  private write(text: string): void {
    const bytes = textEncoder.encode(text);
    let offset = 0;
    while (offset < bytes.length) {
      const written = this.stream.writeSync(bytes.subarray(offset));
      if (written <= 0) {
        break;
      }
      offset += written;
    }
  }

  /**
   * Starts the spinner animation with the given message.
   *
   * spec: tasks/milestone-0.8-developer-experience-ux/T-0804-terminal-status-spinners.md#Acceptance criteria AC1
   */
  start(message: string): this {
    // Reset any previously running timer cleanly to avoid leaking intervals
    if (this.timerId !== undefined) {
      clearInterval(this.timerId);
      this.timerId = undefined;
    }

    this.message = message;
    this.frameIndex = 0;
    this.running = true;
    this.startTime = Date.now();

    // spec: docs/contracts/platform.contract.md#PLAT-19 — Animated interactive render vs static fallback
    if (this.isInteractive) {
      const frame = this.frames[this.frameIndex];
      this.write(
        `${CURSOR_HIDE}${CLEAR_LINE}${COLOR_CYAN}${frame}${COLOR_RESET} ${this.message}`,
      );

      this.timerId = setInterval(() => {
        this.frameIndex = (this.frameIndex + 1) % this.frames.length;
        const currentFrame = this.frames[this.frameIndex];
        const elapsed = Date.now() - this.startTime;
        const timeBadge = elapsed >= 1000
          ? ` ${dim(`(${(elapsed / 1000).toFixed(1)}s)`)}`
          : "";
        this.write(
          `${CLEAR_LINE}${COLOR_CYAN}${currentFrame}${COLOR_RESET} ${this.message}${timeBadge}`,
        );
      }, this.intervalMs);
    }

    return this;
  }

  /**
   * Dynamically updates the displayed message while running.
   *
   * spec: tasks/milestone-0.8-developer-experience-ux/T-0804-terminal-status-spinners.md#Acceptance criteria AC1
   */
  setText(message: string): this {
    this.message = message;
    if (this.running && this.isInteractive) {
      const currentFrame = this.frames[this.frameIndex];
      this.write(
        `${CLEAR_LINE}${COLOR_CYAN}${currentFrame}${COLOR_RESET} ${this.message}`,
      );
    }
    return this;
  }

  /**
   * Halts the spinner and prints a persistent green checkmark with the success message.
   *
   * spec: tasks/milestone-0.8-developer-experience-ux/T-0804-terminal-status-spinners.md#Acceptance criteria AC2
   */
  succeed(message?: string): void {
    if (!this.running) {
      return;
    }
    if (this.timerId !== undefined) {
      clearInterval(this.timerId);
      this.timerId = undefined;
    }
    this.running = false;

    const displayMsg = message !== undefined ? message : this.message;
    const formattedMsg = displayMsg.length > 0 ? ` ${displayMsg}` : "";

    if (this.isInteractive) {
      this.write(
        `${CLEAR_LINE}${CURSOR_SHOW}${COLOR_GREEN}${SYMBOL_SUCCESS}${COLOR_RESET}${formattedMsg}\n`,
      );
    } else {
      this.write(`${SYMBOL_SUCCESS}${formattedMsg}\n`);
    }
  }

  /**
   * Halts the spinner and prints a persistent red cross with the error message.
   *
   * spec: tasks/milestone-0.8-developer-experience-ux/T-0804-terminal-status-spinners.md#Acceptance criteria AC3
   */
  fail(message?: string): void {
    if (!this.running) {
      return;
    }
    if (this.timerId !== undefined) {
      clearInterval(this.timerId);
      this.timerId = undefined;
    }
    this.running = false;

    const displayMsg = message !== undefined ? message : this.message;
    const formattedMsg = displayMsg.length > 0 ? ` ${displayMsg}` : "";

    if (this.isInteractive) {
      this.write(
        `${CLEAR_LINE}${CURSOR_SHOW}${COLOR_RED}${SYMBOL_FAIL}${COLOR_RESET}${formattedMsg}\n`,
      );
    } else {
      this.write(`${SYMBOL_FAIL}${formattedMsg}\n`);
    }
  }

  /**
   * Halts animation and restores cursor without printing a status indicator.
   *
   * spec: docs/contracts/platform.contract.md#PLAT-19 — Cursor restoration on abort/stop
   */
  stop(): void {
    if (!this.running) {
      return;
    }
    if (this.timerId !== undefined) {
      clearInterval(this.timerId);
      this.timerId = undefined;
    }
    this.running = false;

    if (this.isInteractive) {
      this.write(`${CLEAR_LINE}${CURSOR_SHOW}`);
    }
  }
}

/**
 * Factory creating a new Spinner instance with the specified options.
 *
 * spec: docs/contracts/platform.contract.md#PLAT-19 — CLI interactive step indicator
 */
export function createSpinner(options?: SpinnerOptions): Spinner {
  return new TerminalSpinner(options);
}

/**
 * Creates a locomotive wheel-rotation spinner (◜ ◠ ◝ ◞ ◡ ◟).
 */
export function createWheelSpinner(options?: Omit<SpinnerOptions, "style">): Spinner {
  return new TerminalSpinner({ ...options, style: "wheel" });
}

/**
 * Creates a railway station signal lantern aspect spinner (◐ ◓ ◑ ◒).
 */
export function createSignalSpinner(options?: Omit<SpinnerOptions, "style">): Spinner {
  return new TerminalSpinner({ ...options, style: "signal" });
}

/**
 * Creates a railway track switch / piston stroke spinner.
 */
export function createTrackSpinner(options?: Omit<SpinnerOptions, "style">): Spinner {
  return new TerminalSpinner({ ...options, style: "track" });
}
