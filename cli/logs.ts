/**
 * CLI structured log viewer and streamer implementation (T-0507).
 *
 * Spec references:
 * - PLAT-12: Error model (exhaustive codes, machine-readable errors, safe reporting)
 * - PLAT-13: Observability (structured JSON logs: timestamp, level, project, function, revision, request_id, duration_ms)
 * - PLAT-14: ULID format (128 bits, Crockford Base32 26 characters for request_id)
 * - PLAT-15: Secrets auto-redaction (zero bound secret plaintext leakage in stdout, stderr, logs, or error traces)
 * - PLAT-19: Repository structure and CLI subcommands
 * - Task: tasks/milestone-0.5-developer-experience/T-0507-cli-logs-tail.md
 */

import { isAbsolute, join, resolve } from "@std/path";
import { LocalEncryptedSecretStore } from "../packages/policy/secret-store.ts";
import { SecretRedactor } from "../packages/logging/secret-redactor.ts";

// spec: docs/contracts/platform.contract.md#PLAT-13 — Structured log entry schema
// spec: docs/contracts/platform.contract.md#PLAT-14 — ULID request_id format
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

// spec: tasks/milestone-0.5-developer-experience/T-0507-cli-logs-tail.md#Interface to implement
export interface LogsCliOptions {
  functionName?: string;
  level?: "debug" | "info" | "warn" | "error";
  limit?: number; // Default: 50
  follow?: boolean;
  format?: "pretty" | "json";
  logSource?: string | AsyncIterable<string>;
  projectDir?: string;
  project?: string;
  controlPlaneUrl?: string;
  secrets?: string[];
  secretValues?: string[];
}

// spec: docs/contracts/platform.contract.md#PLAT-13 — Terminal ANSI colors for log levels
const LEVEL_COLORS: Record<string, string> = {
  debug: "\x1b[90m", // Gray
  info: "\x1b[32m", // Green
  warn: "\x1b[33m", // Yellow
  error: "\x1b[31m", // Red
};
const RESET = "\x1b[0m";

// spec: docs/contracts/platform.contract.md#PLAT-13 — Severity order for log level filtering
const LEVEL_SEVERITY: Record<string, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/**
 * Formats a structured log entry into human-readable pretty text or newline-delimited JSON.
 *
 * spec: docs/contracts/platform.contract.md#PLAT-13 — Observability structured logs
 * spec: docs/contracts/platform.contract.md#PLAT-14 — ULID request_id representation
 * spec: tasks/milestone-0.5-developer-experience/T-0507-cli-logs-tail.md#Acceptance criteria AC1, AC2
 */
export function formatLogEntry(
  entry: LogEntry,
  format: "pretty" | "json",
): string {
  // spec: tasks/milestone-0.5-developer-experience/T-0507-cli-logs-tail.md#Acceptance criteria AC2
  // spec: docs/contracts/platform.contract.md#PLAT-13 — Valid single-line JSON adhering strictly to PLAT-13 schema
  if (format === "json") {
    return JSON.stringify(entry);
  }

  // spec: tasks/milestone-0.5-developer-experience/T-0507-cli-logs-tail.md#Acceptance criteria AC1
  // spec: docs/contracts/platform.contract.md#PLAT-13 — Human-readable timestamp, level, function name, duration
  // spec: docs/contracts/platform.contract.md#PLAT-14 — ULID request ID
  const levelUpper = (entry.level ? String(entry.level) : "info").toUpperCase();
  const color = LEVEL_COLORS[entry.level?.toLowerCase() ?? ""] ?? "";
  const levelDisplay = color ? `${color}${levelUpper}${RESET}` : levelUpper;

  const parts: string[] = [];

  if (entry.timestamp) {
    parts.push(String(entry.timestamp));
  }
  parts.push(levelDisplay);
  if (entry.function) {
    parts.push(`[${entry.function}]`);
  }
  if (entry.request_id) {
    parts.push(String(entry.request_id));
  }
  if (typeof entry.duration_ms === "number") {
    parts.push(`(${entry.duration_ms}ms)`);
  }
  if (
    entry.message !== undefined && entry.message !== null &&
    String(entry.message).length > 0
  ) {
    parts.push(String(entry.message));
  }

  // Cleanly preserve extra metadata fields without emitting undefined/null literals
  const standardFields = new Set([
    "timestamp",
    "level",
    "project",
    "function",
    "revision",
    "request_id",
    "duration_ms",
    "message",
  ]);

  const extraKeys = Object.keys(entry).filter((k) => !standardFields.has(k));
  if (extraKeys.length > 0) {
    const extraObj: Record<string, unknown> = {};
    for (const k of extraKeys) {
      if (entry[k] !== undefined && entry[k] !== null) {
        extraObj[k] = entry[k];
      }
    }
    if (Object.keys(extraObj).length > 0) {
      parts.push(JSON.stringify(extraObj));
    }
  }

  return parts.join(" ");
}

