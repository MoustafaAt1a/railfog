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
// spec: tasks/milestone-0.8-developer-experience-ux/T-0806-interactive-project-scaffolding.md

import { basename, join, relative, resolve } from "@std/path";
import { type Choice, selectPrompt, type WriterSync } from "./prompt.ts";
import {
  colors,
  getTerminalWidth,
  renderCard,
  renderTrainLogo,
  visibleWidth,
} from "./ui.ts";

export interface InitOptions {
  directory: string;
  projectName?: string;
  template?: "minimal" | "worked-example";
  force?: boolean;
}

export interface InteractiveInitOptions extends Omit<InitOptions, "directory"> {
  directory?: string;
  interactive?: boolean;
  promptReader?: (message: string, defaultValue?: string) => Promise<string>;
  templateSelector?: (
    choices: Choice<"minimal" | "worked-example">[],
  ) => Promise<"minimal" | "worked-example">;
  outputWriter?: WriterSync;
  writer?: WriterSync;
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
  let sdkModUrl =
    "https://raw.githubusercontent.com/MoustafaAt1a/railfog/main/sdk/typescript/mod.ts";
  if (
    !import.meta.url.includes("deno-compile") &&
    !import.meta.url.startsWith("deno:")
  ) {
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

/**
 * Fallback prompt reader reading a single line from standard input.
 */
async function defaultPromptReader(
  message: string,
  defaultValue?: string,
  writer?: WriterSync,
): Promise<string> {
  const out = writer ?? Deno.stdout;
  const promptMsg = defaultValue
    ? `${message} (default: ${defaultValue}): `
    : `${message}: `;
  out.writeSync(new TextEncoder().encode(promptMsg));

  const buf = new Uint8Array(1024);
  const n = await Deno.stdin.read(buf);
  if (n === null || n === 0) {
    return defaultValue ?? "";
  }
  const raw = new TextDecoder().decode(buf.subarray(0, n));
  const line = raw.replace(/[\r\n]+$/, "").trim();
  return line || (defaultValue ?? "");
}

/**
 * Inspects whether the active writer or stdin represents an interactive terminal.
 */
function isTerminalEnvironment(writer?: WriterSync): boolean {
  if (
    writer &&
    "isTerminal" in writer &&
    typeof (writer as unknown as { isTerminal: () => boolean }).isTerminal ===
      "function"
  ) {
    return (writer as unknown as { isTerminal: () => boolean }).isTerminal();
  }
  if (typeof Deno.stdin.isTerminal === "function") {
    return Deno.stdin.isTerminal();
  }
  return false;
}

/**
 * Renders a styled completion summary box displaying created files, configured tasks, and next steps.
 * Incorporates the RailFog train locomotive logo and Unicode box borders in JetBrains style.
 *
 * @spec contracts/platform.contract.md#PLAT-19 — Completion summary box and next steps
 */
export function renderSummaryBox(
  result: InitResult,
  targetDirInput: string,
  writer: WriterSync,
): void {
  const isCwd = resolve(result.targetDir) === resolve(Deno.cwd()) ||
    targetDirInput === "." ||
    targetDirInput === "./" ||
    targetDirInput === ".\\";

  const nextSteps: string[] = [];
  if (!isCwd) {
    nextSteps.push(`cd ${targetDirInput}`);
  }
  nextSteps.push("rail dev");
  nextSteps.push("rail deploy");

  const filesList = result.filesCreated.map((f) => {
    const rel = relative(result.targetDir, f).replace(/\\/g, "/");
    return rel || basename(f);
  });

  const tasksList = [
    "dev   - rail dev",
    "check - rail check",
    "test  - deno test -A",
    "lint  - deno lint",
  ];

  const projectName = basename(resolve(result.targetDir)) || "railfog-app";
  const isWorkedExample = result.filesCreated.some((f) =>
    f.includes("processor.ts")
  );
  const templateName = isWorkedExample ? "Worked Example" : "Minimal Starter";

  const trainLines = renderTrainLogo({
    includeTrack: true,
    colorScheme: "white-gray",
  });
  const logoWidth = 24;

  const rightLines: string[] = [
    "",
    colors.bold(colors.emerald("[+] Project created successfully!")),
    "",
    `${colors.slate("Station:")}     ${colors.bold(projectName)}`,
    `${colors.slate("Template:")}    ${colors.accent(templateName)}`,
    `${colors.slate("Platform:")}    ${colors.dim("Deno LTS • V8 Isolates")}`,
    `${colors.slate("Primitives:")}  ${colors.accent("FN")} ${
      colors.dim("•")
    } ${colors.emerald("KV")} ${colors.dim("•")} ${colors.cyan("OBJ")} ${
      colors.dim("•")
    } ${colors.amber("QUEUES")}`,
    "",
  ];

  const termWidth = getTerminalWidth();
  const headerLines: string[] = [];
  if (termWidth >= 70) {
    const maxHeaderRows = Math.max(trainLines.length, rightLines.length);
    for (let i = 0; i < maxHeaderRows; i++) {
      const left = trainLines[i] ?? " ".repeat(logoWidth);
      const right = rightLines[i] ?? "";
      const leftPad = logoWidth - visibleWidth(left);
      headerLines.push(left + " ".repeat(Math.max(0, leftPad)) + right);
    }
  } else {
    headerLines.push(...trainLines);
    headerLines.push("");
    headerLines.push(...rightLines.filter(Boolean));
  }

  const detailLines: string[] = [
    "",
    "Created files:",
    ...filesList.map((f) => `  * ${f}`),
    "",
    "Configured deno.json tasks:",
    ...tasksList.map((t) => `  * ${t}`),
    "",
    "Next steps:",
    ...nextSteps.map((s) => `  ${s}`),
  ];

  const allContent = [...headerLines, ...detailLines];

  const card = renderCard(
    "RailFog Station Ticket: Project Scaffolded",
    allContent,
    {
      borderColor: colors.emerald,
      borderStyle: "unicode",
      padding: true,
    },
  );

  writer.writeSync(new TextEncoder().encode("\n" + card + "\n\n"));
}

/**
 * Interactively prompts for project settings and scaffolds a new RailFog project.
 * Falls back to non-interactive runInit when arguments are fully specified or environment is non-terminal.
 *
 * @spec contracts/platform.contract.md#PLAT-18 — Project resource naming
 * @spec contracts/platform.contract.md#PLAT-19 — Interactive project scaffolding flow
 */
export async function runInteractiveInit(
  options?: InteractiveInitOptions,
): Promise<InitResult> {
  const writer: WriterSync = options?.outputWriter ?? options?.writer ??
    Deno.stdout;

  // spec: contracts/platform.contract.md#PLAT-19 — Non-interactive fallback for non-terminal or fully-specified args
  const isExplicitNonInteractive = options?.interactive === false;
  const isFullySpecified = options?.directory !== undefined &&
    options?.template !== undefined;
  const isNonTerminal = !isTerminalEnvironment(writer);

  if (
    isExplicitNonInteractive ||
    (options?.interactive === undefined && (isFullySpecified || isNonTerminal))
  ) {
    return await runInit({
      directory: options?.directory ?? ".",
      projectName: options?.projectName,
      template: options?.template ?? "minimal",
      force: options?.force,
    });
  }

  const promptFn = options?.promptReader ??
    ((message: string, defaultValue?: string) =>
      defaultPromptReader(message, defaultValue, writer));

  // 1. Prompt for project directory / path if not provided
  // spec: contracts/platform.contract.md#PLAT-19 — Interactive directory selection
  let targetDirPath = options?.directory;
  if (targetDirPath === undefined) {
    const dirAnswer = await promptFn(
      "Project directory or path (default: .)",
      ".",
    );
    targetDirPath = dirAnswer.trim() || ".";
  }

  // 2. Derive default project name from target directory
  // spec: contracts/platform.contract.md#PLAT-18 — Project name derivation and sanitization
  let defaultProjectName = "railfog-app";
  const resolvedTargetDir = resolve(Deno.cwd(), targetDirPath);
  const derivedBase = basename(resolvedTargetDir).trim();
  if (
    derivedBase &&
    derivedBase !== "." &&
    derivedBase !== "/" &&
    derivedBase !== "\\" &&
    PROJECT_NAME_REGEX.test(derivedBase)
  ) {
    defaultProjectName = derivedBase;
  } else if (
    derivedBase &&
    derivedBase !== "." &&
    derivedBase !== "/" &&
    derivedBase !== "\\"
  ) {
    const sanitized = derivedBase.replace(/[^a-zA-Z0-9_.-]/g, "-").replace(
      /^[^a-zA-Z0-9]+/,
      "",
    );
    if (PROJECT_NAME_REGEX.test(sanitized)) {
      defaultProjectName = sanitized;
    }
  }

  // Prompt for project name if not explicitly provided
  let projectName = options?.projectName;
  if (projectName === undefined) {
    const nameAnswer = await promptFn(
      "Project name",
      defaultProjectName,
    );
    projectName = nameAnswer.trim() || defaultProjectName;
  }

  // Validate project name against regex per PLAT-18
  // spec: contracts/platform.contract.md#PLAT-18 — Project resource naming validation
  if (!PROJECT_NAME_REGEX.test(projectName)) {
    throw new Error(
      `Invalid project name "${projectName}". Project name must start with an alphanumeric character, contain only [a-zA-Z0-9_.-], and cannot contain newlines, quotes, or special characters (PLAT-18).`,
    );
  }

  // 3. Prompt for starter template selection if not provided
  // spec: contracts/platform.contract.md#PLAT-19 — Starter template interactive prompt
  const starterChoices: Choice<"minimal" | "worked-example">[] = [
    {
      label: "Minimal Starter (single HTTP API function)",
      value: "minimal",
      description: "Minimal HTTP endpoint with route mapping",
    },
    {
      label: "Worked Example (file upload pipeline with Objects, Queues, KV)",
      value: "worked-example",
      description:
        "Complete upload pipeline with presigning, queue worker, and KV deduplication",
    },
  ];

  let template: "minimal" | "worked-example";
  if (options?.template) {
    template = options.template;
  } else if (options?.templateSelector) {
    template = await options.templateSelector(starterChoices);
  } else {
    template = await selectPrompt<"minimal" | "worked-example">({
      message: "Select a starter template:",
      choices: starterChoices,
      outputWriter: writer,
    });
  }

  // 4. Scaffold the project files
  // spec: contracts/platform.contract.md#PLAT-19 — Scaffolding file layout
  const result = await runInit({
    directory: targetDirPath,
    projectName,
    template,
    force: options?.force,
  });

  // 5. Render styled completion summary box
  // spec: contracts/platform.contract.md#PLAT-19 — Completion summary box
  renderSummaryBox(result, targetDirPath, writer);

  return result;
}

/**
 * CLI command handler for 'rail init'.
 * Launches interactive project scaffolding when called without positional arguments in an interactive terminal.
 *
 * @spec contracts/platform.contract.md#PLAT-18, PLAT-19
 */
export async function initCommand(
  cwd?: string,
  force = false,
  options?: InteractiveInitOptions,
): Promise<InitResult> {
  const isPositional = cwd !== undefined;
  return await runInteractiveInit({
    ...options,
    directory: cwd,
    force: force || options?.force,
    interactive: isPositional
      ? (options?.interactive ?? false)
      : (options?.interactive ?? true),
  });
}
