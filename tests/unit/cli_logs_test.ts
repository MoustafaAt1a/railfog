/**
 * Tests for CLI rail logs command (T-0507).
 *
 * Spec references:
 * - PLAT-12: Error model (exhaustive error codes, machine-readable errors)
 * - PLAT-13: Observability (JSON structured logs: timestamp, level, project, function, revision, request_id, duration_ms)
 * - PLAT-14: ULID format (128 bits, Crockford Base32 26 characters for request_id)
 * - PLAT-15: Secrets auto-redaction (zero bound secret plaintext leakage in stdout, stderr, logs, or error traces)
 * - PLAT-19: Repository structure and CLI subcommands
 * - Task: tasks/milestone-0.5-developer-experience/T-0507-cli-logs-tail.md
 */

import {
  assert,
  assertEquals,
  assertFalse,
  assertMatch,
  assertStringIncludes,
} from "@std/assert";
import { join } from "@std/path";
import { LocalEncryptedSecretStore } from "../../packages/policy/secret-store.ts";
import {
  formatLogEntry,
  type LogEntry,
  type LogsCliOptions,
  runLogs,
} from "../../cli/logs.ts";

// spec: docs/contracts/platform.contract.md#PLAT-15 — Standard replacement marker
const REDACTED_MARKER = "[REDACTED]";

// Ensure test master key is available for secret store decryption
const TEST_MASTER_KEY = "railfog-test-master-key-0123456789abcdef";
Deno.env.set("RAILFOG_MASTER_KEY", TEST_MASTER_KEY);

// =============================================================================
// Test Helpers
// =============================================================================