// spec: docs/contracts/platform.contract.md#PLAT-15 — Resolve master key for decrypting local project secrets
async function resolveMasterKey(
  projectDir: string,
): Promise<string | undefined> {
  const envKey = Deno.env.get("RAILFOG_MASTER_KEY");
  if (envKey && envKey.trim().length > 0) {
    return envKey.trim();
  }

  const railfogDir = join(projectDir, ".railfog");
  const keyPath = join(railfogDir, "secrets.key");
  try {
    const existing = await Deno.readTextFile(keyPath);
    if (existing.trim().length > 0) {
      return existing.trim();
    }
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) {
      // Ignore reading error
    }
  }
  return undefined;
}

// spec: docs/contracts/platform.contract.md#PLAT-15 — Collect secrets from LocalEncryptedSecretStore for auto-redaction
async function collectProjectSecrets(projectDir: string): Promise<string[]> {
  const secrets: string[] = [];
  try {
    const masterKey = await resolveMasterKey(projectDir);
    if (!masterKey) {
      return secrets;
    }

    // spec: docs/contracts/platform.contract.md#PLAT-15 — Root master key must never leak in logs or errors
    if (masterKey.length >= 4) {
      secrets.push(masterKey);
    }

    const storagePath = join(projectDir, ".railfog", "secrets");
    try {
      const stat = await Deno.stat(storagePath);
      if (!stat.isDirectory) {
        return secrets;
      }
    } catch {
      return secrets;
    }

    const store = new LocalEncryptedSecretStore({ masterKey, storagePath });

    for await (const orgEntry of Deno.readDir(storagePath)) {
      if (!orgEntry.isDirectory) continue;
      const orgPath = join(storagePath, orgEntry.name);
      try {
        for await (const projEntry of Deno.readDir(orgPath)) {
          if (!projEntry.isDirectory) continue;
          try {
            const names = await store.listNames(orgEntry.name, projEntry.name);
            for (const name of names) {
              try {
                const val = await store.get(
                  orgEntry.name,
                  projEntry.name,
                  name,
                );
                if (typeof val === "string" && val.length > 0) {
                  secrets.push(val);
                }
              } catch {
                // Ignore decryption failure for individual secrets
              }
            }
          } catch {
            // Ignore list error
          }
        }
      } catch {
        // Ignore org readDir error
      }
    }
  } catch {
    // Ignore overall collection error
  }
  return secrets;
}

