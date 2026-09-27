// spec: docs/contracts/platform.contract.md#PLAT-19 — Repository structure & CLI distribution
// spec: tasks/milestone-0.8-developer-experience-ux/T-0814-cli-self-upgrade-mechanism.md

/**
 * Current semantic version of the RailFog command-line interface.
 *
 * @spec docs/contracts/platform.contract.md#PLAT-19
 */
export const CLI_VERSION = "0.9.2";

// Repo coordinates used to build pinned remote-source URLs. Scaffolds and
// reinstall hints reference the v{CLI_VERSION} TAG, never a mutable branch —
// a generated project's dependency must not silently change when main moves.
// RAILFOG_SOURCE_REF overrides for local testing.
export const RAILFOG_REPO = "MoustafaAt1a/railfog";

export function railfogSourceRef(): string {
  try {
    return Deno.env.get("RAILFOG_SOURCE_REF") || `v${CLI_VERSION}`;
  } catch {
    // Env permission not granted (compiled binary, restricted runtime):
    // the version tag is the pinned default
    return `v${CLI_VERSION}`;
  }
}

export function railfogSourceUrl(path: string): string {
  const clean = path.replace(/^\/+/, "");
  return `https://raw.githubusercontent.com/${RAILFOG_REPO}/${railfogSourceRef()}/${clean}`;
}