interface CapturedOutput {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Strips ANSI escape sequences (colors, text formatting) from terminal output.
 */
function stripAnsi(text: string): string {
  // Matches 7-bit and 8-bit ANSI escape codes
  return text.replace(
    // deno-lint-ignore no-control-regex
    /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g,
    "",
  );
}

/**
 * Intercepts console and stream writes during runLogs execution.
 */
async function captureRunLogs(
  options: LogsCliOptions,
): Promise<CapturedOutput> {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const origLog = console.log;
  const origInfo = console.info;
  const origWarn = console.warn;
  const origError = console.error;

  console.log = (...args: unknown[]) => {
    stdoutChunks.push(
      args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(
        " ",
      ),
    );
  };
  console.info = (...args: unknown[]) => {
    stdoutChunks.push(
      args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(
        " ",
      ),
    );
  };
  console.warn = (...args: unknown[]) => {
    stderrChunks.push(
      args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(
        " ",
      ),
    );
  };
  console.error = (...args: unknown[]) => {
    stderrChunks.push(
      args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(
        " ",
      ),
    );
  };

  try {
    const exitCode = await runLogs(options);
    return {
      exitCode,
      stdout: stdoutChunks.join("\n"),
      stderr: stderrChunks.join("\n"),
    };
  } finally {
    console.log = origLog;
    console.info = origInfo;
    console.warn = origWarn;
    console.error = origError;
  }
}

/**
 * Creates a sample LogEntry adhering to PLAT-13 and PLAT-14.
 */
function createSampleLogEntry(overrides: Partial<LogEntry> = {}): LogEntry {
  return {
    timestamp: "2026-09-20T12:34:56.789Z",
    level: "info",
    project: "demo-project",
    function: "api",
    revision: "rev_01J8ZG3M000000000000000001",
    request_id: "req_01J8ZG3M000000000000000002",
    duration_ms: 42,
    message: "GET /v1/status 200 OK",
    ...overrides,
  };
}

/**
 * Converts a list of log entries into a newline-delimited JSON (NDJSON) string.
 */
function toNdjson(entries: LogEntry[]): string {
  return entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
}

/**
 * Creates an AsyncIterable<string> yielding individual log entry JSON lines.
 */
async function* createLogStream(entries: LogEntry[]): AsyncIterable<string> {
  for (const entry of entries) {
    yield JSON.stringify(entry) + "\n";
  }
}

// =============================================================================
// Suite 1: Unit: formatLogEntry
// =============================================================================

Deno.test("formatLogEntry --format=pretty outputs human-readable timestamp, log level, function name, ULID request ID, duration ms, and message (AC1, PLAT-13, PLAT-14)", () => {
  // spec: docs/contracts/platform.contract.md#PLAT-13 — Structured logs with duration, request_id, function
  // spec: docs/contracts/platform.contract.md#PLAT-14 — ULID for request_id
  // spec: tasks/milestone-0.5-developer-experience/T-0507-cli-logs-tail.md#Acceptance criteria AC1
  const entry = createSampleLogEntry({
    timestamp: "2026-09-20T14:22:10.500Z",
    level: "info",
    function: "checkout",
    request_id: "req_01J8ZG3M4N5P6Q7R8S9T0V1W2X",
    duration_ms: 125,
    message: "Processed payment successfully",
  });

  const output = formatLogEntry(entry, "pretty");
  const clean = stripAnsi(output);

  // Timestamp should be present in human-readable form (date/time)
  assert(
    clean.includes("2026-09-20") || clean.includes("14:22:10"),
    `Expected human-readable timestamp in output: ${clean}`,
  );
  // Log level (case-insensitive INFO)
  assertMatch(clean, /\bINFO\b/i, "Expected log level INFO in output");
  // Function name
  assertStringIncludes(clean, "checkout", "Expected function name 'checkout'");
  // ULID request ID per PLAT-14
  assert(
    clean.includes("req_01J8ZG3M4N5P6Q7R8S9T0V1W2X") ||
      clean.includes("01J8ZG3M4N5P6Q7R8S9T0V1W2X"),
    "Expected ULID request ID in output",
  );
  // Duration in ms
  assertMatch(clean, /125\s*ms/, "Expected duration 125ms in output");
  // Message
  assertStringIncludes(
    clean,
    "Processed payment successfully",
    "Expected message in output",
  );
});

Deno.test("formatLogEntry --format=pretty handles omitted optional fields (duration_ms, message) without undefined/null literals", () => {
  // spec: docs/contracts/platform.contract.md#PLAT-13 — Optional fields handling
  const entry: LogEntry = {
    timestamp: "2026-09-20T14:25:00.000Z",
    level: "warn",
    project: "demo-project",
    function: "background_sync",
    revision: "rev_01J8ZG3M000000000000000001",
    request_id: "req_01J8ZG3M000000000000000099",
  };

  const output = formatLogEntry(entry, "pretty");
  const clean = stripAnsi(output);

  assertMatch(clean, /\bWARN\b/i);
  assertStringIncludes(clean, "background_sync");
  assertFalse(
    clean.includes("undefined"),
    "Output must not contain literal 'undefined'",
  );
  assertFalse(
    clean.includes("null"),
    "Output must not contain literal 'null'",
  );
});

Deno.test("formatLogEntry --format=pretty formats all standard log levels (debug, info, warn, error)", () => {
  // spec: docs/contracts/platform.contract.md#PLAT-13 — Log levels
  const levels: Array<LogEntry["level"]> = ["debug", "info", "warn", "error"];

  for (const level of levels) {
    const entry = createSampleLogEntry({
      level,
      message: `Test message for ${level}`,
    });
    const output = formatLogEntry(entry, "pretty");
    const clean = stripAnsi(output);
    assertMatch(
      clean,
      new RegExp(`\\b${level}\\b`, "i"),
      `Expected output to display level '${level}'`,
    );
    assertStringIncludes(clean, `Test message for ${level}`);
  }
});

Deno.test("formatLogEntry --format=json outputs valid single-line JSON adhering strictly to PLAT-13 schema (AC2, PLAT-13)", () => {
  // spec: docs/contracts/platform.contract.md#PLAT-13 — Structured logs are JSON
  // spec: tasks/milestone-0.5-developer-experience/T-0507-cli-logs-tail.md#Acceptance criteria AC2
  const entry = createSampleLogEntry({
    timestamp: "2026-09-20T15:00:00.000Z",
    level: "error",
    project: "billing-service",
    function: "charge",
    revision: "rev_01J8ZG3M000000000000000005",
    request_id: "req_01J8ZG3M000000000000000006",
    duration_ms: 250,
    message: "Payment gateway timeout",
    http_status: 504,
    retry_count: 3,
  });

  const output = formatLogEntry(entry, "json");

  // Must be a single line without newlines
  assertFalse(
    output.includes("\n"),
    "JSON formatted log entry must be a single line",
  );

  // Must parse as valid JSON
  const parsed = JSON.parse(output);

  // Strictly assert PLAT-13 contract fields
  assertEquals(parsed.timestamp, "2026-09-20T15:00:00.000Z");
  assertEquals(parsed.level, "error");
  assertEquals(parsed.project, "billing-service");
  assertEquals(parsed.function, "charge");
  assertEquals(parsed.revision, "rev_01J8ZG3M000000000000000005");
  assertEquals(parsed.request_id, "req_01J8ZG3M000000000000000006");
  assertEquals(parsed.duration_ms, 250);
  assertEquals(parsed.message, "Payment gateway timeout");
  // Extra fields preserved
  assertEquals(parsed.http_status, 504);
  assertEquals(parsed.retry_count, 3);
});

// =============================================================================
// Suite 2: Unit: filtering
// =============================================================================

Deno.test("runLogs filtering: --function=<name> includes matching function entries and excludes others (AC4)", async () => {
  // spec: tasks/milestone-0.5-developer-experience/T-0507-cli-logs-tail.md#Acceptance criteria AC4
  const entries: LogEntry[] = [
    createSampleLogEntry({
      function: "api",
      message: "api endpoint hit",
      request_id: "req_01J8ZG3M000000000000000010",
    }),
    createSampleLogEntry({
      function: "auth",
      message: "auth token generated",
      request_id: "req_01J8ZG3M000000000000000011",
    }),
    createSampleLogEntry({
      function: "worker",
      message: "worker job completed",
      request_id: "req_01J8ZG3M000000000000000012",
    }),
    createSampleLogEntry({
      function: "api",
      message: "api response returned",
      request_id: "req_01J8ZG3M000000000000000013",
    }),
  ];

  const result = await captureRunLogs({
    logSource: toNdjson(entries),
    functionName: "api",
    format: "json",
  });

  assertEquals(result.exitCode, 0);
  assertStringIncludes(result.stdout, "api endpoint hit");
  assertStringIncludes(result.stdout, "api response returned");
  assertFalse(
    result.stdout.includes("auth token generated"),
    "Logs from 'auth' function should be filtered out",
  );
  assertFalse(
    result.stdout.includes("worker job completed"),
    "Logs from 'worker' function should be filtered out",
  );
});

Deno.test("runLogs filtering: includes all functions when functionName filter is omitted", async () => {
  const entries: LogEntry[] = [
    createSampleLogEntry({ function: "api", message: "api call" }),
    createSampleLogEntry({ function: "auth", message: "auth call" }),
    createSampleLogEntry({ function: "billing", message: "billing call" }),
  ];

  const result = await captureRunLogs({
    logSource: toNdjson(entries),
    format: "json",
  });

  assertEquals(result.exitCode, 0);
  assertStringIncludes(result.stdout, "api call");
  assertStringIncludes(result.stdout, "auth call");
  assertStringIncludes(result.stdout, "billing call");
});

Deno.test("runLogs filtering: --level=error excludes info, warn, and debug entries (AC5)", async () => {
  // spec: tasks/milestone-0.5-developer-experience/T-0507-cli-logs-tail.md#Acceptance criteria AC5
  const entries: LogEntry[] = [
    createSampleLogEntry({ level: "debug", message: "debug trace details" }),
    createSampleLogEntry({ level: "info", message: "info user login" }),
    createSampleLogEntry({ level: "warn", message: "warn deprecated api" }),
    createSampleLogEntry({ level: "error", message: "error database failure" }),
  ];

  const result = await captureRunLogs({
    logSource: toNdjson(entries),
    level: "error",
    format: "json",
  });

  assertEquals(result.exitCode, 0);
  assertStringIncludes(result.stdout, "error database failure");
  assertFalse(
    result.stdout.includes("debug trace details"),
    "debug logs must be excluded with --level=error",
  );
  assertFalse(
    result.stdout.includes("info user login"),
    "info logs must be excluded with --level=error",
  );
  assertFalse(
    result.stdout.includes("warn deprecated api"),
    "warn logs must be excluded with --level=error",
  );
});

Deno.test("runLogs filtering: --level=warn includes warn and error, excludes info and debug (AC5)", async () => {
  // spec: tasks/milestone-0.5-developer-experience/T-0507-cli-logs-tail.md#Acceptance criteria AC5
  const entries: LogEntry[] = [
    createSampleLogEntry({ level: "debug", message: "debug level msg" }),
    createSampleLogEntry({ level: "info", message: "info level msg" }),
    createSampleLogEntry({ level: "warn", message: "warn level msg" }),
    createSampleLogEntry({ level: "error", message: "error level msg" }),
  ];

  const result = await captureRunLogs({
    logSource: toNdjson(entries),
    level: "warn",
    format: "json",
  });

  assertEquals(result.exitCode, 0);
  assertStringIncludes(result.stdout, "warn level msg");
  assertStringIncludes(result.stdout, "error level msg");
  assertFalse(
    result.stdout.includes("debug level msg"),
    "debug logs must be excluded with --level=warn",
  );
  assertFalse(
    result.stdout.includes("info level msg"),
    "info logs must be excluded with --level=warn",
  );
});

Deno.test("runLogs filtering: --level=info includes info, warn, and error, excludes debug", async () => {
  const entries: LogEntry[] = [
    createSampleLogEntry({ level: "debug", message: "debug excluded" }),
    createSampleLogEntry({ level: "info", message: "info included" }),
    createSampleLogEntry({ level: "warn", message: "warn included" }),
    createSampleLogEntry({ level: "error", message: "error included" }),
  ];

  const result = await captureRunLogs({
    logSource: toNdjson(entries),
    level: "info",
    format: "json",
  });

  assertEquals(result.exitCode, 0);
  assertStringIncludes(result.stdout, "info included");
  assertStringIncludes(result.stdout, "warn included");
  assertStringIncludes(result.stdout, "error included");
  assertFalse(
    result.stdout.includes("debug excluded"),
    "debug logs must be excluded with --level=info",
  );
});

Deno.test("runLogs filtering: --limit=<n> limits output to specified count", async () => {
  // spec: tasks/milestone-0.5-developer-experience/T-0507-cli-logs-tail.md#Scope
  const entries: LogEntry[] = [];
  for (let i = 1; i <= 20; i++) {
    entries.push(
      createSampleLogEntry({
        message: `Message count ${i}`,
        request_id: `req_01J8ZG3M0000000000000000${String(i).padStart(2, "0")}`,
      }),
    );
  }

  const result = await captureRunLogs({
    logSource: toNdjson(entries),
    limit: 5,
    format: "json",
  });

  assertEquals(result.exitCode, 0);
  const lines = result.stdout.trim().split("\n").filter((l) =>
    l.trim().length > 0
  );
  assertEquals(lines.length, 5, "Expected exactly 5 log lines with limit=5");
});

Deno.test("runLogs filtering: defaults to limit of 50 entries when limit is unspecified", async () => {
  // spec: tasks/milestone-0.5-developer-experience/T-0507-cli-logs-tail.md#Interface to implement (Default: 50)
  const entries: LogEntry[] = [];
  for (let i = 1; i <= 65; i++) {
    entries.push(
      createSampleLogEntry({
        message: `Default limit item ${i}`,
      }),
    );
  }

  const result = await captureRunLogs({
    logSource: toNdjson(entries),
    format: "json",
  });

  assertEquals(result.exitCode, 0);
  const lines = result.stdout.trim().split("\n").filter((l) =>
    l.trim().length > 0
  );
  assertEquals(lines.length, 50, "Expected default limit of 50 log lines");
});

// =============================================================================
// Suite 3: Security: PLAT-15 secret auto-redaction
// =============================================================================

Deno.test("runLogs security: bound secret values are replaced with [REDACTED] in pretty format (AC3, PLAT-15)", async () => {
  // spec: docs/contracts/platform.contract.md#PLAT-15 — Secrets auto-redacted before leaving isolate
  // spec: tasks/milestone-0.5-developer-experience/T-0507-cli-logs-tail.md#Acceptance criteria AC3
  const secretValue = "sk_live_stripe_9876543210";
  const entry = createSampleLogEntry({
    message: `Payment initiated with key ${secretValue} for customer cus_123`,
  });

  const result = await captureRunLogs({
    logSource: toNdjson([entry]),
    format: "pretty",
    secrets: [secretValue],
  });

  assertEquals(result.exitCode, 0);
  assertStringIncludes(result.stdout, REDACTED_MARKER);
  assertFalse(
    result.stdout.includes(secretValue),
    "Secret value must NEVER appear in stdout",
  );
  assertFalse(
    result.stderr.includes(secretValue),
    "Secret value must NEVER appear in stderr",
  );
});

Deno.test("runLogs security: bound secret values are replaced with [REDACTED] in json format (AC3, PLAT-13, PLAT-15)", async () => {
  // spec: docs/contracts/platform.contract.md#PLAT-13 — JSON structured logs auto-redacted per PLAT-15
  // spec: docs/contracts/platform.contract.md#PLAT-15 — Zero plaintext secret leakage
  const secretValue = "ghp_PersonalAccessToken0123456789";
  const entry = createSampleLogEntry({
    message: `Authorization header: Bearer ${secretValue}`,
    auth_token: secretValue,
  });

  const result = await captureRunLogs({
    logSource: toNdjson([entry]),
    format: "json",
    secrets: [secretValue],
  });

  assertEquals(result.exitCode, 0);
  assertStringIncludes(result.stdout, REDACTED_MARKER);
  assertFalse(
    result.stdout.includes(secretValue),
    "Secret value must NEVER appear in stdout",
  );
  assertFalse(
    result.stderr.includes(secretValue),
    "Secret value must NEVER appear in stderr",
  );

  const parsed = JSON.parse(result.stdout.trim());
  assertEquals(
    parsed.message,
    `Authorization header: Bearer ${REDACTED_MARKER}`,
  );
  assertEquals(parsed.auth_token, REDACTED_MARKER);
});

Deno.test("runLogs security: bound secrets loaded from project store (.railfog/secrets) are auto-redacted (PLAT-15)", async () => {
  // spec: docs/contracts/platform.contract.md#PLAT-15 — LocalEncryptedSecretStore integration
  const tempDir = await Deno.makeTempDir({
    prefix: "railfog_logs_secrets_test_",
  });

  try {
    const projectName = "vault-app";
    await Deno.writeTextFile(
      join(tempDir, "railfog.toml"),
      `name = "${projectName}"\n`,
    );

    const storagePath = join(tempDir, ".railfog", "secrets");
    const store = new LocalEncryptedSecretStore({
      masterKey: TEST_MASTER_KEY,
      storagePath,
    });

    const activeSecret = "sk_live_stripe_secret_vault_9999";
    await store.set("default", projectName, "STRIPE_SECRET", activeSecret);

    const entry = createSampleLogEntry({
      message: `Invoking webhook with credential ${activeSecret}`,
    });

    const result = await captureRunLogs({
      logSource: toNdjson([entry]),
      projectDir: tempDir,
      format: "pretty",
    });

    assertEquals(result.exitCode, 0);
    assertStringIncludes(result.stdout, REDACTED_MARKER);
    assertFalse(
      result.stdout.includes(activeSecret),
      "Secret from project store must be redacted and never appear in stdout",
    );
    assertFalse(
      result.stderr.includes(activeSecret),
      "Secret from project store must never appear in stderr",
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("runLogs security: overlapping secrets are redacted longest-first without partial leak (PLAT-15)", async () => {
  // spec: docs/contracts/platform.contract.md#PLAT-15 — Clean redaction prioritizing longest matches
  const longSecret = "sk_live_secret_long_value_enterprise";
  const shortSecret = "sk_live_secret";

  const entry = createSampleLogEntry({
    message: `Using ${longSecret} and also ${shortSecret}`,
  });

  const result = await captureRunLogs({
    logSource: toNdjson([entry]),
    format: "pretty",
    secrets: [shortSecret, longSecret],
  });

  assertEquals(result.exitCode, 0);
  assertFalse(
    result.stdout.includes(longSecret),
    "Long secret must not leak",
  );
  assertFalse(
    result.stdout.includes(shortSecret),
    "Short secret must not leak",
  );
  assertFalse(
    result.stdout.includes("_long_value_enterprise"),
    "Substring of overlapping secret must not leak",
  );
  assertStringIncludes(
    result.stdout,
    `Using ${REDACTED_MARKER} and also ${REDACTED_MARKER}`,
  );
});

Deno.test("runLogs security: secrets in error stack traces and nested objects are fully redacted (PLAT-15, ANTI-SLOP)", async () => {
  // spec: docs/contracts/platform.contract.md#PLAT-15 — Never included in error/trace
  // spec: docs/ANTI-SLOP.md#Error handling — Never log or return a secret value in an error
  const secretKey = "super_secret_db_password_XYZ123";
  const entry = createSampleLogEntry({
    level: "error",
    message: "Connection failed",
    error: {
      name: "DatabaseError",
      stack:
        `Error: failed to connect to postgres://user:${secretKey}@localhost:5432/db\n    at connect (/app/db.ts:42:10)`,
      details: {
        raw_uri: `postgres://user:${secretKey}@localhost:5432/db`,
      },
    },
  });

  const result = await captureRunLogs({
    logSource: toNdjson([entry]),
    format: "json",
    secrets: [secretKey],
  });

  assertEquals(result.exitCode, 0);
  assertFalse(
    result.stdout.includes(secretKey),
    "Database password must not appear in stdout error trace",
  );
  assertFalse(
    result.stderr.includes(secretKey),
    "Database password must not appear in stderr error trace",
  );

  const parsed = JSON.parse(result.stdout.trim());
  assertStringIncludes(parsed.error.stack, REDACTED_MARKER);
  assertStringIncludes(parsed.error.details.raw_uri, REDACTED_MARKER);
});

// =============================================================================
// Suite 4: Log sources & Edge cases
// =============================================================================

Deno.test("runLogs sources: supports logSource as raw string content (NDJSON)", async () => {
  const entries = [
    createSampleLogEntry({ message: "raw string entry 1" }),
    createSampleLogEntry({ message: "raw string entry 2" }),
  ];

  const result = await captureRunLogs({
    logSource: toNdjson(entries),
    format: "json",
  });

  assertEquals(result.exitCode, 0);
  assertStringIncludes(result.stdout, "raw string entry 1");
  assertStringIncludes(result.stdout, "raw string entry 2");
});

Deno.test("runLogs sources: supports logSource as AsyncIterable<string>", async () => {
  const entries = [
    createSampleLogEntry({ message: "streamed entry alpha" }),
    createSampleLogEntry({ message: "streamed entry beta" }),
  ];

  const result = await captureRunLogs({
    logSource: createLogStream(entries),
    format: "json",
  });

  assertEquals(result.exitCode, 0);
  assertStringIncludes(result.stdout, "streamed entry alpha");
  assertStringIncludes(result.stdout, "streamed entry beta");
});

Deno.test("runLogs sources: supports reading from a file path", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "railfog_logs_file_test_" });
  const logFilePath = join(tempDir, "application.log");

  try {
    const entries = [
      createSampleLogEntry({ message: "file entry 101" }),
      createSampleLogEntry({ message: "file entry 102" }),
    ];
    await Deno.writeTextFile(logFilePath, toNdjson(entries));

    const result = await captureRunLogs({
      logSource: logFilePath,
      format: "json",
    });

    assertEquals(result.exitCode, 0);
    assertStringIncludes(result.stdout, "file entry 101");
    assertStringIncludes(result.stdout, "file entry 102");
  } finally {
    await Deno.remove(tempDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("runLogs edge cases: empty log source yields exit code 0 without crash", async () => {
  const result = await captureRunLogs({
    logSource: "",
    format: "pretty",
  });

  assertEquals(result.exitCode, 0);
  assertEquals(result.stdout.trim(), "");
});

Deno.test("runLogs edge cases: malformed JSON lines are skipped gracefully without crash", async () => {
  // Stream containing non-JSON lines and truncated JSON chunks
  const validEntry1 = createSampleLogEntry({ message: "valid before error" });
  const validEntry2 = createSampleLogEntry({ message: "valid after error" });

  const mixedContent = [
    "not a json line at all",
    JSON.stringify(validEntry1),
    "{broken json: true,",
    "   ",
    JSON.stringify(validEntry2),
    "",
  ].join("\n");

  const result = await captureRunLogs({
    logSource: mixedContent,
    format: "json",
  });

  assertEquals(result.exitCode, 0);
  assertStringIncludes(result.stdout, "valid before error");
  assertStringIncludes(result.stdout, "valid after error");
  assertFalse(
    result.stdout.includes("not a json line"),
    "Malformed non-JSON lines should not be output as formatted entries",
  );
});

Deno.test("runLogs edge cases: handles blank lines and extra whitespace without error", async () => {
  const validEntry = createSampleLogEntry({ message: "solitary valid line" });
  const content = "\n\n   \n" + JSON.stringify(validEntry) + "\n\n   \n\n";

  const result = await captureRunLogs({
    logSource: content,
    format: "pretty",
  });

  assertEquals(result.exitCode, 0);
  assertStringIncludes(result.stdout, "solitary valid line");
});

// =============================================================================
// Suite 5: Adversarial Security Attacks (PLAT-15, PLAT-13, ANTI-SLOP)
// =============================================================================

Deno.test("adversarial attack: master key auto-redacted from logs when loaded via RAILFOG_MASTER_KEY (PLAT-15)", async () => {
  const customMasterKey = "custom_master_key_adversarial_vector_998877";
  const origKey = Deno.env.get("RAILFOG_MASTER_KEY");
  Deno.env.set("RAILFOG_MASTER_KEY", customMasterKey);

  try {
    const entry = createSampleLogEntry({
      message: `Critical runtime boot with master key: ${customMasterKey}`,
      env_dump: {
        RAILFOG_MASTER_KEY: customMasterKey,
      },
    });

    const result = await captureRunLogs({
      logSource: toNdjson([entry]),
      format: "pretty",
    });

    assertEquals(result.exitCode, 0);
    assertFalse(
      result.stdout.includes(customMasterKey),
      "Master key must NEVER appear in stdout under any circumstances",
    );
    assertFalse(
      result.stderr.includes(customMasterKey),
      "Master key must NEVER appear in stderr",
    );
    assertStringIncludes(result.stdout, REDACTED_MARKER);
  } finally {
    if (origKey !== undefined) {
      Deno.env.set("RAILFOG_MASTER_KEY", origKey);
    } else {
      Deno.env.delete("RAILFOG_MASTER_KEY");
    }
  }
});

Deno.test("adversarial attack: master key auto-redacted when loaded via .railfog/secrets.key file (PLAT-15)", async () => {
  const tempDir = await Deno.makeTempDir({
    prefix: "railfog_masterkey_file_test_",
  });
  const fileMasterKey = "file_master_key_super_secret_0123456789";
  const origKey = Deno.env.get("RAILFOG_MASTER_KEY");
  Deno.env.delete("RAILFOG_MASTER_KEY");

  try {
    const railfogDir = join(tempDir, ".railfog");
    await Deno.mkdir(railfogDir, { recursive: true });
    await Deno.writeTextFile(join(railfogDir, "secrets.key"), fileMasterKey);

    const entry = createSampleLogEntry({
      message: `Service loaded root credentials: ${fileMasterKey}`,
    });

    const result = await captureRunLogs({
      logSource: toNdjson([entry]),
      projectDir: tempDir,
      format: "json",
    });

    assertEquals(result.exitCode, 0);
    assertFalse(
      result.stdout.includes(fileMasterKey),
      "File-based master key must NEVER appear in stdout",
    );
    assertFalse(
      result.stderr.includes(fileMasterKey),
      "File-based master key must NEVER appear in stderr",
    );
    assertStringIncludes(result.stdout, REDACTED_MARKER);
  } finally {
    if (origKey !== undefined) {
      Deno.env.set("RAILFOG_MASTER_KEY", origKey);
    }
    await Deno.remove(tempDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("adversarial attack: malformed, corrupted, and tampered secret records do not leak keys/salts or crash (PLAT-15)", async () => {
  const tempDir = await Deno.makeTempDir({
    prefix: "railfog_corrupt_secrets_test_",
  });
  const masterKey = "corrupt-test-master-key-0123456789";
  const origKey = Deno.env.get("RAILFOG_MASTER_KEY");
  Deno.env.set("RAILFOG_MASTER_KEY", masterKey);

  try {
    const storagePath = join(tempDir, ".railfog", "secrets", "default", "app");
    await Deno.mkdir(storagePath, { recursive: true });

    // 1. Truncated record (< 48 bytes)
    await Deno.writeFile(
      join(storagePath, "truncated.enc"),
      new Uint8Array([1, 2, 3, 4, 5]),
    );

    // 2. Corrupted magic header
    const badMagic = new Uint8Array(60);
    badMagic.set([0x58, 0x58, 0x58, 0x58], 0); // "XXXX"
    await Deno.writeFile(join(storagePath, "badmagic.enc"), badMagic);

    // 3. Corrupted ciphertext with valid RFS1 header
    const badCipher = new Uint8Array(60);
    badCipher.set([0x52, 0x46, 0x53, 0x31], 0); // "RFS1"
    await Deno.writeFile(join(storagePath, "badcipher.enc"), badCipher);

    // 4. Loose non-enc file
    await Deno.writeTextFile(
      join(storagePath, "notes.txt"),
      "some loose file notes",
    );

    // 5. Valid secret written via store
    const store = new LocalEncryptedSecretStore({
      masterKey,
      storagePath: join(tempDir, ".railfog", "secrets"),
    });
    const validSecret = "valid_surviving_secret_token_123456";
    await store.set("default", "app", "VALID_KEY", validSecret);

    const entry = createSampleLogEntry({
      message:
        `Payload with valid secret ${validSecret} alongside corrupted records`,
    });

    const result = await captureRunLogs({
      logSource: toNdjson([entry]),
      projectDir: tempDir,
      format: "pretty",
    });

    assertEquals(result.exitCode, 0);
    assertFalse(
      result.stdout.includes(validSecret),
      "Valid secret must be redacted even when neighboring records are corrupted",
    );
    assertFalse(result.stdout.includes("RFS1"), "Magic bytes must not leak");
    assertFalse(
      result.stderr.includes(masterKey),
      "Master key must not leak to stderr",
    );
    assertStringIncludes(result.stdout, REDACTED_MARKER);
  } finally {
    if (origKey !== undefined) {
      Deno.env.set("RAILFOG_MASTER_KEY", origKey);
    }
    await Deno.remove(tempDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("adversarial attack: regex metacharacters, punctuation, and injection payloads in secrets (PLAT-15)", async () => {
  const metacharSecret = "Bearer $eCrEt*+?^${}[]|/token";
  const injectionSecret = "'; DROP TABLE secrets; -- <script>alert(1)</script>";
  const escapedSecret = "p@ss\"word\\with'quotes\tand\nnewlines";

  const entry = createSampleLogEntry({
    message:
      `Attempting auth with ${metacharSecret} and injection ${injectionSecret}`,
    credentials: {
      raw: escapedSecret,
    },
  });

  const result = await captureRunLogs({
    logSource: toNdjson([entry]),
    format: "json",
    secrets: [metacharSecret, injectionSecret, escapedSecret],
  });

  assertEquals(result.exitCode, 0);
  assertFalse(result.stdout.includes(metacharSecret));
  assertFalse(result.stdout.includes(injectionSecret));
  assertFalse(result.stdout.includes('p@ss"word'));
  assertFalse(result.stdout.includes("<script>alert(1)</script>"));
  assertFalse(result.stdout.includes("DROP TABLE"));
  assertStringIncludes(result.stdout, REDACTED_MARKER);
});

Deno.test("adversarial attack: secret injection across all LogEntry standard fields (PLAT-13, PLAT-15)", async () => {
  const secFn = "secret_function_name_99";
  const secProj = "secret_project_enterprise_88";
  const secRev = "secret_rev_01J8ZG3M_77";
  const secReqId = "secret_req_ulid_01J8ZG3M_66";
  const secTime = "2026-09-20Tsecret_timestamp_55";
  const secMsg = "secret_message_body_44";
  const secKey = "secret_meta_key_33";
  const secVal = "secret_meta_value_22";

  const entry: LogEntry = {
    timestamp: secTime,
    level: "warn",
    project: secProj,
    function: secFn,
    revision: secRev,
    request_id: secReqId,
    duration_ms: 50,
    message: secMsg,
    [secKey]: secVal,
  };

  const secrets = [
    secFn,
    secProj,
    secRev,
    secReqId,
    secTime,
    secMsg,
    secKey,
    secVal,
  ];

  // Test both pretty and json
  for (const fmt of ["pretty", "json"] as const) {
    const result = await captureRunLogs({
      logSource: toNdjson([entry]),
      format: fmt,
      secrets,
    });

    assertEquals(result.exitCode, 0);
    for (const s of secrets) {
      assertFalse(
        result.stdout.includes(s),
        `Secret '${s}' must not appear in ${fmt} output`,
      );
      assertFalse(
        result.stderr.includes(s),
        `Secret '${s}' must not appear in ${fmt} stderr`,
      );
    }
  }
});

Deno.test("adversarial attack: complex multi-token overlapping substring collision (PLAT-15)", async () => {
  const s1 = "TOKEN_SUPER_ENTERPRISE_SECRET_KEY_v2";
  const s2 = "ENTERPRISE_SECRET_KEY_v2";
  const s3 = "SECRET_KEY_v2";
  const s4 = "SECRET_KEY";

  const entry = createSampleLogEntry({
    message:
      `Header: Bearer ${s1} and fallback ${s2}, legacy ${s3}, minimal ${s4}`,
  });

  // Pass them in scrambled order
  const result = await captureRunLogs({
    logSource: toNdjson([entry]),
    format: "pretty",
    secrets: [s4, s2, s1, s3],
  });

  assertEquals(result.exitCode, 0);
  assertFalse(result.stdout.includes(s1));
  assertFalse(result.stdout.includes(s2));
  assertFalse(result.stdout.includes(s3));
  assertFalse(result.stdout.includes(s4));
  // Check that partial tokens didn't leak
  assertFalse(result.stdout.includes("TOKEN_SUPER_"));
  assertFalse(result.stdout.includes("_v2"));
  assertFalse(result.stdout.includes("ENTERPRISE_"));
});

Deno.test("adversarial attack: stream failure with secret embedded in error message and stack trace (PLAT-15, ANTI-SLOP)", async () => {
  const secretInError = "super_confidential_db_token_in_stack_trace_98765";

  async function* failingStream(): AsyncIterable<string> {
    yield JSON.stringify(createSampleLogEntry({ message: "before failure" })) +
      "\n";
    throw new Error(
      `Database connection failed: postgres://user:${secretInError}@10.0.0.1:5432/app`,
    );
  }

  const result = await captureRunLogs({
    logSource: failingStream(),
    format: "pretty",
    secrets: [secretInError],
  });

  assertEquals(result.exitCode, 1);
  assertFalse(
    result.stdout.includes(secretInError),
    "Secret must not appear in stdout on error",
  );
  assertFalse(
    result.stderr.includes(secretInError),
    "Secret must not appear in stderr error message or stack trace",
  );
  assertStringIncludes(result.stderr, REDACTED_MARKER);
});

Deno.test("runLogs: --trace / --request-id filters logs and displays waterfall trace card", async () => {
  const targetTrace = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
  const otherTrace = "01ARZ3NDEKTSV4RRFFQ69G5FA9";
  const entries = [
    createSampleLogEntry({
      message: "Processing route /api/users",
      request_id: targetTrace,
      level: "info",
    }),
    createSampleLogEntry({
      message: "Unrelated background task",
      request_id: otherTrace,
      level: "info",
    }),
    createSampleLogEntry({
      message: "Database query finished",
      request_id: targetTrace,
      level: "info",
    }),
  ];

  const result = await captureRunLogs({
    logSource: toNdjson(entries),
    format: "pretty",
    trace: targetTrace,
  });

  assertEquals(result.exitCode, 0);
  assertStringIncludes(result.stdout, "Processing route /api/users");
  assertStringIncludes(result.stdout, "Database query finished");
  assertFalse(result.stdout.includes("Unrelated background task"));
  assertStringIncludes(result.stdout, "ULID Request Trace Waterfall");
  assertStringIncludes(result.stdout, targetTrace);
});
