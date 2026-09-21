/**
 * Pre-Deploy and Health-Check Diagnostics Analyzer
 *
 * Spec references:
 * - PLAT-3: Deployment pipeline (Validation, packaging, health check gate: 3 consecutive 200s within 30s)
 * - PLAT-5: Network policy allowlist & mandatory SSRF IP blocks (metadata, loopback, RFC1918)
 * - PLAT-6: Capability injection & deploy-time permission scoping
 * - PLAT-15: Secrets management (runtime capability-scoped secret access)
 * - OBJ-4: Content addressing (sha256 hex artifact ID & Subresource Integrity string)
 * - FN-5: Resource limits & timeout diagnostics
 */

import { join, relative } from "@std/path";
import {
  computeArtifactId,
  computeIntegrity,
} from "../crypto/content-address.ts";

export interface DiagnosticIssue {
  category: "secrets" | "network" | "permissions" | "integrity" | "healthcheck";
  severity: "error" | "warning" | "info";
  message: string;
  sourceFile?: string;
}

export interface PreDeployReport {
  passed: boolean;
  issues: DiagnosticIssue[];
  artifactDigest?: {
    sha256Hex: string; // sha256:...
    integrity: string; // sha256-...
  };
}

export interface HealthCheckAttempt {
  attempt: number;
  status: number;
  durationMs: number;
  error?: string;
}

export interface HealthCheckDiagnosticReport {
  healthy: boolean;
  attemptsCount: number;
  totalDurationMs: number;
  failureReason?: string;
  diagnosticAdvice: string[];
}

interface SourceFileEntry {
  fullPath: string;
  relPath: string;
  bytes: Uint8Array;
}

