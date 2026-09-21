import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl } from "@std/path";
import {
  generateBashCompletion,
  generateCompletions,
  generateFishCompletion,
  generatePowerShellCompletion,
  generateZshCompletion,
  runCompletions,
  SUBCOMMANDS,
  SUPPORTED_SHELLS,
} from "../../cli/completions.ts";

const cliMainPath = fromFileUrl(new URL("../../cli/main.ts", import.meta.url));

async function runCli(
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const command = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--allow-read",
      "--allow-write",
      "--allow-env",
      cliMainPath,
      ...args,
    ],
    stdout: "piped",
    stderr: "piped",
  });
  const output = await command.output();
  return {
    code: output.code,
    stdout: new TextDecoder().decode(output.stdout),
    stderr: new TextDecoder().decode(output.stderr),
  };
}

// =============================================================================
// Unit Tests: Script Generators
// =============================================================================

Deno.test("Completions (Unit): SUPPORTED_SHELLS list contains 4 primary shells", () => {
  assertEquals(SUPPORTED_SHELLS, ["powershell", "bash", "zsh", "fish"]);
});

Deno.test("Completions (Unit): PowerShell script contains Register-ArgumentCompleter and all subcommands", () => {
  const script = generatePowerShellCompletion();
  assertStringIncludes(script, "Register-ArgumentCompleter");
  assertStringIncludes(script, "-CommandName 'rail'");
  for (const cmd of SUBCOMMANDS) {
    assertStringIncludes(script, `'${cmd.name}'`);
  }
});

Deno.test("Completions (Unit): Bash script contains _rail_completions and complete -F", () => {
  const script = generateBashCompletion();
  assertStringIncludes(script, "_rail_completions()");
  assertStringIncludes(script, "complete -F _rail_completions rail");
  for (const cmd of SUBCOMMANDS) {
    assertStringIncludes(script, cmd.name);
  }
});

Deno.test("Completions (Unit): Zsh script contains #compdef rail and _describe", () => {
  const script = generateZshCompletion();
  assertStringIncludes(script, "#compdef rail");
  assertStringIncludes(script, "_describe");
  for (const cmd of SUBCOMMANDS) {
    assertStringIncludes(script, `'${cmd.name}:`);
  }
});

Deno.test("Completions (Unit): Fish script contains complete -c rail and subcommands", () => {
  const script = generateFishCompletion();
  assertStringIncludes(script, "complete -c rail -f");
  for (const cmd of SUBCOMMANDS) {
    assertStringIncludes(script, `-a ${cmd.name}`);
  }
});

Deno.test("Completions (Unit): generateCompletions handles all supported shells", () => {
  for (const shell of SUPPORTED_SHELLS) {
    const script = generateCompletions(shell);
    assert(script.length > 50, `Script for ${shell} should not be empty`);
  }
});

Deno.test("Completions (Unit): runCompletions without shell returns ok and prints help", () => {
  const res = runCompletions();
  assertEquals(res.ok, true);
});

Deno.test("Completions (Unit): runCompletions with invalid shell returns ok: false", () => {
  const res = runCompletions("unknown-shell");
  assertEquals(res.ok, false);
});

// =============================================================================
// Integration Tests: CLI invocation
// =============================================================================

Deno.test("Completions (Integration): rail completions --help documents all shells", async () => {
  const res = await runCli(["completions", "--help"]);
  assertEquals(res.code, 0);
  assertStringIncludes(res.stdout, "powershell");
  assertStringIncludes(res.stdout, "bash");
  assertStringIncludes(res.stdout, "zsh");
  assertStringIncludes(res.stdout, "fish");
});

Deno.test("Completions (Integration): rail completions powershell outputs valid script", async () => {
  const res = await runCli(["completions", "powershell"]);
  assertEquals(res.code, 0);
  assertStringIncludes(res.stdout, "Register-ArgumentCompleter");
  assertStringIncludes(res.stdout, "deploy");
});

Deno.test("Completions (Integration): rail completions bash outputs valid script", async () => {
  const res = await runCli(["completions", "bash"]);
  assertEquals(res.code, 0);
  assertStringIncludes(res.stdout, "complete -F _rail_completions rail");
});

Deno.test("Completions (Integration): rail completions zsh outputs valid script", async () => {
  const res = await runCli(["completions", "zsh"]);
  assertEquals(res.code, 0);
  assertStringIncludes(res.stdout, "#compdef rail");
});

Deno.test("Completions (Integration): rail completions fish outputs valid script", async () => {
  const res = await runCli(["completions", "fish"]);
  assertEquals(res.code, 0);
  assertStringIncludes(res.stdout, "complete -c rail");
});

Deno.test("Completions (Integration): rail completions invalid-shell exits non-zero", async () => {
  const res = await runCli(["completions", "invalid-shell"]);
  assertEquals(res.code, 1);
  assertStringIncludes(res.stderr, "Unsupported shell");
});
