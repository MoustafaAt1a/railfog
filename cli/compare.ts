// spec: contracts/platform.contract.md#PLAT-19 — Repository structure & CLI subcommands
// cli/compare.ts — Architectural comparison matrix vs AWS Lambda & Cloudflare Workers

import { renderCompetitiveMatrix } from "./ui.ts";

export function printCompareHelp(): void {
  console.log(`RailFog CLI - Architectural Comparison

Usage:
  rail compare [options]

Displays an architectural feature and latency matrix contrasting RailFog
with AWS Lambda and Cloudflare Workers.

Options:
  -h, --help    Show help for compare command`);
}

/**
 * Renders the competitive architectural comparison matrix.
 *
 * @spec contracts/platform.contract.md#PLAT-19
 */
export function compareCommand(): void {
  console.log("\n" + renderCompetitiveMatrix() + "\n");
}