// Regex for extracting referenced secrets: ctx.env.get("..."), ctx.env.require("..."), env.get("...")
// Robust against optional chaining (?.), whitespace around dots/parens, quotes (', ", `), and direct env.get/require calls
// spec: contracts/platform.contract.md#PLAT-6, PLAT-15
const SECRET_ACCESS_REGEX =
  /(?:\b(?:ctx|Deno)\s*(?:\?\.|\.)\s*)?\b(?:env|secrets)\s*(?:\?\.|\.)\s*(?:get|require)\s*\(\s*(["'`])([A-Za-z0-9_]+)\1\s*\)/g;

// Regex for scanning outbound URL targets in source code (case-insensitive for scheme)
// spec: contracts/platform.contract.md#PLAT-5
const URL_SCAN_REGEX = /https?:\/\/[^\s"'`<>]+/gi;

// Code file extension matcher for static AST/token analysis
const CODE_FILE_REGEX = /\.(ts|js|mjs|cjs|jsx|tsx)$/i;

/**
 * Normalizes IPv4-mapped IPv6 addresses (e.g. ::ffff:169.254.169.254, ::ffff:a9fe:a9fe)
 * to dotted-decimal IPv4 strings.
 */
function tryConvertIpv4Mapped(host: string): string | null {
  if (!host.startsWith("::ffff:")) return null;
  const rest = host.slice(7);
  if (/^\d+\.\d+\.\d+\.\d+$/.test(rest)) {
    return rest;
  }
  const hexParts = rest.split(":");
  if (hexParts.length === 2) {
    const w1 = parseInt(hexParts[0], 16);
    const w2 = parseInt(hexParts[1], 16);
    if (
      !Number.isNaN(w1) && !Number.isNaN(w2) &&
      w1 >= 0 && w1 <= 0xffff && w2 >= 0 && w2 <= 0xffff
    ) {
      const b1 = (w1 >> 8) & 0xff;
      const b2 = w1 & 0xff;
      const b3 = (w2 >> 8) & 0xff;
      const b4 = w2 & 0xff;
      return `${b1}.${b2}.${b3}.${b4}`;
    }
  }
  return null;
}

/**
 * Checks if a host/IP falls into mandatory blocked SSRF ranges.
 * Spec-anchor: docs/contracts/platform.contract.md#PLAT-5 (Mandatory-block ranges)
 */
export function checkSsrfBlock(
  rawHost: string,
): { blocked: boolean; reason?: string } {
  let host = rawHost.replace(/^\[|\]$/g, "").toLowerCase();

  // Normalize IPv4-mapped IPv6 address to IPv4 dotted-decimal
  const ipv4Mapped = tryConvertIpv4Mapped(host);
  if (ipv4Mapped) {
    host = ipv4Mapped;
  }

  // 1. Loopback addresses per PLAT-5 (127.0.0.0/8, 0.0.0.0/8, ::1/128, localhost)
  if (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "0.0.0.0" ||
    host.startsWith("127.") ||
    host.startsWith("0.") ||
    host === "::1" ||
    host === "::"
  ) {
    return {
      blocked: true,
      reason: "loopback address (127.0.0.0/8, ::1)",
    };
  }

  // 2. Link-local / Cloud metadata per PLAT-5 (169.254.0.0/16, fd00:ec2::/8, fe80::/10)
  if (
    host.startsWith("169.254.") ||
    host.startsWith("fd00:ec2") ||
    host.startsWith("fd00:") ||
    host.startsWith("fe80:")
  ) {
    return {
      blocked: true,
      reason:
        "cloud metadata / link-local address (169.254.0.0/16, fd00:ec2::/8)",
    };
  }

  // 3. RFC1918 private ranges per PLAT-5 (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16)
  if (host.startsWith("10.")) {
    return {
      blocked: true,
      reason: "RFC1918 private range (10.0.0.0/8)",
    };
  }
  if (host.startsWith("192.168.")) {
    return {
      blocked: true,
      reason: "RFC1918 private range (192.168.0.0/16)",
    };
  }
  const match172 = host.match(/^172\.(\d+)\./);
  if (match172) {
    const secondOctet = parseInt(match172[1], 10);
    if (secondOctet >= 16 && secondOctet <= 31) {
      return {
        blocked: true,
        reason: "RFC1918 private range (172.16.0.0/12)",
      };
    }
  }

  // 4. RailFog internal service address / internal domains per PLAT-5
  if (
    host.endsWith(".internal") ||
    host.endsWith(".local") ||
    host.includes("railfog.internal")
  ) {
    return {
      blocked: true,
      reason: "internal service address",
    };
  }

  return { blocked: false };
}

/**
 * Recursively collects source files from project root while excluding ambient / VCS directories.
 * Spec-anchor: docs/contracts/platform.contract.md#PLAT-6 (Packaging isolation & scoping)
 */
async function collectSourceFiles(
  dir: string,
  baseDir: string = dir,
): Promise<SourceFileEntry[]> {
  const entries: SourceFileEntry[] = [];
  const items: Deno.DirEntry[] = [];
  try {
    for await (const entry of Deno.readDir(dir)) {
      items.push(entry);
    }
  } catch {
    return entries;
  }

  // Sort alphabetically by name for deterministic ordering
  items.sort((a, b) => a.name.localeCompare(b.name));

  for (const item of items) {
    // Exclude VCS, package managers, and ambient build artifacts
    if (
      item.name === ".git" ||
      item.name === "node_modules" ||
      item.name === ".railfog" ||
      item.name === "dist" ||
      item.name === "build" ||
      item.name === "coverage"
    ) {
      continue;
    }

    const fullPath = join(dir, item.name);
    if (item.isDirectory) {
      const subEntries = await collectSourceFiles(fullPath, baseDir);
      entries.push(...subEntries);
    } else if (item.isFile) {
      // Exclude ambient secrets, keys, and dotfiles
      if (
        item.name.startsWith(".") ||
        item.name.endsWith(".key") ||
        item.name.endsWith(".pem")
      ) {
        continue;
      }
      if (CODE_FILE_REGEX.test(item.name)) {
        const relPath = relative(baseDir, fullPath).replaceAll("\\", "/");
        const bytes = await Deno.readFile(fullPath);
        entries.push({ fullPath, relPath, bytes });
      }
    }
  }

  return entries;
}

/**
 * Pre-deploy and health-check diagnostics analyzer.
 * Spec-anchor: docs/contracts/platform.contract.md#PLAT-3
 */
export class DeployDiagnosticsAnalyzer {
  /**
   * Statically analyzes project source files against declared manifest permissions and limits.
   * Spec-anchor: docs/contracts/platform.contract.md#PLAT-3 (Validation pipeline)
   * Spec-anchor: docs/contracts/platform.contract.md#PLAT-5 (SSRF scan & allowlist)
   * Spec-anchor: docs/contracts/platform.contract.md#PLAT-6 (Permission scoping)
   * Spec-anchor: docs/contracts/platform.contract.md#PLAT-15 (Secret audit)
   * Spec-anchor: docs/contracts/objects.contract.md#OBJ-4 (Content-addressed integrity)
   */
  async analyzeSource(
    sourceDir: string,
    manifest: unknown,
  ): Promise<PreDeployReport> {
    const issues: DiagnosticIssue[] = [];
    const seenIssues = new Set<string>();

    const declaredSecrets = new Set<string>();
    const declaredNetwork = new Set<string>();

    // Parse declared permissions from manifest (root or function-level)
    const m = manifest as Record<string, unknown> | null | undefined;
    if (m && typeof m === "object") {
      const perms = m.permissions as Record<string, unknown> | undefined;
      if (perms && typeof perms === "object") {
        if (Array.isArray(perms.secrets)) {
          for (const s of perms.secrets) {
            if (typeof s === "string") declaredSecrets.add(s);
          }
        }
        if (Array.isArray(perms.network)) {
          for (const n of perms.network) {
            if (typeof n === "string") declaredNetwork.add(n);
          }
        }
      }

      // Project-level env and secrets tables
      if (m.env && typeof m.env === "object") {
        for (const k of Object.keys(m.env as Record<string, unknown>)) {
          declaredSecrets.add(k);
        }
      }
      if (Array.isArray(m.secrets)) {
        for (const s of m.secrets) {
          if (typeof s === "string") declaredSecrets.add(s);
        }
      }

      // Check function definitions if present
      if (m.functions && typeof m.functions === "object") {
        for (
          const fn of Object.values(m.functions as Record<string, unknown>)
        ) {
          if (fn && typeof fn === "object") {
            const anyFn = fn as Record<string, unknown>;
            const fnPerms = anyFn.permissions as
              | Record<string, unknown>
              | undefined;
            if (fnPerms && typeof fnPerms === "object") {
              if (Array.isArray(fnPerms.secrets)) {
                for (const s of fnPerms.secrets) {
                  if (typeof s === "string") declaredSecrets.add(s);
                }
              }
              if (Array.isArray(fnPerms.network)) {
                for (const n of fnPerms.network) {
                  if (typeof n === "string") declaredNetwork.add(n);
                }
              }
            }
            if (anyFn.env && typeof anyFn.env === "object") {
              for (
                const k of Object.keys(anyFn.env as Record<string, unknown>)
              ) {
                declaredSecrets.add(k);
              }
            }
            if (Array.isArray(anyFn.secrets)) {
              for (const s of anyFn.secrets) {
                if (typeof s === "string") declaredSecrets.add(s);
              }
            }
            if (Array.isArray(anyFn.capabilities)) {
              for (const cap of anyFn.capabilities) {
                if (typeof cap === "string") {
                  const lower = cap.toLowerCase().trim();
                  if (
                    lower.startsWith("env:") || lower.startsWith("secret:") ||
                    lower.startsWith("secrets:")
                  ) {
                    const sec = cap.slice(cap.indexOf(":") + 1).trim();
                    if (sec) declaredSecrets.add(sec);
                  }
                }
              }
            }
          }
        }
      }
    }

    // Collect source files
    const files = await collectSourceFiles(sourceDir);
    // Sort deterministically by relative path
    files.sort((a, b) => a.relPath.localeCompare(b.relPath));

    const textDecoder = new TextDecoder();

    for (const file of files) {
      let content = "";
      try {
        content = textDecoder.decode(file.bytes);
      } catch {
        continue;
      }

      // 0. Static syntax and export validation for function source files (FN-1)
      if (CODE_FILE_REGEX.test(file.relPath)) {
        const stripped = content
          .replace(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, "")
          .replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`/g, "");

        let openBraces = 0;
        for (const char of stripped) {
          if (char === "{") openBraces++;
          else if (char === "}") openBraces--;
        }

        if (openBraces !== 0) {
          issues.push({
            category: "permissions",
            severity: "error",
            message:
              `Syntax Error: Unbalanced curly braces detected (unclosed: ${openBraces}). Ensure all functions and blocks in '${file.relPath}' are properly closed.`,
            sourceFile: file.relPath,
          });
        }

        if (!/\bexport\s+default\b/.test(content)) {
          issues.push({
            category: "permissions",
            severity: "error",
            message:
              `Function module '${file.relPath}' must export a default handler function (FN-1).`,
            sourceFile: file.relPath,
          });
        }
      }

      // 1. Secret Audit (PLAT-6, PLAT-15)
      SECRET_ACCESS_REGEX.lastIndex = 0;
      let secretMatch: RegExpExecArray | null;
      while ((secretMatch = SECRET_ACCESS_REGEX.exec(content)) !== null) {
        const secretName = secretMatch[2];
        if (!declaredSecrets.has(secretName)) {
          const key = `secrets:error:${secretName}:${file.relPath}`;
          if (!seenIssues.has(key)) {
            seenIssues.add(key);
            issues.push({
              category: "secrets",
              severity: "error",
              message:
                `Undeclared secret access: '${secretName}' is accessed via env.get/require but not declared in permissions.secrets (PLAT-6, PLAT-15)`,
              sourceFile: file.relPath,
            });
          }
        }
      }

      // 2. SSRF Network Scan (PLAT-5)
      URL_SCAN_REGEX.lastIndex = 0;
      let urlMatch: RegExpExecArray | null;
      while ((urlMatch = URL_SCAN_REGEX.exec(content)) !== null) {
        let rawUrl = urlMatch[0];
        // Strip trailing punctuation from syntax
        rawUrl = rawUrl.replace(/[),;.]+$/, "");

        let rawHost = "";
        try {
          const parsedUrl = new URL(rawUrl);
          rawHost = parsedUrl.hostname;
        } catch {
          // Fallback parsing for partial / template / non-standard URLs
          let clean = rawUrl.replace(/^[a-z0-9+.-]+:\/\//i, "");
          const pathIdx = clean.search(/[/?#]/);
          if (pathIdx !== -1) {
            clean = clean.slice(0, pathIdx);
          }
          const atIdx = clean.lastIndexOf("@");
          if (atIdx !== -1) {
            clean = clean.slice(atIdx + 1);
          }
          if (clean.startsWith("[") && clean.includes("]")) {
            rawHost = clean.slice(1, clean.indexOf("]"));
          } else {
            const portIdx = clean.indexOf(":");
            rawHost = portIdx !== -1 ? clean.slice(0, portIdx) : clean;
          }
        }

        if (!rawHost) continue;

        const ssrfCheck = checkSsrfBlock(rawHost);
        const cleanHost = rawHost.replace(/^\[|\]$/g, "");

        if (ssrfCheck.blocked) {
          // Mandatory block per PLAT-5 takes precedence regardless of permissions.network
          const key = `network:error:${cleanHost}:${file.relPath}`;
          if (!seenIssues.has(key)) {
            seenIssues.add(key);
            issues.push({
              category: "network",
              severity: "error",
              message:
                `Mandatory SSRF blocked address: '${cleanHost}' (${ssrfCheck.reason}) is forbidden by network security policy (PLAT-5)`,
              sourceFile: file.relPath,
            });
          }
        } else {
          // Public address: verify allowlist in permissions.network
          const isAllowed = declaredNetwork.has("*") ||
            declaredNetwork.has(cleanHost) ||
            declaredNetwork.has(rawHost);

          if (!isAllowed) {
            const key = `network:warning:${cleanHost}:${file.relPath}`;
            if (!seenIssues.has(key)) {
              seenIssues.add(key);
              issues.push({
                category: "network",
                severity: "warning",
                message:
                  `Outbound network host '${cleanHost}' is accessed but not declared in permissions.network (PLAT-5)`,
                sourceFile: file.relPath,
              });
            }
          }
        }
      }
    }

    // 3. Artifact Manifest & Integrity Diagnostic (OBJ-4)
    // Compute deterministic artifact SHA-256 and Subresource Integrity string
    const encoder = new TextEncoder();
    const chunks: Uint8Array[] = [];
    for (const file of files) {
      chunks.push(encoder.encode(file.relPath + "\n"));
      chunks.push(file.bytes);
    }
    const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
    const combinedBytes = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      combinedBytes.set(chunk, offset);
      offset += chunk.length;
    }

    const sha256Hex = await computeArtifactId(combinedBytes);
    const integrity = await computeIntegrity(combinedBytes);

    const passed = issues.every((i) => i.severity !== "error");

    return {
      passed,
      issues,
      artifactDigest: {
        sha256Hex,
        integrity,
      },
    };
  }

  /**
   * Formats health check failure attempts into structured diagnostic reports.
   * Spec-anchor: docs/contracts/platform.contract.md#PLAT-3 (3 consecutive 200s gate)
   * Spec-anchor: docs/contracts/functions.contract.md#FN-5 (Timeout limits)
   */
  formatHealthFailure(
    attempts: HealthCheckAttempt[],
  ): HealthCheckDiagnosticReport {
    const attemptsCount = attempts.length;
    const totalDurationMs = attempts.reduce(
      (sum, a) => sum + (a.durationMs || 0),
      0,
    );

    // PLAT-3 requires 3 consecutive 200 responses within 30s to pass
    const healthy = attemptsCount >= 3 &&
      attempts.every((a) => a.status === 200);

    if (healthy) {
      return {
        healthy: true,
        attemptsCount,
        totalDurationMs,
        failureReason: undefined,
        diagnosticAdvice: [],
      };
    }

    const hasTimeout = attempts.some(
      (a) =>
        a.status === 504 ||
        a.durationMs >= 5000 ||
        (a.error !== undefined && a.error.toLowerCase().includes("timeout")),
    );
    const has500 = attempts.some(
      (a) =>
        a.status === 500 ||
        (a.error !== undefined &&
          a.error.toLowerCase().includes("internal server error")),
    );

    let failureReason: string;
    const diagnosticAdvice: string[] = [];

    if (hasTimeout) {
      // spec: contracts/platform.contract.md#PLAT-3 — Health check timeout
      // spec: contracts/functions.contract.md#FN-5 — Resource limits & timeout diagnostics
      failureReason =
        "Health check probe timed out (HTTP 504 or probe latency exceeded limit per PLAT-3, FN-5)";
      diagnosticAdvice.push(
        "Check function limits.timeout_ms in railfog.toml (default: 30000ms per FN-5).",
      );
      diagnosticAdvice.push(
        "Verify cold start initialization duration does not exceed the probe deadline.",
      );
      diagnosticAdvice.push(
        "Inspect runtime logs using 'rail logs' to identify blocking startup operations.",
      );
    } else if (has500) {
      // spec: contracts/platform.contract.md#PLAT-3 — Health check HTTP 500 internal server error
      // spec: contracts/platform.contract.md#PLAT-15 — Check secrets and environment
      failureReason =
        "Health check failed with HTTP 500 Internal Server Error (PLAT-3)";
      diagnosticAdvice.push(
        "Inspect runtime logs using 'rail logs' to identify unhandled exceptions or crash traces.",
      );
      diagnosticAdvice.push(
        "Verify environment variables and secrets using 'rail secrets' (PLAT-15).",
      );
    } else {
      const last = attempts[attempts.length - 1];
      failureReason = last
        ? `Health check probe failed with status ${last.status}${
          last.error ? `: ${last.error}` : ""
        } (PLAT-3)`
        : "Health check probe failed: no probe attempts recorded (PLAT-3)";
      diagnosticAdvice.push(
        "Inspect runtime logs using 'rail logs' to diagnose function startup failures.",
      );
    }

    return {
      healthy: false,
      attemptsCount,
      totalDurationMs,
      failureReason,
      diagnosticAdvice,
    };
  }
}
