# Configuration Overview (`railfog.toml`)

> [!NOTE]
> **Documentation**: [Docs Home](../README.md) &nbsp;|&nbsp; **File**:
> `railfog.toml` &nbsp;|&nbsp; **Format**: TOML 1.0 Strict &nbsp;|&nbsp;
> **Schema**: `schemas/railfog.schema.json`

RailFog applications are configured declaratively via a single `railfog.toml`
file in the project root. This manifest defines project identity, function
entrypoints, triggers, capability-scoped permissions, resource limits, and
routing rules.

---

## 1. Minimal Configuration Example

```toml
name = "api-service"

[functions.api]
entry = "functions/api.ts"

[functions.api.triggers]
http = true

[functions.api.permissions]
kv = ["main"]

[[routes]]
pattern = "/api/*"
function = "api"

[kv.main]
consistency = "strong"
```

---

## 2. Editor Autocomplete via JSON Schema

To enable instant schema validation, tooltips, and autocomplete in editors (VS
Code, WebStorm, Neovim), include the schema comment at the top of your
`railfog.toml`:

```toml
#:schema https://raw.githubusercontent.com/MoustafaAt1a/railfog/main/schemas/railfog.schema.json
name = "api-service"
```

---

## 3. Configuration Sections

- [**Manifest Reference**](manifest.md): Complete parameter-by-parameter
  reference covering all keys, types, limits, and defaults.
- [**Route Matching & Specificity**](routes.md): Explanation of path patterns,
  wildcard matching, and the `PLAT-11` scoring formula.
