# Route Matching & Specificity (`PLAT-11`)

> [!NOTE]
> **Documentation**: [Docs Home](../README.md) &nbsp;|&nbsp;
> **Specification**: [PLAT-11 (Route Specificity)](../contracts/platform.contract.md#PLAT-11) &nbsp;|&nbsp;
> **Algorithm**: Deterministic Numeric Score

When an incoming HTTP request arrives at the Gateway or Runtime, multiple configured route patterns may match the URL path. RailFog resolves route ambiguity deterministically using the **Route Specificity Scoring Formula** (`PLAT-11`).

---

## 1. The Specificity Scoring Formula

$$\text{score} = (\text{literal\_segments} \times 2) + (\text{wildcard\_segments} \times 1)$$

- **literal_segments**: Number of exact, static path segments (each contributes 2 points).
- **wildcard_segments**: Number of wildcard (`*`) segments (each contributes 1 point).
- **Precedence Rule**: The route with the highest numeric score wins.
- **Tie-Breaker Rule**: If scores are identical, declaration order in `railfog.toml` breaks ties (the first declared route wins).

---

## 2. Specificity Scoring Examples

```toml
[[routes]]
pattern = "/api/v1/users/profile"
function = "profile"

[[routes]]
pattern = "/api/v1/users/*"
function = "users"

[[routes]]
pattern = "/api/*"
function = "api"

[[routes]]
pattern = "/*"
function = "fallback"
```

| Pattern | Literal Segments | Wildcard Segments | Calculation | Final Score | Priority |
|---|---|---|---|---|---|
| `/api/v1/users/profile` | 4 | 0 | $(4 \times 2) + (0 \times 1)$ | **8** | Highest (1st) |
| `/api/v1/users/*` | 3 | 1 | $(3 \times 2) + (1 \times 1)$ | **7** | 2nd |
| `/api/*` | 1 | 1 | $(1 \times 2) + (1 \times 1)$ | **3** | 3rd |
| `/*` | 0 | 1 | $(0 \times 2) + (1 \times 1)$ | **1** | Lowest (4th) |

---

## 3. Testing Route Matching with `rail simulate`

You can dry-run URL resolution against your project's `railfog.toml` offline:

```bash
rail simulate --path /api/v1/users/profile
```

Output:
```text
Simulated Route Match:
  Path:        /api/v1/users/profile
  Pattern:     /api/v1/users/profile
  Function:    profile
  Score:       8 (Literal: 4, Wildcard: 0)
```

---

## Next Steps

- Explore the [SDK Developer Guide](../sdk/overview.md).
- Learn about the [CLI Commands](../cli/commands.md).
