# Environment Variables Reference

> [!NOTE]
> **Documentation**: [Docs Home](../README.md) &nbsp;|&nbsp; **Scope**: Platform
> Server Daemons & CLI Toolchain

This document lists all environment variables recognized by RailFog server
daemons (`apps/gateway`, `apps/runtime`, `apps/api`, `apps/worker`) and the
`rail` CLI.

---

## 1. Runtime & Networking

| Variable                              | Default                                                                     | Description                                       | Used By            |
| ------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------- | ------------------ |
| `PORT`                                | `8080` (Gateway)<br>`8081` (Runtime)<br>`8082` (API)<br>`8000` (`rail dev`) | Port number to bind HTTP/TCP listeners            | All server daemons |
| `HOST`                                | `0.0.0.0` or `127.0.0.1`                                                    | Network interface address to bind                 | All server daemons |
| `RAILFOG_CONTROL_URL`                 | `http://127.0.0.1:8082`                                                     | Endpoint URL of the Control Plane API             | Runtime, CLI       |
| `RAILFOG_RUNTIME_URL`                 | `http://127.0.0.1:8081`                                                     | Endpoint URL of the Data Plane Runtime            | Gateway, Worker    |
| `SOCKET_PATH` / `RAILFOG_SOCKET_PATH` | `/tmp/railfog-data.sock` (POSIX)                                            | Unix Domain Socket path for Gateway → Runtime IPC | Gateway, Runtime   |

---

## 2. Authentication & Tenancy

| Variable             | Default         | Description                                                         | Used By          |
| -------------------- | --------------- | ------------------------------------------------------------------- | ---------------- |
| `RAILFOG_API_KEY`    | —               | Bearer token or bootstrap API key for administrative authentication | API, CLI, Worker |
| `RAILFOG_PROJECT_ID` | `"default"`     | Active project identifier override                                  | Runtime, CLI     |
| `RAILFOG_ORG_ID`     | `"default-org"` | Top-level tenant organization identifier                            | API, Runtime     |

---

## 3. Backing Infrastructure

| Variable                                             | Default                   | Description                                                       | Used By         |
| ---------------------------------------------------- | ------------------------- | ----------------------------------------------------------------- | --------------- |
| `DATABASE_URL`                                       | —                         | PostgreSQL connection string for production KV and metadata       | API, Runtime    |
| `REDIS_URL`                                          | —                         | Redis connection string for queue broker and edge caching         | Runtime, Worker |
| `R2_ENDPOINT` / `OBJECTS_ENDPOINT`                   | —                         | S3-compatible object storage endpoint URL (Cloudflare R2, AWS S3) | Runtime, Worker |
| `R2_BUCKET_NAME` / `OBJECTS_BUCKET`                  | —                         | Target object storage bucket name                                 | Runtime, Worker |
| `R2_ACCESS_KEY_ID` / `OBJECTS_ACCESS_KEY_ID`         | —                         | S3 access key ID                                                  | Runtime, Worker |
| `R2_SECRET_ACCESS_KEY` / `OBJECTS_SECRET_ACCESS_KEY` | —                         | S3 secret access key                                              | Runtime, Worker |
| `RAILFOG_OBJECTS_DIR`                                | `.railfog/local/objects/` | Local filesystem directory for object storage                     | Local runtime   |

---

## 4. CLI & CI/CD Configuration

| Variable             | Default           | Description                                                                    | Used By                      |
| -------------------- | ----------------- | ------------------------------------------------------------------------------ | ---------------------------- |
| `RAILFOG_SOURCE_REF` | `v${CLI_VERSION}` | Pinned git release tag or branch used for CLI remote imports                   | CLI (`rail init`, `upgrade`) |
| `CI`                 | `false`           | When set to `true`, disables interactive TUI prompts, spinners, and animations | CLI                          |