// spec: tasks/milestone-0.5-developer-experience/T-0507-cli-logs-tail.md#Scope — Source iteration
async function* getLineStream(
  options: LogsCliOptions,
  projectDir: string,
): AsyncIterable<string> {
  const source = options.logSource;

  if (source !== undefined && source !== null) {
    // Handle AsyncIterable<string>
    if (
      typeof (source as AsyncIterable<string>)[Symbol.asyncIterator] ===
        "function"
    ) {
      let buffer = "";
      for await (const chunk of source as AsyncIterable<string>) {
        buffer += chunk;
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          yield line;
        }
      }
      if (buffer.length > 0) {
        yield buffer;
      }
      return;
    }

    // Handle raw string or file path
    if (typeof source === "string") {
      let content: string | null = null;
      let isFile = false;
      let matchedFilePath: string | null = null;

      if (
        !source.includes("\n") && !source.includes("\r") &&
        source.trim().length > 0
      ) {
        const candidatePaths: string[] = [source];
        if (options.projectDir && !isAbsolute(source)) {
          candidatePaths.unshift(join(options.projectDir, source));
        }
        for (const p of candidatePaths) {
          try {
            const stat = await Deno.stat(p);
            if (stat.isFile) {
              matchedFilePath = p;
              isFile = true;
              content = await Deno.readTextFile(p);
              break;
            }
          } catch {
            // Not a file, proceed to fallback
          }
        }
      }

      if (content === null) {
        content = source;
      }

      const lines = content.split(/\r?\n/);
      for (const line of lines) {
        yield line;
      }

      // If follow flag is requested on an existing file
      if (options.follow && isFile && matchedFilePath) {
        let fileOffset = 0;
        try {
          const stat = await Deno.stat(matchedFilePath);
          fileOffset = stat.size;
        } catch {
          // File stat failed
        }
        const watcher = Deno.watchFs(matchedFilePath);
        try {
          for await (const event of watcher) {
            if (event.kind === "modify") {
              const file = await Deno.open(matchedFilePath, { read: true });
              try {
                await file.seek(fileOffset, Deno.SeekMode.Start);
                const buf = new Uint8Array(4096);
                let remainder = "";
                while (true) {
                  const bytesRead = await file.read(buf);
                  if (bytesRead === null || bytesRead === 0) break;
                  fileOffset += bytesRead;
                  const chunk = new TextDecoder().decode(
                    buf.subarray(0, bytesRead),
                  );
                  const combined = remainder + chunk;
                  const newLines = combined.split(/\r?\n/);
                  remainder = newLines.pop() ?? "";
                  for (const line of newLines) {
                    yield line;
                  }
                }
              } finally {
                file.close();
              }
            }
          }
        } finally {
          watcher.close();
        }
      }

      return;
    }
  }

  // logSource omitted: check default .railfog/logs.jsonl
  const defaultLogFile = join(projectDir, ".railfog", "logs.jsonl");
  let defaultFileExists = false;
  try {
    const stat = await Deno.stat(defaultLogFile);
    if (stat.isFile) {
      defaultFileExists = true;
      const content = await Deno.readTextFile(defaultLogFile);
      const lines = content.split(/\r?\n/);
      for (const line of lines) {
        yield line;
      }
    }
  } catch {
    // Gracefully handle missing default logs file without error
  }

  if (options.follow && defaultFileExists) {
    let fileOffset = 0;
    try {
      const stat = await Deno.stat(defaultLogFile);
      fileOffset = stat.size;
    } catch {
      // File stat failed
    }
    const watcher = Deno.watchFs(defaultLogFile);
    try {
      for await (const event of watcher) {
        if (event.kind === "modify") {
          const file = await Deno.open(defaultLogFile, { read: true });
          try {
            await file.seek(fileOffset, Deno.SeekMode.Start);
            const buf = new Uint8Array(4096);
            let remainder = "";
            while (true) {
              const bytesRead = await file.read(buf);
              if (bytesRead === null || bytesRead === 0) break;
              fileOffset += bytesRead;
              const chunk = new TextDecoder().decode(
                buf.subarray(0, bytesRead),
              );
              const combined = remainder + chunk;
              const newLines = combined.split(/\r?\n/);
              remainder = newLines.pop() ?? "";
              for (const line of newLines) {
                yield line;
              }
            }
          } finally {
            file.close();
          }
        }
      }
    } finally {
      watcher.close();
    }
    return;
  }

  // Fallback: If no local file exists or if controlPlaneUrl is specified, fetch remote logs
  if (!defaultFileExists || options.controlPlaneUrl) {
    let detectedProject = options.project;
    if (!detectedProject) {
      try {
        const tomlText = await Deno.readTextFile(
          join(projectDir, "railfog.toml"),
        );
        const match = tomlText.match(/name\s*=\s*["']([^"']+)["']/);
        if (match) detectedProject = match[1];
      } catch {
        // ignore
      }
    }
    const targetProject = detectedProject || "default";
    const remoteUrl = options.controlPlaneUrl ||
      Deno.env.get("RAILFOG_CONTROL_URL") ||
      "https://railfog-control-production.up.railway.app";
    const query = new URLSearchParams();
    if (options.limit) query.set("limit", String(options.limit));
    if (options.level) query.set("level", options.level);
    if (options.functionName) query.set("function", options.functionName);

    const logsUrl = `${remoteUrl.replace(/\/+$/, "")}/v1/projects/${
      encodeURIComponent(targetProject)
    }/logs?${query.toString()}`;
    const seenRequestIds = new Set<string>();

    try {
      const res = await fetch(logsUrl);
      if (res.status === 200) {
        const entries = (await res.json()) as Array<Record<string, unknown>>;
        if (Array.isArray(entries)) {
          for (const entry of entries) {
            const reqId = String(entry.request_id ?? "");
            if (reqId) seenRequestIds.add(reqId);
            yield JSON.stringify(entry);
          }
        }
      }
    } catch {
      // Non-fatal
    }

    if (options.follow) {
      while (true) {
        await new Promise((r) => setTimeout(r, 2000));
        try {
          const res = await fetch(logsUrl);
          if (res.status === 200) {
            const entries = (await res.json()) as Array<
              Record<string, unknown>
            >;
            if (Array.isArray(entries)) {
              for (const entry of entries) {
                const reqId = String(entry.request_id ?? "");
                if (reqId && !seenRequestIds.has(reqId)) {
                  seenRequestIds.add(reqId);
                  yield JSON.stringify(entry);
                }
              }
            }
          }
        } catch {
          // ignore
        }
      }
    }
  }
}

