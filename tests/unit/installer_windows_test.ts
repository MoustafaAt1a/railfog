// spec: contracts/platform.contract.md#PLAT-19 — Repository structure & CLI distribution
// tests/unit/installer_windows_test.ts

import { assertMatch } from "@std/assert";

Deno.test("T-0809: Windows installer script exists and conforms to PowerShell best practices", async () => {
  const scriptPath = new URL("../../scripts/install.ps1", import.meta.url);
  const content = await Deno.readTextFile(scriptPath);

  // Assert error action preference
  assertMatch(content, /\$ErrorActionPreference\s*=\s*["']Stop["']/i);

  // Assert architecture detection
  assertMatch(content, /PROCESSOR_ARCHITECTURE/i);

  // Assert install destination
  assertMatch(content, /\.railfog\\bin/i);
  assertMatch(content, /rail\.exe/i);

  // Assert User environment PATH configuration
  assertMatch(
    content,
    /\[Environment\]::GetEnvironmentVariable\(["']Path["'],\s*["']User["']\)/i,
  );
  assertMatch(
    content,
    /\[Environment\]::SetEnvironmentVariable\(["']Path["'],/i,
  );

  // Assert current process session PATH refresh
  assertMatch(content, /\$env:Path\s*=/i);
});
