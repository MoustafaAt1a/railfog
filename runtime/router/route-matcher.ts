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

const patternCache = new Map<string, URLPattern>();
const MAX_PATTERN_CACHE_SIZE = 1000;

function getCompiledPattern(normalizedPattern: string): URLPattern {
  let p = patternCache.get(normalizedPattern);
  if (!p) {
    if (patternCache.size >= MAX_PATTERN_CACHE_SIZE) {
      patternCache.clear();
    }
    p = new URLPattern({ pathname: normalizedPattern });
    patternCache.set(normalizedPattern, p);
  }
  return p;
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
    const urlPattern = getCompiledPattern(normalizedPattern);
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
