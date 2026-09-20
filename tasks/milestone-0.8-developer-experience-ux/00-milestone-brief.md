# Milestone 0.8 — Developer Experience & UX Polish (Railway-Tier DX)

**Goal**: Deliver a frictionless, delightful developer experience on par with
Railway, Vercel, and GitHub CLI:

1. **Zero-Copy Local Callback Authentication**: `rail login` spawns an ephemeral
   loopback HTTP server, opens the browser, and completes authentication with a
   single click in the browser without manual copy-pasting.
2. **Interactive Terminal UI (TUI)**: Interactive arrow-key selection prompts
   for `rail init`, animated step spinners for `rail deploy`, and styled status
   outputs.
3. **Universal 1-Line Installers**: POSIX (`install.sh`) and Windows
   (`install.ps1`) scripts to install the standalone `rail` binary in seconds
   without prerequisites.
4. **Ergonomic SDK & Instant Addition**: Ultra-short `handle()` and `api()`
   wrappers with automatic JSON serialization, plus 1-command SDK addition
   (`rail add sdk`).

---

## Dependency Graph

```
T-0801 (Ephemeral Callback Server)
  │
  ├──────────────────────────────────┐
  ▼                                  ▼
T-0802 (Web Login Callback Redirect) ──► T-0803 (Zero-Copy CLI Login Integration)
                                           │
T-0804 (Terminal Status Spinners)          │
  │                                        │
  ▼                                        │
T-0805 (Terminal Selection Prompts)        │
  │                                        │
  ├──► T-0806 (Interactive Scaffolding)    │
  │                                        │
  └──► T-0807 (Rich Deployment Feedback)   │
                                           │
T-0808 (POSIX Installer Script)            │
T-0809 (Windows Installer Script)          │
                                           │
T-0810 (Ergonomic Function Handler Wrapper)│
T-0811 (Project Dependency Add)            │
  │                                        │
  └────────────────────────────────────────┴──► T-0812 (Milestone 0.8 Verification Suite)
```

---

## Tasks Summary

| ID       | Title                                                    | Scope                                  | Spec References                                             |
| -------- | -------------------------------------------------------- | -------------------------------------- | ----------------------------------------------------------- |
| `T-0801` | Implement Ephemeral Localhost Callback Server            | `cli/callback-server.ts`               | `PLAT-1`, `PLAT-15`, `PLAT-19`                              |
| `T-0802` | Add Web Login Callback Authorization Flow                | `apps/api/login-page.ts`               | `PLAT-1`, `PLAT-15`                                         |
| `T-0803` | Integrate Zero-Copy Callback Flow into CLI Login         | `cli/login.ts`                         | `PLAT-1`, `PLAT-15`, `PLAT-17`                              |
| `T-0804` | Implement Terminal Status Spinners                       | `cli/spinner.ts`                       | `PLAT-19`                                                   |
| `T-0805` | Implement Terminal Selection Prompts                     | `cli/prompt.ts`                        | `PLAT-19`                                                   |
| `T-0806` | Implement Interactive Project Scaffolding in `rail init` | `cli/init.ts`                          | `PLAT-18`, `PLAT-19`                                        |
| `T-0807` | Implement Rich Progress Feedback for `rail deploy`       | `cli/deploy.ts`                        | `PLAT-3`, `PLAT-15`, `PLAT-19`                              |
| `T-0808` | Implement POSIX Shell Universal Installer Script         | `scripts/install.sh`                   | `PLAT-19`                                                   |
| `T-0809` | Implement Windows PowerShell Universal Installer Script  | `scripts/install.ps1`                  | `PLAT-19`                                                   |
| `T-0810` | Implement Ergonomic Function Handler Wrapper             | `sdk/typescript/wrapper.ts`            | `FN-1`, `FN-4`, `PLAT-19`                                   |
| `T-0811` | Implement Project Dependency Management in `rail add`    | `cli/add.ts`                           | `PLAT-19`                                                   |
| `T-0812` | Run Milestone 0.8 E2E Verification Suite                 | `tests/e2e/ux_dx_milestone_08_test.ts` | `PLAT-1`, `PLAT-3`, `PLAT-15`, `PLAT-17`, `PLAT-19`, `FN-1` |
| `T-0813` | Universal Deno CLI Installer & Repository Install Task   | `scripts/install.ts`                   | `PLAT-19`                                                   |
| `T-0814` | CLI Self-Upgrade Mechanism (rail update / upgrade)       | `cli/upgrade.ts`                       | `PLAT-19`                                                   |

