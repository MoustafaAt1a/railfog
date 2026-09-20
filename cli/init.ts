// spec: contracts/platform.contract.md#PLAT-18 — Project resource hierarchy & naming
// spec: contracts/platform.contract.md#PLAT-19 — Repository structure: CLI scaffolding & project templates
// spec: contracts/platform.contract.md#PLAT-3 — Deployment pipeline static validation of scaffolded projects
// spec: contracts/platform.contract.md#PLAT-6 — Capability injection & deploy-time permission declarations
// spec: contracts/functions.contract.md#FN-1 — Function definition & starter HTTP handler
// spec: contracts/functions.contract.md#FN-2 — Trigger declarations (HTTP, Queue, Schedule)
// spec: contracts/objects.contract.md#OBJ-2 — Object binding permissions in worked-example template
// spec: contracts/queues.contract.md#Q-2 — Queue binding permissions & message handling in worked-example
// spec: contracts/kv.contract.md#KV-2 — KV binding permissions & deduplication in worked-example
// spec: contracts/worked-example.md — Canonical upload pipeline reference implementation
// spec: tasks/milestone-0.5-developer-experience/T-0503-cli-init-scaffold.md

import { basename, join, resolve } from "@std/path";

export interface InitOptions {
  directory: string;
  projectName?: string;
  template?: "minimal" | "worked-example";
  force?: boolean;
}

export interface InitResult {
  targetDir: string;
  filesCreated: string[];
}

// spec: contracts/platform.contract.md#PLAT-18 — Project resource naming syntax
export const PROJECT_NAME_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

/**
 * Scaffolds a new RailFog project in the target directory using the selected template.
 *
 * @spec contracts/platform.contract.md#PLAT-19 — Starter configuration scaffolding
 * @spec contracts/platform.contract.md#PLAT-18 — Resource naming and project hierarchy
 */
