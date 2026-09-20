// spec: contracts/platform.contract.md#PLAT-18 — Resource hierarchy and top-level name attribute
// spec: contracts/functions.contract.md#FN-1 — Function definition and entrypoint
// spec: contracts/functions.contract.md#FN-2 — Triggers: queue, schedule, http, webhook
// spec: contracts/platform.contract.md#PLAT-6 — Capability injection: permissions scoped at deploy time
// spec: contracts/platform.contract.md#PLAT-15 — Secret access capability scoped
// spec: contracts/functions.contract.md#FN-5 — Resource limits defaults and ceilings
// spec: contracts/platform.contract.md#PLAT-11 — Routing specificity algorithm
// spec: contracts/kv.contract.md#KV-5 — KV consistency tiers: strong and eventual
// spec: contracts/objects.contract.md#OBJ-1 — Durable object storage purpose
// spec: contracts/queues.contract.md#Q-3 — Redelivery model, visibility timeout, max receives, retention, DLQ
// spec: contracts/functions.contract.md#FN-4 — RailFogContext structure
// spec: contracts/kv.contract.md#KV-2 — KV binding API
// spec: contracts/objects.contract.md#OBJ-2 — Objects binding API
// spec: contracts/objects.contract.md#OBJ-3 — Direct client-storage transfer presigning (never bandwidth proxy)
// spec: contracts/queues.contract.md#Q-2 — Queues binding API
// spec: contracts/queues.contract.md#Q-4 — Idempotency with mandatory TTL
// spec: contracts/queues.contract.md#Q-5 — Exponential backoff with decorrelated jitter retry helper
// spec: contracts/platform.contract.md#PLAT-12 — Exhaustive machine-readable error codes
// spec: contracts/platform.contract.md#PLAT-17 — Local/production parity (rail dev)
// spec: contracts/platform.contract.md#PLAT-19 — Repository structure and developer tooling
// spec: contracts/worked-example.md — Canonical end-to-end flow reference implementation
// spec: tasks/milestone-0.5-developer-experience/T-0510-developer-documentation-and-schema.md

import { assert } from "@std/assert";
import { join, resolve, toFileUrl } from "@std/path";
import { parse as parseToml } from "@std/toml";

const repoRoot = resolve(import.meta.dirname ?? ".", "../..");
const configRefPath = join(repoRoot, "docs", "configuration-reference.md");
const sdkGuidePath = join(repoRoot, "docs", "sdk-guide.md");
const sdkReadmePath = join(repoRoot, "sdk", "typescript", "README.md");
const rootReadmePath = join(repoRoot, "README.md");
const sdkModPath = join(repoRoot, "sdk", "typescript", "mod.ts");

async function fileExists(path: string): Promise<boolean> {
  try {
    const stat = await Deno.stat(path);
    return stat.isFile;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      return false;
    }
    throw err;
  }
}

async function readDocFile(path: string, label: string): Promise<string> {
  const exists = await fileExists(path);
  assert(exists, `Expected ${label} to exist at: ${path}`);
  return await Deno.readTextFile(path);
}

function extractCodeSnippets(markdown: string, languages: string[]): string[] {
  const langPattern = languages.join("|");
  const regex = new RegExp(
    `\`\`\`(?:${langPattern})\\b[^\\n]*\\r?\\n([\\s\\S]*?)\`\`\``,
    "g",
  );
  const snippets: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(markdown)) !== null) {
    const code = match[1].trim();
    if (code.length > 0) {
      snippets.push(code);
    }
  }
  return snippets;
}

