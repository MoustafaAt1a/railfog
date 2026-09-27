# URL Routing & Specificity Guide

> [!NOTE]
> **Documentation**: [Docs Home](../README.md) &nbsp;|&nbsp; **Specification**:
> [`PLAT-11`](../contracts/platform.contract.md#PLAT-11) &nbsp;|&nbsp;
> **Algorithm**: Deterministic Mathematical Specificity

RailFog uses the standard Web API `URLPattern` engine with an explicit
mathematical specificity scoring formula to eliminate routing ambiguity and
prevent route hijacking.

---

## 1. Declaring Routes in `railfog.toml`

Routes are defined under `[[routes]]` and map URL path patterns to target
functions:

```toml
[[routes]]
pattern = "/api/v1/users/:id"
function = "users"

[[routes]]
pattern = "/api/v1/users/*"
function = "users_wildcard"

[[routes]]
pattern = "/api/*"
function = "api_gateway"

[[routes]]
pattern = "/*"
function = "static_fallback"
```

---

## 2. Route Specificity Scoring Algorithm (`PLAT-11`)

When an incoming request matches multiple configured route patterns, the routing
engine calculates a numeric specificity score for each matching candidate:

$$\text{score} = (\text{literal\_segments} \times 2) + (\text{wildcard\_segments} \times 1)$$

### Scoring Rules

1. **Literal Segments**: Each exact, static segment contributes **2 points**
   (e.g. `/api/v1` has 2 literal segments = 4 points).
2. **Wildcard & Named Segments**: Each parameter (`:id`) or wildcard (`*`)
   segment contributes **1 point**.
3. **Precedence**: The candidate with the highest numeric score wins.
4. **Tie-Breaker**: If two matching patterns have identical specificity scores,
   **declaration order in `railfog.toml` breaks ties** (the first declared route
   wins monotonically).

### Specificity Scoring Table

| Pattern                 | Literal Count | Wildcard/Param Count | Calculation                   | Score | Priority             |
| ----------------------- | ------------- | -------------------- | ----------------------------- | ----- | -------------------- |
| `/api/v1/users/profile` | 4             | 0                    | $(4 \times 2) + (0 \times 1)$ | **8** | 1st (Highest)        |
| `/api/v1/users/:id`     | 3             | 1                    | $(3 \times 2) + (1 \times 1)$ | **7** | 2nd                  |
| `/api/v1/users/*`       | 3             | 1                    | $(3 \times 2) + (1 \times 1)$ | **7** | 3rd (Lost tie-break) |
| `/api/*`                | 1             | 1                    | $(1 \times 2) + (1 \times 1)$ | **3** | 4th                  |
| `/*`                    | 0             | 1                    | $(0 \times 2) + (1 \times 1)$ | **1** | 5th (Lowest)         |

---

## 3. Testing Route Matching with `rail simulate`

You can dry-run route resolution against your `railfog.toml` configuration
without starting a server:

```bash
rail simulate --path /api/v1/users/profile
```

Sample output:

```text
Simulated Route Match:
  Path:        /api/v1/users/profile
  Pattern:     /api/v1/users/profile
  Function:    profile
  Score:       8 (Literal: 4, Wildcard: 0)
```

Test pattern fallback:

```bash
rail simulate --path /unknown
```

```text
Simulated Route Match:
  Path:        /unknown
  Pattern:     /*
  Function:    static_fallback
  Score:       1 (Literal: 0, Wildcard: 1)
```

---

## Next Steps

- Learn how to manage [Secrets](secrets.md).
- Learn about [Testing Functions](testing.md).