export async function runInit(options: InitOptions): Promise<InitResult> {
  const targetDir = resolve(Deno.cwd(), options.directory);

  // Check target directory existence and collision safety
  let exists = false;
  try {
    const stat = await Deno.stat(targetDir);
    if (!stat.isDirectory) {
      throw new Error(
        `Target path "${options.directory}" exists and is not a directory.`,
      );
    }
    exists = true;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      exists = false;
    } else {
      throw err;
    }
  }

  if (exists) {
    let isEmpty = true;
    for await (const _entry of Deno.readDir(targetDir)) {
      isEmpty = false;
      break;
    }

    if (!isEmpty && !options.force) {
      throw new Error(
        `Target directory "${options.directory}" is not empty. Use --force to overwrite.`,
      );
    }
  } else {
    await Deno.mkdir(targetDir, { recursive: true });
  }

  // Derive and validate project name per PLAT-18
  let projectName = "railfog-app";
  if (options.projectName !== undefined) {
    const trimmed = options.projectName.trim();
    if (!PROJECT_NAME_REGEX.test(trimmed)) {
      throw new Error(
        `Invalid project name "${options.projectName}". Project name must start with an alphanumeric character, contain only [a-zA-Z0-9_.-], and cannot contain newlines, quotes, or special characters (PLAT-18).`,
      );
    }
    projectName = trimmed;
  } else {
    const derived = basename(targetDir).trim();
    if (
      derived && derived !== "." && derived !== "/" && derived !== "\\" &&
      PROJECT_NAME_REGEX.test(derived)
    ) {
      projectName = derived;
    }
  }

  const template = options.template ?? "minimal";
  let sdkModUrl = "https://raw.githubusercontent.com/MoustafaAt1a/railfog/main/sdk/typescript/mod.ts";
  if (!import.meta.url.includes("deno-compile") && !import.meta.url.startsWith("deno:")) {
    try {
      const candidate = new URL("../sdk/typescript/mod.ts", import.meta.url);
      if (candidate.protocol === "file:") {
        if (Deno.statSync(candidate).isFile) {
          sdkModUrl = candidate.href;
        }
      } else {
        sdkModUrl = candidate.href;
      }
    } catch {
      // Fallback to GitHub raw URL
    }
  }

  const denoJsonContent = JSON.stringify(
    {
      tasks: {
        dev: "rail dev",
        check: "rail check",
        test: "deno test -A",
        lint: "deno lint",
      },
      imports: {
        "@railfog/sdk": sdkModUrl,
      },
    },
    null,
    2,
  ) + "\n";

  const gitignoreContent = `# RailFog local state and metadata (PLAT-17)
.railfog/

# Local databases
*.sqlite
*.sqlite-journal
*.db

# Build artifacts
dist/
*.tar.gz
`;

  const filesCreated: string[] = [];

  const functionsDir = join(targetDir, "functions");
  await Deno.mkdir(functionsDir, { recursive: true });

  if (template === "worked-example") {
    // spec: contracts/worked-example.md — Canonical worked-example pipeline
    const tomlContent = `name = ${JSON.stringify(projectName)}

[functions.api]
entry = "functions/api.ts"
[functions.api.permissions]
objects = ["app:uploads"]
queues = ["app:jobs"]

[functions.processor]
entry = "functions/processor.ts"
[functions.processor.triggers]
queue = "app:jobs"
[functions.processor.permissions]
objects = ["app:uploads"]
kv = ["app:files"]

[[routes]]
pattern = "/upload"
function = "api"
`;

    // spec: contracts/worked-example.md — API handler with object presigning & queue dispatch
    const apiContent =
      `// spec: docs/contracts/worked-example.md — Canonical upload API handler
// spec: docs/contracts/objects.contract.md#OBJ-2 — Object presigning
// spec: docs/contracts/queues.contract.md#Q-2 — Queue dispatch
import type { RailFogContext } from "@railfog/sdk";

export default async function handler(
  _req: Request,
  ctx: RailFogContext,
): Promise<Response> {
  const key = crypto.randomUUID();
  const { url } = await ctx.objects.presign(key, { method: "PUT" });
  await ctx.queues.send({ key, uploadedAt: Date.now() });
  return Response.json({ uploadUrl: url, key });
}
`;

    // spec: contracts/worked-example.md — Queue consumer with KV deduplication & TTL
    const processorContent =
      `// spec: docs/contracts/worked-example.md — Canonical queue consumer handler
// spec: docs/contracts/queues.contract.md#Q-4 — Idempotency deduplication with mandatory TTL
// spec: docs/contracts/kv.contract.md#KV-2 — KV binding set
// spec: docs/contracts/objects.contract.md#OBJ-2 — Object get
import type { QueueMessage, RailFogContext } from "@railfog/sdk";

export default async function consume(
  message: QueueMessage,
  ctx: RailFogContext,
): Promise<void> {
  const body = message.body as { key?: string } | undefined;
  const key = body?.key;
  if (!key) return;

  const dedupeKey = ["processed", key];
  if (await ctx.kv.get(dedupeKey)) return;

  const stream = await ctx.objects.get(key);
  if (!stream) return;

  await ctx.kv.set(["files", key], { status: "processed" });
  await ctx.kv.set(dedupeKey, true, { ttl: 14 * 24 * 3600 });
}
`;

    const tomlFile = join(targetDir, "railfog.toml");
    await Deno.writeTextFile(tomlFile, tomlContent);
    filesCreated.push(tomlFile);

    const apiFile = join(functionsDir, "api.ts");
    await Deno.writeTextFile(apiFile, apiContent);
    filesCreated.push(apiFile);

    const processorFile = join(functionsDir, "processor.ts");
    await Deno.writeTextFile(processorFile, processorContent);
    filesCreated.push(processorFile);
  } else {
    // Default minimal template
    // spec: contracts/platform.contract.md#PLAT-19, FN-1
    const tomlContent = `name = ${JSON.stringify(projectName)}

[functions.api]
entry = "functions/api.ts"

[functions.api.permissions]
kv = ["app:data"]
network = ["api.example.com"]

[[routes]]
pattern = "/api/*"
function = "api"
`;

    const apiContent =
      `// spec: docs/contracts/functions.contract.md#FN-1 — Default exported fetch handler
import type { RailFogContext } from "@railfog/sdk";

export default async function handler(
  _req: Request,
  _ctx?: RailFogContext,
): Promise<Response> {
  await Promise.resolve();
  return new Response("Hello from RailFog!");
}
`;

    const tomlFile = join(targetDir, "railfog.toml");
    await Deno.writeTextFile(tomlFile, tomlContent);
    filesCreated.push(tomlFile);

    const apiFile = join(functionsDir, "api.ts");
    await Deno.writeTextFile(apiFile, apiContent);
    filesCreated.push(apiFile);
  }

  const denoJsonFile = join(targetDir, "deno.json");
  await Deno.writeTextFile(denoJsonFile, denoJsonContent);
  filesCreated.push(denoJsonFile);

  const gitignoreFile = join(targetDir, ".gitignore");
  await Deno.writeTextFile(gitignoreFile, gitignoreContent);
  filesCreated.push(gitignoreFile);

  return {
    targetDir,
    filesCreated,
  };
}