function prepareSnippetForCheck(snippet: string, sdkModUrl: string): string {
  let prepared = snippet;

  // Rewrite relative SDK imports or package imports to absolute sdkModUrl
  prepared = prepared.replace(
    /from\s+["'](?:\.\.\/)+sdk\/typescript\/mod(?:\.ts)?["']/g,
    `from "${sdkModUrl}"`,
  );
  prepared = prepared.replace(
    /from\s+["']@railfog\/sdk["']/g,
    `from "${sdkModUrl}"`,
  );

  // If the snippet does not contain an import from sdkModUrl,
  // import any referenced SDK types or values.
  if (!prepared.includes(sdkModUrl)) {
    const sdkTypeNames = [
      "RailFogContext",
      "QueueMessage",
      "KVBinding",
      "ObjectBinding",
      "QueueBinding",
      "EnvBinding",
      "FunctionHandler",
      "QueueConsumerHandler",
      "ListOptions",
      "PresignOptions",
      "KVAtomicOperation",
      "AtomicOperation",
      "RailFogErrorCode",
    ];
    const sdkValueNames = [
      "withIdempotency",
      "withRetry",
      "normalizeError",
      "wrapKVBinding",
      "wrapObjectBinding",
      "wrapQueueBinding",
      "RailFogError",
      "ResourceNotFoundError",
      "PermissionDeniedError",
      "ValidationFailedError",
      "RateLimitedError",
      "CallDepthExceededError",
      "TimeoutError",
      "PayloadTooLargeError",
      "ConflictError",
      "UnavailableError",
      "InternalError",
      "DEFAULT_IDEMPOTENCY_TTL_SECONDS",
      "DEFAULT_RETRY_BASE_MS",
      "DEFAULT_RETRY_CAP_MS",
      "DEFAULT_RETRY_MAX_ATTEMPTS",
    ];

    const typesToImport = sdkTypeNames.filter((name) =>
      new RegExp(`\\b${name}\\b`).test(prepared) &&
      !new RegExp(`(?:type|interface|class|enum)\\s+${name}\\b`).test(
        prepared,
      ) &&
      !new RegExp(`\\bimport\\b[^{]*{[^}]*\\b${name}\\b`).test(prepared)
    );
    const valuesToImport = sdkValueNames.filter((name) =>
      new RegExp(`\\b${name}\\b`).test(prepared) &&
      !new RegExp(`(?:const|let|var|function|class)\\s+${name}\\b`).test(
        prepared,
      ) &&
      !new RegExp(`\\bimport\\b[^{]*{[^}]*\\b${name}\\b`).test(prepared)
    );

    let prefix = "";
    if (typesToImport.length > 0) {
      prefix += `import type { ${
        typesToImport.join(", ")
      } } from "${sdkModUrl}";\n`;
    }
    if (valuesToImport.length > 0) {
      prefix += `import { ${
        valuesToImport.join(", ")
      } } from "${sdkModUrl}";\n`;
    }
    prepared = prefix + prepared;
  }

  // Declare ambient variables if used as free variables in expressions/statements
  const ambientDeclarations: string[] = [];
  if (
    /\bctx\b/.test(prepared) &&
    !/\bctx\s*[:=,]|\(\s*[^)]*\bctx\b/.test(prepared)
  ) {
    ambientDeclarations.push("declare const ctx: RailFogContext;");
  }
  if (
    /\bkv\b/.test(prepared) && !/\bkv\s*[:=,]|\(\s*[^)]*\bkv\b/.test(prepared)
  ) {
    ambientDeclarations.push("declare const kv: KVBinding;");
  }
  if (
    /\bobjects\b/.test(prepared) &&
    !/\bobjects\s*[:=,]|\(\s*[^)]*\bobjects\b/.test(prepared)
  ) {
    ambientDeclarations.push("declare const objects: ObjectBinding;");
  }
  if (
    /\bqueues\b/.test(prepared) &&
    !/\bqueues\s*[:=,]|\(\s*[^)]*\bqueues\b/.test(prepared)
  ) {
    ambientDeclarations.push("declare const queues: QueueBinding;");
  }
  if (
    /\bkey\b/.test(prepared) &&
    !/\bkey\s*[:=,]|\(\s*[^)]*\bkey\b/.test(prepared)
  ) {
    ambientDeclarations.push("declare const key: string;");
  }
  if (
    /\bmessage\b/.test(prepared) &&
    !/\bmessage\s*[:=,]|\(\s*[^)]*\bmessage\b/.test(prepared)
  ) {
    ambientDeclarations.push("declare const message: QueueMessage;");
  }

  if (ambientDeclarations.length > 0) {
    prepared = ambientDeclarations.join("\n") + "\n" + prepared;
  }

  return prepared;
}

async function typeCheckSnippet(
  code: string,
  sdkModUrl: string,
  index: number,
  sourceFile: string,
): Promise<void> {
  const prepared = prepareSnippetForCheck(code, sdkModUrl);
  const tempDir = await Deno.makeTempDir({ prefix: "railfog_doc_check_" });
  const tempFilePath = join(tempDir, `snippet_${index}.ts`);
  try {
    await Deno.writeTextFile(tempFilePath, prepared);
    const cmd = new Deno.Command(Deno.execPath(), {
      args: ["check", "--quiet", tempFilePath],
      stdout: "piped",
      stderr: "piped",
    });
    const output = await cmd.output();
    if (!output.success) {
      const stderr = new TextDecoder().decode(output.stderr);
      const stdout = new TextDecoder().decode(output.stdout);
      throw new Error(
        `Type-checking failed for snippet #${
          index + 1
        } from ${sourceFile}:\n\n` +
          `--- Prepared Code ---\n${prepared}\n\n` +
          `--- Compiler Error ---\n${stderr || stdout}`,
      );
    }
  } finally {
    try {
      await Deno.remove(tempDir, { recursive: true });
    } catch {
      // ignore cleanup errors
    }
  }
}

// ============================================================================
// Test 1: docs/configuration-reference.md - existence and spec clause citations
// ============================================================================
Deno.test("docs/configuration-reference.md - existence and required spec citations", async () => {
  const content = await readDocFile(
    configRefPath,
    "docs/configuration-reference.md",
  );

  // Required spec clause citations per T-0510
  const requiredClauses = [
    "PLAT-18", // Resource hierarchy (name attribute)
    "FN-1", // Functions table and entrypoint
    "FN-2", // Triggers (queue, schedule, http, webhook)
    "PLAT-6", // Capability injection / permissions
    "PLAT-15", // Secrets permissions
    "FN-5", // Resource limits, defaults, and maximums
    "PLAT-11", // Route specificity resolution formula
    "KV-5", // KV consistency tiers (strong | eventual)
    "OBJ-1", // Objects purpose and configuration
    "Q-3", // Queues redelivery, visibility timeout, max receives, retention, DLQ
  ];

  for (const clause of requiredClauses) {
    const hasCitation = new RegExp(`\\b${clause}\\b`).test(content);
    assert(
      hasCitation,
      `docs/configuration-reference.md must contain spec citation for '${clause}'`,
    );
  }
});

// ============================================================================
// Test 2: docs/configuration-reference.md - configuration schema, keys, and limits
// ============================================================================
Deno.test("docs/configuration-reference.md - documents all configuration keys, limits, and defaults", async () => {
  const content = await readDocFile(
    configRefPath,
    "docs/configuration-reference.md",
  );

  // 1. Top-level attributes: name (PLAT-18)
  assert(/name\s*=/.test(content), "Must document top-level 'name' attribute");

  // 2. Functions table: [functions.<name>], entry (FN-1)
  assert(
    /\[functions\./.test(content) || /\[functions\]/.test(content),
    "Must document [functions] table",
  );
  assert(/\bentry\b/.test(content), "Must document function 'entry' property");

  // 3. Triggers: [functions.<name>.triggers] — queue, schedule, http, webhook (FN-2)
  assert(/\btriggers\b/.test(content), "Must document triggers section");
  assert(/\bqueue\b/.test(content), "Must document 'queue' trigger");
  assert(/\bschedule\b/.test(content), "Must document 'schedule' trigger");
  assert(/\bhttp\b/.test(content), "Must document 'http' trigger");
  assert(/\bwebhook\b/.test(content), "Must document 'webhook' trigger");

  // 4. Capability permissions: [functions.<name>.permissions] — kv, objects, queues, network, secrets (PLAT-6, PLAT-15)
  assert(/\bpermissions\b/.test(content), "Must document permissions section");
  assert(/\bkv\b/.test(content), "Must document 'kv' permissions");
  assert(/\bobjects\b/.test(content), "Must document 'objects' permissions");
  assert(/\bqueues\b/.test(content), "Must document 'queues' permissions");
  assert(/\bnetwork\b/.test(content), "Must document 'network' permissions");
  assert(/\bsecrets\b/.test(content), "Must document 'secrets' permissions");

  // 5. Resource limits: [functions.<name>.limits] (FN-5)
  assert(/\blimits\b/.test(content), "Must document limits section");
  assert(/\bcpu_ms\b/.test(content), "Must document 'cpu_ms' limit");
  assert(/200/.test(content), "Must document default cpu_ms limit of 200 ms");
  assert(/\btimeout_ms\b/.test(content), "Must document 'timeout_ms' limit");
  assert(
    /30,?000/.test(content),
    "Must document default HTTP timeout_ms of 30,000 ms",
  );
  assert(
    /900,?000/.test(content),
    "Must document default queue/schedule timeout_ms of 900,000 ms",
  );
  assert(/\bmemory_mb\b/.test(content), "Must document 'memory_mb' limit");
  assert(/128/.test(content), "Must document default memory_mb of 128 MB");
  assert(/1024/.test(content), "Must document maximum memory_mb of 1024 MB");
  assert(/\bconcurrency\b/.test(content), "Must document 'concurrency' limit");
  assert(/50/.test(content), "Must document default concurrency limit of 50");
  assert(
    /logs\.bytes_per_invocation|bytes_per_invocation/.test(content),
    "Must document logs.bytes_per_invocation limit",
  );
  assert(
    /64,?000/.test(content),
    "Must document default logs.bytes_per_invocation of 64,000 bytes",
  );

  // 6. Routes table: [[routes]] — pattern, function, specificity resolution formula (PLAT-11)
  assert(/\[\[routes\]\]/.test(content), "Must document [[routes]] table");
  assert(/\bpattern\b/.test(content), "Must document route 'pattern'");
  assert(/\bfunction\b/.test(content), "Must document route 'function'");
  assert(
    /literal_segments/.test(content) || /score/i.test(content),
    "Must document route specificity scoring formula (PLAT-11)",
  );

  // 7. Resources: [kv.<name>] (KV-5), [objects.<name>] (OBJ-1), [queues.<name>] (Q-3)
  assert(
    /\[kv\./.test(content) || /\[kv\]/.test(content),
    "Must document [kv] resource table",
  );
  assert(
    /\bstrong\b/.test(content) && /\beventual\b/.test(content),
    "Must document KV consistency tiers: strong and eventual",
  );
  assert(
    /\[objects\./.test(content) || /\[objects\]/.test(content),
    "Must document [objects] resource table",
  );
  assert(
    /\[queues\./.test(content) || /\[queues\]/.test(content),
    "Must document [queues] resource table",
  );
  assert(
    /\bvisibility_timeout_ms\b/.test(content),
    "Must document queues visibility_timeout_ms (default 30,000)",
  );
  assert(
    /\bmax_receives\b/.test(content),
    "Must document queues max_receives (default 5)",
  );
  assert(
    /\bretention_days\b/.test(content),
    "Must document queues retention_days (default 4, max 14)",
  );
  assert(
    /\bdlq\b/.test(content),
    "Must document queues dead-letter queue (dlq)",
  );
});

// ============================================================================
// Test 3: docs/sdk-guide.md - existence and spec clause citations
// ============================================================================
Deno.test("docs/sdk-guide.md - existence and required spec citations", async () => {
  const content = await readDocFile(sdkGuidePath, "docs/sdk-guide.md");

  // Required spec clause citations per T-0510
  const requiredClauses = [
    "FN-1", // Function handler definition
    "FN-2", // Triggers targeting functions
    "FN-4", // RailFogContext
    "KV-2", // KV binding API and atomic transactions
    "OBJ-2", // Object binding API
    "OBJ-3", // Direct client-storage presigning (never bandwidth proxy)
    "Q-2", // Queues binding API and QueueMessage
    "Q-4", // Idempotency pattern with mandatory TTL
    "PLAT-12", // Exhaustive error model
  ];

  for (const clause of requiredClauses) {
    const hasCitation = new RegExp(`\\b${clause}\\b`).test(content);
    assert(
      hasCitation,
      `docs/sdk-guide.md must contain spec citation for '${clause}'`,
    );
  }
});

// ============================================================================
// Test 4: docs/sdk-guide.md - SDK primitives, reliability, and canonical worked-example
// ============================================================================
Deno.test("docs/sdk-guide.md - SDK primitives, reliability helpers, and canonical worked-example", async () => {
  const content = await readDocFile(sdkGuidePath, "docs/sdk-guide.md");

  // Primitives and context documentation
  assert(/\bRailFogContext\b/.test(content), "Must document RailFogContext");
  assert(
    /\bKVBinding\b/.test(content) || /\bctx\.kv\b/.test(content),
    "Must document KVBinding / ctx.kv",
  );
  assert(
    /\bObjectBinding\b/.test(content) || /\bctx\.objects\b/.test(content),
    "Must document ObjectBinding / ctx.objects",
  );
  assert(
    /\bQueueBinding\b/.test(content) || /\bctx\.queues\b/.test(content),
    "Must document QueueBinding / ctx.queues",
  );
  assert(
    /\bEnvBinding\b/.test(content) || /\bctx\.env\b/.test(content),
    "Must document EnvBinding / ctx.env",
  );

  // Reliability helpers documentation
  assert(
    /\bwithIdempotency\b/.test(content),
    "Must document withIdempotency reliability helper",
  );
  assert(
    /\bwithRetry\b/.test(content),
    "Must document withRetry reliability helper",
  );

  // OBJ-3 direct client-storage transfer emphasis
  assert(/presign/i.test(content), "Must document presigned URLs");
  assert(
    /bandwidth\s*proxy/i.test(content) || /direct/i.test(content),
    "Must explain OBJ-3 direct storage transfer",
  );

  // Canonical worked-example walkthrough matching docs/contracts/worked-example.md
  assert(
    /upload-demo/.test(content),
    "Worked example must use project name 'upload-demo'",
  );
  assert(
    /functions\/api\.ts/.test(content) || /api\.ts/.test(content),
    "Worked example must include api.ts handler",
  );
  assert(
    /functions\/processor\.ts/.test(content) || /processor\.ts/.test(content),
    "Worked example must include processor.ts consumer",
  );
  assert(
    /app:uploads/.test(content),
    "Worked example must reference objects bucket 'app:uploads'",
  );
  assert(
    /app:jobs/.test(content),
    "Worked example must reference queue 'app:jobs'",
  );
  assert(
    /app:files/.test(content),
    "Worked example must reference KV namespace 'app:files'",
  );
  assert(
    /14\s*\*\s*24\s*\*\s*3600|1209600/.test(content),
    "Worked example must use mandatory 14-day retention TTL on dedupe key (Q-4)",
  );
});

// ============================================================================
// Test 5: sdk/typescript/README.md - typed handlers, context, reliability, error codes
// ============================================================================
Deno.test("sdk/typescript/README.md - typed handlers, context, reliability helpers, and PLAT-12 error codes", async () => {
  const content = await readDocFile(sdkReadmePath, "sdk/typescript/README.md");

  // Import and Context
  assert(
    /\bRailFogContext\b/.test(content),
    "Must document importing and using RailFogContext",
  );

  // Typed handlers
  assert(
    /\bFunctionHandler\b/.test(content),
    "Must document typed FunctionHandler",
  );
  assert(
    /\bQueueConsumerHandler\b/.test(content),
    "Must document typed QueueConsumerHandler",
  );

  // Reliability helpers
  assert(
    /\bwithIdempotency\b/.test(content),
    "Must document withIdempotency helper",
  );
  assert(/\bwithRetry\b/.test(content), "Must document withRetry helper");

  // All 10 exhaustive machine-readable error codes from PLAT-12
  const errorCodes = [
    "RESOURCE_NOT_FOUND",
    "PERMISSION_DENIED",
    "VALIDATION_FAILED",
    "RATE_LIMITED",
    "CALL_DEPTH_EXCEEDED",
    "TIMEOUT",
    "PAYLOAD_TOO_LARGE",
    "CONFLICT",
    "UNAVAILABLE",
    "INTERNAL",
  ];

  for (const code of errorCodes) {
    const hasCode = new RegExp(`\\b${code}\\b`).test(content);
    assert(
      hasCode,
      `sdk/typescript/README.md must document PLAT-12 error code '${code}'`,
    );
  }
});

// ============================================================================
// Test 6: root README.md - Milestone 0.5 CLI commands
// ============================================================================
Deno.test("root README.md - documents Milestone 0.5 CLI commands", async () => {
  const content = await readDocFile(rootReadmePath, "README.md");

  // All Milestone 0.5 developer commands
  const cliCommands = [
    "rail init",
    "rail dev",
    "rail check",
    "rail secrets",
    "rail deploy",
    "rail logs",
    "rail rollback",
    "rail export",
    "rail import",
    "rail status",
  ];

  for (const cmd of cliCommands) {
    assert(
      content.includes(cmd),
      `root README.md must document CLI command '${cmd}'`,
    );
  }
});

// ============================================================================
// Test 7: Code snippet type-checking across docs/sdk-guide.md and docs/configuration-reference.md
// ============================================================================
Deno.test("Code snippets in docs/sdk-guide.md and docs/configuration-reference.md pass deno check", async () => {
  // Ensure sdk/typescript/mod.ts exists
  const modExists = await fileExists(sdkModPath);
  assert(modExists, `sdk/typescript/mod.ts must exist at: ${sdkModPath}`);
  const sdkModUrl = toFileUrl(sdkModPath).href;

  // Extract from docs/sdk-guide.md
  const sdkGuideContent = await readDocFile(sdkGuidePath, "docs/sdk-guide.md");
  const sdkSnippets = extractCodeSnippets(sdkGuideContent, [
    "typescript",
    "ts",
  ]);
  assert(
    sdkSnippets.length > 0,
    "docs/sdk-guide.md must contain at least one TypeScript code snippet (```typescript ... ```)",
  );

  for (let i = 0; i < sdkSnippets.length; i++) {
    await typeCheckSnippet(sdkSnippets[i], sdkModUrl, i, "docs/sdk-guide.md");
  }

  // Extract from docs/configuration-reference.md (if any typescript snippets exist)
  const configContent = await readDocFile(
    configRefPath,
    "docs/configuration-reference.md",
  );
  const configSnippets = extractCodeSnippets(configContent, [
    "typescript",
    "ts",
  ]);
  for (let i = 0; i < configSnippets.length; i++) {
    await typeCheckSnippet(
      configSnippets[i],
      sdkModUrl,
      i,
      "docs/configuration-reference.md",
    );
  }
});

// ============================================================================
// Test 8: TOML snippets in docs/configuration-reference.md parse successfully
// ============================================================================
Deno.test("TOML snippets in docs/configuration-reference.md parse successfully", async () => {
  const configContent = await readDocFile(
    configRefPath,
    "docs/configuration-reference.md",
  );
  const tomlSnippets = extractCodeSnippets(configContent, ["toml"]);
  assert(
    tomlSnippets.length > 0,
    "docs/configuration-reference.md must contain at least one TOML code snippet (```toml ... ```)",
  );

  for (let i = 0; i < tomlSnippets.length; i++) {
    const snippet = tomlSnippets[i];
    try {
      parseToml(snippet);
    } catch (err) {
      throw new Error(
        `Failed to parse TOML snippet #${
          i + 1
        } in docs/configuration-reference.md:\n${snippet}\nError: ${err}`,
      );
    }
  }
});
