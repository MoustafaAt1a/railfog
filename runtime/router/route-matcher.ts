// spec: docs/contracts/platform.contract.md#PLAT-11 — Routing specificity algorithm

export interface RouteConfig {
  pattern: string;
  function: string;
}

const LITERAL_SEGMENT_WEIGHT = 2;
const WILDCARD_OR_NAMED_SEGMENT_WEIGHT = 1;

function isWildcardOrNamedSegment(segment: string): boolean {
  return (
    segment.includes("*") ||
    segment.includes(":") ||
    segment.includes("(") ||
    segment.includes("{")
  );
}

// spec: docs/contracts/platform.contract.md#PLAT-11 — Routing specificity algorithm
export function specificityScore(pattern: string): number {
  const segments = pattern.split("/").filter((segment) => segment.length > 0);
  let score = 0;
  for (const segment of segments) {
    if (isWildcardOrNamedSegment(segment)) {
      score += WILDCARD_OR_NAMED_SEGMENT_WEIGHT;
    } else {
      score += LITERAL_SEGMENT_WEIGHT;
    }
  }
  return score;
}

// spec: docs/contracts/platform.contract.md#PLAT-11 — Routing specificity algorithm
export function matchRoute(
  routes: RouteConfig[],
  path: string,
): RouteConfig | null {
  let winningRoute: RouteConfig | null = null;
  let highestScore = -1;

  for (const route of routes) {
    const normalizedPattern = route.pattern.startsWith("/")
      ? route.pattern
      : `/${route.pattern}`;
    const urlPattern = new URLPattern({ pathname: normalizedPattern });
    if (urlPattern.test(path, "http://railfog.internal")) {
      const score = specificityScore(route.pattern);
      if (score > highestScore) {
        highestScore = score;
        winningRoute = route;
      }
    }
  }

  return winningRoute;
}
