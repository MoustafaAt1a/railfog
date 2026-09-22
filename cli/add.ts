// spec: contracts/platform.contract.md#PLAT-19 — Repository structure & dependency management
// spec: tasks/milestone-0.8-developer-experience-ux/T-0811-project-dependency-add.md

import { join, resolve } from "@std/path";

// spec: contracts/platform.contract.md#PLAT-19 — Canonical SDK module entrypoint
export const CANONICAL_SDK_URL =
  "https://raw.githubusercontent.com/MoustafaAt1a/railfog/main/sdk/typescript/mod.ts";

export const SUPPORTED_PACKAGES = ["sdk", "@railfog/sdk"] as const;

export interface AddOptions {
  packageOrPrimitive: string; // e.g. "sdk"
  cwd?: string;
}

export interface AddResult {
  ok: boolean;
  targetFile: string;
  addedImport: string;
  createdNewFile: boolean;
}

/**
 * Adds dependencies or primitives to the project's deno.json configuration.
 *
 * @spec contracts/platform.contract.md#PLAT-19 — Project dependency management
 * @spec tasks/milestone-0.8-developer-experience-ux/T-0811-project-dependency-add.md
 */
export async function runAdd(options: AddOptions): Promise<AddResult> {
  const rawPkg = options.packageOrPrimitive;
  const trimmedPkg = typeof rawPkg === "string" ? rawPkg.trim() : "";

  // spec: tasks/milestone-0.8-developer-experience-ux/T-0811-project-dependency-add.md#AC4 — Reject unknown packages
  if (trimmedPkg !== "sdk" && trimmedPkg !== "@railfog/sdk") {
    throw new Error(
      `Unsupported package or primitive "${rawPkg}". Supported additions: sdk (or @railfog/sdk).`,
    );
  }

  // spec: contracts/platform.contract.md#PLAT-19 — Discovers deno.json in options.cwd or current dir
  const cwd = resolve(options.cwd ?? Deno.cwd());
  const denoJsonPath = join(cwd, "deno.json");

  let exists = false;
  let rawContent = "";
  try {
    rawContent = await Deno.readTextFile(denoJsonPath);
    exists = true;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      exists = false;
    } else {
      throw err;
    }
  }

  if (!exists) {
    // spec: contracts/platform.contract.md#PLAT-19 — Scaffolds minimal deno.json with standard tasks
    // spec: tasks/milestone-0.8-developer-experience-ux/T-0811-project-dependency-add.md#AC2
    const initialConfig = {
      tasks: {
        dev: "rail dev",
        check: "rail check",
        test: "deno test -A",
      },
      imports: {
        "@railfog/sdk": CANONICAL_SDK_URL,
      },
    };

    await Deno.mkdir(cwd, { recursive: true });
    await Deno.writeTextFile(
      denoJsonPath,
      JSON.stringify(initialConfig, null, 2) + "\n",
    );

    return {
      ok: true,
      targetFile: denoJsonPath,
      addedImport: "@railfog/sdk",
      createdNewFile: true,
    };
  }

  // spec: tasks/milestone-0.8-developer-experience-ux/T-0811-project-dependency-add.md#AC1 — Non-destructive editing
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(rawContent);
  } catch (err) {
    throw new Error(
      `Failed to parse "${denoJsonPath}": ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `Invalid deno.json at "${denoJsonPath}": root must be an object.`,
    );
  }

  // Ensure imports table exists
  if (
    !("imports" in parsed) ||
    typeof parsed.imports !== "object" ||
    parsed.imports === null ||
    Array.isArray(parsed.imports)
  ) {
    parsed.imports = {};
  }

  // spec: contracts/platform.contract.md#PLAT-19 — Map @railfog/sdk to canonical URL
  // spec: tasks/milestone-0.8-developer-experience-ux/T-0811-project-dependency-add.md#AC3 — Idempotent mapping
  const imports = parsed.imports as Record<string, string>;
  imports["@railfog/sdk"] = CANONICAL_SDK_URL;

  const formatted = JSON.stringify(parsed, null, 2) + "\n";
  await Deno.writeTextFile(denoJsonPath, formatted);

  return {
    ok: true,
    targetFile: denoJsonPath,
    addedImport: "@railfog/sdk",
    createdNewFile: false,
  };
}

export function printAddHelp(): void {
  console.log(`RailFog CLI - Add dependency or primitive

Usage:
  rail add <package> [options]

Arguments:
  <package>    Package or primitive to add (supported: sdk)

Options:
  --dir <path> Target project directory (default: current directory)
  -h, --help   Show help for add command`);
}

/**
 * CLI command handler for 'rail add'.
 */
export async function addCommand(
  packageOrPrimitive: string,
  cwd: string = Deno.cwd(),
): Promise<AddResult> {
  const result = await runAdd({ packageOrPrimitive, cwd });
  console.log(`[+] Added ${result.addedImport} to deno.json`);
  return result;
}

