# CLI Overview (`rail`)

> [!NOTE]
> **Documentation**: [Docs Home](../README.md) &nbsp;|&nbsp; **Specification**:
> [PLAT-19 (Developer Tooling)](../contracts/platform.contract.md#PLAT-19)
> &nbsp;|&nbsp; **Binary**: `rail` / `rail.exe`

The `rail` CLI manages the full application lifecycle: scaffolding, local
testing, static validation, deployment, logging, secrets, and disaster recovery.

---

## 1. Installation

### Option A: Global Deno Script

```bash
deno run -A https://raw.githubusercontent.com/MoustafaAt1a/railfog/main/scripts/install.ts
```

### Option B: Compile Standalone Native Executable

```bash
deno compile -A -o rail cli/main.ts
```

---

## 2. In-Place Upgrades (`rail upgrade`)

The CLI includes a built-in self-upgrade mechanism:

```bash
# Check for latest available version without modifying files
rail upgrade --check

# Upgrade to latest release on main
rail upgrade

# Force reinstallation
rail upgrade --force

# Install a specific tag or ref
rail upgrade --ref v1.0.0
```

---

## 3. Environment Diagnostics (`rail doctor`)

Run `rail doctor` to verify your environment, permissions, and network
connectivity:

```bash
rail doctor
```

Output:

```text
RailFog Doctor:
  [✓] Deno runtime: v2.0.0
  [✓] Local state directory: .railfog/
  [✓] SQLite driver: OK
  [✓] Control plane network connectivity: OK
  [✓] JSON schema validator: OK
```

---

## Next Steps

- Explore the complete [CLI Commands Reference](commands.md).
- Learn about the
  [Declarative Manifest (`railfog.toml`)](../configuration/manifest.md).