/**
 * Runs the rail logs command: streams, filters, redacts, and formats structured runtime logs.
 *
 * spec: docs/contracts/platform.contract.md#PLAT-12 — Error model
 * spec: docs/contracts/platform.contract.md#PLAT-13 — Structured JSON logging
 * spec: docs/contracts/platform.contract.md#PLAT-14 — ULID request identifier
 * spec: docs/contracts/platform.contract.md#PLAT-15 — Zero plaintext secret leakage
 * spec: docs/contracts/platform.contract.md#PLAT-19 — CLI subcommands
 * spec: tasks/milestone-0.5-developer-experience/T-0507-cli-logs-tail.md
 */
export async function runLogs(options: LogsCliOptions = {}): Promise<number> {
  const redactor = new SecretRedactor();
  const secretCandidates: string[] = [];

  // spec: tasks/milestone-0.5-developer-experience/T-0507-cli-logs-tail.md#Acceptance criteria AC3
  // spec: docs/contracts/platform.contract.md#PLAT-15 — Collect secret candidates for auto-redaction
  if (Array.isArray(options.secrets)) {
    for (const s of options.secrets) {
      if (typeof s === "string" && s.length > 0) {
        secretCandidates.push(s);
      }
    }
  }
  if (Array.isArray(options.secretValues)) {
    for (const s of options.secretValues) {
      if (typeof s === "string" && s.length > 0) {
        secretCandidates.push(s);
      }
    }
  }

  const projectDir = resolve(options.projectDir ?? Deno.cwd());

  try {
    const storedSecrets = await collectProjectSecrets(projectDir);
    secretCandidates.push(...storedSecrets);

    const format = options.format ?? "pretty";
    const limit = options.limit !== undefined ? options.limit : 50;
    if (limit <= 0) {
      return 0;
    }

    const minSeverity = options.level !== undefined
      ? (LEVEL_SEVERITY[options.level.toLowerCase()] ?? 0)
      : undefined;

    let emittedCount = 0;

    for await (const rawLine of getLineStream(options, projectDir)) {
      const line = rawLine.trim();
      // Gracefully skip blank lines
      if (line.length === 0) {
        continue;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        // Gracefully skip malformed non-JSON lines without crashing
        continue;
      }

      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        continue;
      }

      const entry = parsed as LogEntry;

      // spec: tasks/milestone-0.5-developer-experience/T-0507-cli-logs-tail.md#Acceptance criteria AC4
      // Filter by function name if specified
      if (
        options.functionName !== undefined && options.functionName.length > 0
      ) {
        if (entry.function !== options.functionName) {
          continue;
        }
      }

      // spec: tasks/milestone-0.5-developer-experience/T-0507-cli-logs-tail.md#Acceptance criteria AC5
      // spec: docs/contracts/platform.contract.md#PLAT-13 — Level filtering: debug (0) < info (1) < warn (2) < error (3)
      if (minSeverity !== undefined) {
        const entryLevelStr = typeof entry.level === "string"
          ? entry.level.toLowerCase()
          : "info";
        const entrySeverity = LEVEL_SEVERITY[entryLevelStr] ?? 1;
        if (entrySeverity < minSeverity) {
          continue;
        }
      }

      // spec: docs/contracts/platform.contract.md#PLAT-15 — Auto-redact secrets from entry object and string output
      // spec: tasks/milestone-0.5-developer-experience/T-0507-cli-logs-tail.md#Acceptance criteria AC3
      const sanitizedEntry = redactor.redactJson(
        entry,
        secretCandidates,
      ) as LogEntry;
      const formatted = formatLogEntry(sanitizedEntry, format);
      const sanitizedOutput = redactor.redact(formatted, secretCandidates);

      console.log(sanitizedOutput);
      emittedCount++;

      if (!options.follow && emittedCount >= limit) {
        break;
      }
    }

    return 0;
  } catch (err) {
    // spec: docs/contracts/platform.contract.md#PLAT-15 — Never leak secret values in errors or stack traces
    // spec: docs/ANTI-SLOP.md#Error handling — Never log or return a secret value in an error
    const rawMsg = err instanceof Error
      ? (err.stack ?? err.message)
      : String(err);
    console.error(redactor.redact(`Error: ${rawMsg}`, secretCandidates));
    return 1;
  }
}
