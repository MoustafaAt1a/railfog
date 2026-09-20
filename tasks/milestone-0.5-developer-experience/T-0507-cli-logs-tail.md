# T-0507 — CLI Structured Log Viewer and Streamer

Status: Done
Milestone: 0.5 Developer Experience
Depends on: T-0110, T-0306
Blocks: T-0511

## Spec references

`PLAT-12`, `PLAT-13`, `PLAT-14`, `PLAT-15`, `PLAT-19`

## Scope

**In scope**:
- `cli/logs.ts`: Implement `rail logs` command:
  1. Formats structured JSON log events emitted by the runtime (`PLAT-13`).
  2. Supports `--format=pretty` (default for terminal: colored log level, timestamp, function name, ULID `request_id`, duration ms, message) and `--format=json` (newline-delimited JSON per `PLAT-13`).
  3. Filtering flags: `--function=<name>`, `--level=<info|warn|error>`, `--limit=<n>`, `--follow` / `-f` to tail log updates.
  4. Automatic redaction: passes output through `SecretRedactor` (T-0306) to ensure no bound secret values appear in stdout/stderr (`PLAT-15`).
- Wire `rail logs` into `cli/main.ts`.
- `cli/logs_test.ts`: Unit and security tests for log formatting, filtering, and secret auto-redaction.

**Out of scope**:
- Distributed log aggregation backend or third-party log forwarders (out of scope per PLAT-20).
- Modifying runtime log emitters (already implemented in T-0108 and T-0306).

## Interface to implement

```typescript
// cli/logs.ts

export interface LogEntry {
  timestamp: string;
  level: "debug" | "info" | "warn" | "error";
  project: string;
  function: string;
  revision: string;
  request_id: string; // ULID
  duration_ms?: number;
  message?: string;
  [key: string]: unknown;
}

export interface LogsCliOptions {
  functionName?: string;
  level?: "debug" | "info" | "warn" | "error";
  limit?: number; // Default: 50
  follow?: boolean;
  format?: "pretty" | "json";
  logSource?: string | AsyncIterable<string>;
}

export function formatLogEntry(entry: LogEntry, format: "pretty" | "json"): string;
export async function runLogs(options: LogsCliOptions): Promise<number>;
```

## Acceptance criteria (Given/When/Then)

1. Given structured log entries from the runtime per `PLAT-13`, when formatted with `--format=pretty`, then each line displays human-readable timestamp, log level, function name, ULID request ID (`PLAT-14`), and duration.
2. Given structured log entries, when formatted with `--format=json`, then each line outputs valid single-line JSON adhering strictly to `PLAT-13`.
3. Given logs containing a string value identical to an active bound secret, when rendered by `rail logs`, then the secret value is replaced with `[REDACTED]` (`PLAT-15`).
4. Given `--function=api`, when logs contain entries for multiple functions, then entries for other functions are filtered out.
5. Given `--level=error`, when logs are processed, then `info` and `debug` level logs are excluded.

## Tests required

- [x] Unit — `cli/logs_test.ts`: Test pretty formatting, raw JSON formatting, function name filtering, log level filtering, and empty log handling.
- [x] Security — Verify that secret redaction replaces all declared secret values with `[REDACTED]` prior to terminal output (`PLAT-15`).

## Definition of Done

- [x] Implementation matches every cited clause ID exactly (`PLAT-12`, `PLAT-13`, `PLAT-14`, `PLAT-15`, `PLAT-19`)
- [x] Spec-anchor comments present at each RailFog-specific decision point
- [x] Unit tests written first (red), then implementation (green)
- [x] `deno check` run, real output attached, zero errors
- [x] `deno test` run, real output attached, all required tests passing
- [x] `deno lint` run, real output attached, zero warnings
- [x] No item from `docs/ANTI-SLOP.md` violated
- [x] Reviewer pass complete; security-auditor pass complete for PLAT-15
- [x] Nothing outside "In scope" touched

## Verification Evidence

```shell
$ deno check cli/logs.ts cli/main.ts cli/logs_test.ts
(clean output, exit code 0)

$ deno test -A cli/logs_test.ts
running 29 tests from ./cli/logs_test.ts
formatLogEntry --format=pretty outputs human-readable timestamp, log level, function name, ULID request ID, duration ms, and message (AC1, PLAT-13, PLAT-14) ... ok (2ms)
formatLogEntry --format=pretty handles omitted optional fields (duration_ms, message) without undefined/null literals ... ok (515µs)
formatLogEntry --format=pretty formats all standard log levels (debug, info, warn, error) ... ok (390µs)
formatLogEntry --format=json outputs valid single-line JSON adhering strictly to PLAT-13 schema (AC2, PLAT-13) ... ok (848µs)
runLogs filtering: --function=<name> includes matching function entries and excludes others (AC4) ... ok (6ms)
runLogs filtering: includes all functions when functionName filter is omitted ... ok (1ms)
runLogs filtering: --level=error excludes info, warn, and debug entries (AC5) ... ok (1ms)
runLogs filtering: --level=warn includes warn and error, excludes info and debug (AC5) ... ok (1ms)
runLogs filtering: --level=info includes info, warn, and error, excludes debug ... ok (1ms)
runLogs filtering: --limit=<n> limits output to specified count ... ok (3ms)
runLogs filtering: defaults to limit of 50 entries when limit is unspecified ... ok (5ms)
runLogs security: bound secret values are replaced with [REDACTED] in pretty format (AC3, PLAT-15) ... ok (4ms)
runLogs security: bound secret values are replaced with [REDACTED] in json format (AC3, PLAT-13, PLAT-15) ... ok (1ms)
runLogs security: bound secrets loaded from project store (.railfog/secrets) are auto-redacted (PLAT-15) ... ok (128ms)
runLogs security: overlapping secrets are redacted longest-first without partial leak (PLAT-15) ... ok (621µs)
runLogs security: secrets in error stack traces and nested objects are fully redacted (PLAT-15, ANTI-SLOP) ... ok (501µs)
runLogs sources: supports logSource as raw string content (NDJSON) ... ok (440µs)
runLogs sources: supports logSource as AsyncIterable<string> ... ok (353µs)
runLogs sources: supports reading from a file path ... ok (6ms)
runLogs edge cases: empty log source yields exit code 0 without crash ... ok (1ms)
runLogs edge cases: malformed JSON lines are skipped gracefully without crash ... ok (1ms)
runLogs edge cases: handles blank lines and extra whitespace without error ... ok (663µs)
adversarial attack: master key auto-redacted from logs when loaded via RAILFOG_MASTER_KEY (PLAT-15) ... ok (1ms)
adversarial attack: master key auto-redacted when loaded via .railfog/secrets.key file (PLAT-15) ... ok (9ms)
adversarial attack: malformed, corrupted, and tampered secret records do not leak keys/salts or crash (PLAT-15) ... ok (156ms)
adversarial attack: regex metacharacters, punctuation, and injection payloads in secrets (PLAT-15) ... ok (934µs)
adversarial attack: secret injection across all LogEntry standard fields (PLAT-13, PLAT-15) ... ok (2ms)
adversarial attack: complex multi-token overlapping substring collision (PLAT-15) ... ok (963µs)
adversarial attack: stream failure with secret embedded in error message and stack trace (PLAT-15, ANTI-SLOP) ... ok (2ms)

ok | 29 passed | 0 failed (373ms)

$ deno lint cli/
Checked 16 files
(clean output, exit code 0)
```

## Assumptions made

None.
