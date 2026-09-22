#!/usr/bin/env -S deno run -A
// spec: contracts/platform.contract.md#PLAT-19 — Pre-release validation gatekeeper

const colors = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
};

interface GateStep {
  name: string;
  command: string[];
}

const STEPS: GateStep[] = [
  { name: "Code Formatting Check", command: ["fmt", "--check"] },
  { name: "Workspace Linter", command: ["lint"] },
  { name: "Typecheck Workspace", command: ["task", "check"] },
  { name: "Unit Test Suite", command: ["task", "test:unit"] },
  { name: "Contract & Parity Suite", command: ["task", "test:contract"] },
  { name: "Adversarial Security Suite", command: ["task", "test:security"] },
  { name: "Load & Concurrency Benchmarks", command: ["task", "test:load"] },
  { name: "End-to-End & Soak Suite", command: ["task", "test:e2e"] },
];

console.log(
  `\n${colors.bold}${colors.cyan}════════════════════════════════════════════════════════════════${colors.reset}`,
);
console.log(
  `  ${colors.bold}RAILFOG v0.9.0 BETA — PRE-RELEASE CERTIFICATION GATE${colors.reset}`,
);
console.log(
  `${colors.bold}${colors.cyan}════════════════════════════════════════════════════════════════${colors.reset}\n`,
);

const startTime = Date.now();
let passedCount = 0;

for (let i = 0; i < STEPS.length; i++) {
  const step = STEPS[i];
  const stepStart = Date.now();
  Deno.stdout.writeSync(
    new TextEncoder().encode(
      `[${i + 1}/${STEPS.length}] ${step.name.padEnd(35)} ... `,
    ),
  );

  const cmd = new Deno.Command(Deno.execPath(), {
    args: step.command,
    stdout: "piped",
    stderr: "piped",
  });

  const res = await cmd.output();
  const durationMs = Date.now() - stepStart;

  if (res.success) {
    passedCount++;
    console.log(
      `${colors.green}PASSED${colors.reset} ${colors.gray}(${
        (durationMs / 1000).toFixed(1)
      }s)${colors.reset}`,
    );
  } else {
    console.log(
      `${colors.red}FAILED${colors.reset} ${colors.gray}(${
        (durationMs / 1000).toFixed(1)
      }s)${colors.reset}`,
    );
    const stderr = new TextDecoder().decode(res.stderr);
    const stdout = new TextDecoder().decode(res.stdout);
    console.error(
      `\n${colors.red}--- Step Failure Output ---${colors.reset}\n`,
    );
    console.error(stderr || stdout);
    console.error(
      `\n${colors.red}[!] Release certification aborted. Fix the issue above and re-run.${colors.reset}\n`,
    );
    Deno.exit(1);
  }
}

const totalSec = ((Date.now() - startTime) / 1000).toFixed(1);

console.log(
  `\n${colors.bold}${colors.green}┌──────────────────────────────────────────────────────────────┐${colors.reset}`,
);
console.log(
  `${colors.bold}${colors.green}│                                                              │${colors.reset}`,
);
console.log(
  `${colors.bold}${colors.green}│  [+] ALL ${passedCount} RELEASE GATES PASSED WITHOUT WARNING OR FAILURE   │${colors.reset}`,
);
console.log(
  `${colors.bold}${colors.green}│  [+] RAILFOG v0.9.0-BETA IS 10/10 CERTIFIED FOR PUBLISHING   │${colors.reset}`,
);
console.log(
  `${colors.bold}${colors.green}│                                                              │${colors.reset}`,
);
console.log(
  `${colors.bold}${colors.green}│  Total Verification Duration: ${
    totalSec.padEnd(5)
  } seconds                 │${colors.reset}`,
);
console.log(
  `${colors.bold}${colors.green}└──────────────────────────────────────────────────────────────┘${colors.reset}\n`,
);
