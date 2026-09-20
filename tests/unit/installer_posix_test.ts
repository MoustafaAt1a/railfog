// spec: contracts/platform.contract.md#PLAT-19 — Repository structure & CLI distribution
// tests/unit/installer_posix_test.ts

import { assertMatch } from "@std/assert";

Deno.test("T-0808: POSIX installer script exists and conforms to strict POSIX shell syntax", async () => {
  const scriptPath = new URL("../../scripts/install.sh", import.meta.url);
  const content = await Deno.readTextFile(scriptPath);

  // Assert strict shell execution header
  assertMatch(content, /^#!\/bin\/sh/);
  assertMatch(content, /set -e/);

  // Assert OS detection
  assertMatch(content, /uname -s/);
  assertMatch(content, /Darwin/);
  assertMatch(content, /Linux/);

  // Assert architecture detection
  assertMatch(content, /uname -m/);
  assertMatch(content, /x86_64/);
  assertMatch(content, /arm64|aarch64/);

  // Assert install destination and permissions
  assertMatch(content, /\.railfog\/bin/);
  assertMatch(content, /chmod \+x/);

  // Assert PATH export instruction
  assertMatch(content, /export PATH=/);
});
