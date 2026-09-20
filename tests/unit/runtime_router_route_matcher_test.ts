import { assertEquals } from "@std/assert";
import {
  matchRoute,
  type RouteConfig,
  specificityScore,
} from "../../runtime/router/route-matcher.ts";

Deno.test("specificityScore - calculates PLAT-11 scores for standard patterns", () => {
  // PLAT-11 formula: (literal_segments * 2) + (wildcard_or_named_segments * 1)

  // /api/users -> 2 literals * 2 = 4
  assertEquals(specificityScore("/api/users"), 4);

  // /api/* -> 1 literal * 2 + 1 wildcard * 1 = 3
  assertEquals(specificityScore("/api/*"), 3);

  // /api/:id -> 1 literal * 2 + 1 named * 1 = 3
  assertEquals(specificityScore("/api/:id"), 3);

  // /api/:id/posts -> 2 literals * 2 + 1 named * 1 = 5
  assertEquals(specificityScore("/api/:id/posts"), 5);

  // /* -> 0 literals * 2 + 1 wildcard * 1 = 1
  assertEquals(specificityScore("/*"), 1);

  // / -> 0 segments = 0
  assertEquals(specificityScore("/"), 0);
});

Deno.test("specificityScore - handles edge patterns and variations", () => {
  // Empty pattern -> 0
  assertEquals(specificityScore(""), 0);

  // Single literal segment -> 1 literal * 2 = 2
  assertEquals(specificityScore("/users"), 2);

  // Trailing slash normalized to same segment count
  assertEquals(specificityScore("/api/users/"), 4);

  // Multiple wildcards and named parameters
  // /api/:version/users/* -> 2 literals (api, users) * 2 + 2 (version, *) * 1 = 6
  assertEquals(specificityScore("/api/:version/users/*"), 6);
});

Deno.test("matchRoute - AC1: higher specificity score wins over lower score regardless of order", () => {
  const wildcardRoute: RouteConfig = {
    pattern: "/api/*",
    function: "wildcard-handler",
  };
  const exactRoute: RouteConfig = {
    pattern: "/api/users",
    function: "users-handler",
  };

  // Order 1: wildcard declared first, but exact has higher score (4 vs 3) -> exact wins
  const routesOrder1 = [wildcardRoute, exactRoute];
  const match1 = matchRoute(routesOrder1, "/api/users");
  assertEquals(match1, exactRoute);

  // Order 2: exact declared first, exact wins
  const routesOrder2 = [exactRoute, wildcardRoute];
  const match2 = matchRoute(routesOrder2, "/api/users");
  assertEquals(match2, exactRoute);

  // Multi-tier specificity: score 5 vs score 4 vs score 3
  const deepRoute: RouteConfig = {
    pattern: "/api/:id/posts",
    function: "posts-handler",
  }; // score 5
  const paramWildcardRoute: RouteConfig = {
    pattern: "/api/:id/*",
    function: "param-wildcard-handler",
  }; // score 4
  const broadWildcardRoute: RouteConfig = {
    pattern: "/api/*",
    function: "broad-handler",
  }; // score 3

  const tieredRoutes = [broadWildcardRoute, paramWildcardRoute, deepRoute];
  const tieredMatch = matchRoute(tieredRoutes, "/api/123/posts");
  assertEquals(tieredMatch, deepRoute);
});

Deno.test("matchRoute - AC2: equal score ties break by declaration order (two-way tie both directions)", () => {
  // /api/:id (score 3) vs /api/* (score 3) - both match /api/123
  const namedRoute: RouteConfig = {
    pattern: "/api/:id",
    function: "named-handler",
  };
  const wildcardRoute: RouteConfig = {
    pattern: "/api/*",
    function: "wildcard-handler",
  };

  // When namedRoute is declared first -> namedRoute wins
  const routes1 = [namedRoute, wildcardRoute];
  assertEquals(matchRoute(routes1, "/api/123"), namedRoute);

  // When wildcardRoute is declared first -> wildcardRoute wins
  const routes2 = [wildcardRoute, namedRoute];
  assertEquals(matchRoute(routes2, "/api/123"), wildcardRoute);
});

Deno.test("matchRoute - AC2: equal score ties break by declaration order (three-way tie all directions)", () => {
  // Three distinct routes with equal specificity score (score 3) that all match /items/active
  const routeA: RouteConfig = {
    pattern: "/items/:id",
    function: "func-a",
  };
  const routeB: RouteConfig = {
    pattern: "/items/*",
    function: "func-b",
  };
  const routeC: RouteConfig = {
    pattern: "/items/:slug",
    function: "func-c",
  };

  // [A, B, C] -> A wins
  assertEquals(matchRoute([routeA, routeB, routeC], "/items/active"), routeA);

  // [B, C, A] -> B wins
  assertEquals(matchRoute([routeB, routeC, routeA], "/items/active"), routeB);

  // [C, A, B] -> C wins
  assertEquals(matchRoute([routeC, routeA, routeB], "/items/active"), routeC);
});

Deno.test("matchRoute - AC3: returns null when no route matches", () => {
  // Empty route table returns null
  assertEquals(matchRoute([], "/api/users"), null);

  // Non-matching routes return null
  const routes: RouteConfig[] = [
    { pattern: "/api/posts", function: "posts-handler" },
    { pattern: "/auth/*", function: "auth-handler" },
  ];
  assertEquals(matchRoute(routes, "/api/users"), null);
  assertEquals(matchRoute(routes, "/"), null);
  assertEquals(matchRoute(routes, "/api/posts/123"), null);
});

Deno.test("matchRoute - handles query strings, hash fragments, and full URLs", () => {
  const routes: RouteConfig[] = [
    { pattern: "/api/users", function: "users-handler" },
    { pattern: "/api/*", function: "api-wildcard" },
  ];

  // Path with query string
  assertEquals(
    matchRoute(routes, "/api/users?page=1&limit=10"),
    routes[0],
  );

  // Full HTTP URL
  assertEquals(
    matchRoute(routes, "http://localhost:8000/api/users"),
    routes[0],
  );

  // Full HTTPS URL with query string and hash
  assertEquals(
    matchRoute(routes, "https://example.com/api/users?sort=asc#top"),
    routes[0],
  );

  // Full URL matching wildcard
  assertEquals(
    matchRoute(routes, "http://localhost:8000/api/other?filter=all"),
    routes[1],
  );
});
