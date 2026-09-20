// spec: contracts/platform.contract.md#PLAT-1 — Stage 1 deployment topology: two processes (railfog-control on 8081, railfog-runtime on 8080)
// spec: contracts/platform.contract.md#PLAT-4 — Isolation, defense in depth, unprivileged execution, capability dropping
// spec: contracts/platform.contract.md#PLAT-19 — Repository structure: infra/ directory
// spec: tasks/milestone-0.6-public-beta/T-0603-production-packaging-spec.md

import { assert, assertEquals, assertFalse } from "@std/assert";
import { join, resolve } from "@std/path";
// deno-lint-ignore no-import-prefix
import { parse as parseYaml } from "jsr:@std/yaml@0.224.0";

// spec: contracts/platform.contract.md#PLAT-1 — Control plane port
export const CONTROL_PLANE_PORT = 8081;

// spec: contracts/platform.contract.md#PLAT-1 — Data plane port
export const DATA_PLANE_PORT = 8080;

// spec: tasks/milestone-0.6-public-beta/T-0603-production-packaging-spec.md — Non-root unprivileged identities
export const UNPRIVILEGED_UID = "10001";
export const UNPRIVILEGED_USER = "railfog";

export interface ContainerSpecValidation {
  dockerfileControlValid: boolean;
  dockerfileRuntimeValid: boolean;
  composeConfigValid: boolean;
  hasUnprivilegedUser: boolean;
  hasHealthcheck: boolean;
  errors: string[];
}

interface DockerfileInstruction {
  instruction: string;
  args: string;
  raw: string;
}

interface DockerfileStage {
  fromImage: string;
  instructions: DockerfileInstruction[];
}

/**
 * Parses Dockerfile content into build stages and instructions,
 * handling line continuations and stripping comments.
 */
function parseDockerfileStages(content: string): DockerfileStage[] {
  const lines = content.split(/\r?\n/);
  const stages: DockerfileStage[] = [];
  let currentStage: DockerfileStage | null = null;
  let accumulated = "";

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("#") || trimmed === "") {
      continue;
    }
    if (trimmed.endsWith("\\")) {
      accumulated += (accumulated ? " " : "") + trimmed.slice(0, -1).trim();
      continue;
    }
    accumulated += (accumulated ? " " : "") + trimmed;
    const spaceIdx = accumulated.search(/\s/);
    let instruction = "";
    let args = "";
    if (spaceIdx > 0) {
      instruction = accumulated.substring(0, spaceIdx).toUpperCase();
      args = accumulated.substring(spaceIdx).trim();
    } else {
      instruction = accumulated.toUpperCase();
      args = "";
    }
    accumulated = "";

    const instObj: DockerfileInstruction = { instruction, args, raw: line };

    if (instruction === "FROM") {
      currentStage = {
        fromImage: args.split(/\s+/)[0],
        instructions: [instObj],
      };
      stages.push(currentStage);
    } else if (currentStage) {
      currentStage.instructions.push(instObj);
    }
  }

  return stages;
}

function isUnprivilegedUser(userStr: string): boolean {
  const normalized = userStr.trim();
  const [user] = normalized.split(":");
  return user === UNPRIVILEGED_USER || user === UNPRIVILEGED_UID;
}

function isRootUser(userVal: unknown): boolean {
  if (userVal === 0 || userVal === "0" || userVal === "root") return true;
  if (typeof userVal === "number") {
    return userVal === 0;
  }
  if (typeof userVal === "string") {
    const trimmed = userVal.trim().toLowerCase();
    const [user] = trimmed.split(":");
    if (user === "0" || user === "root") return true;
  }
  return false;
}

function validateControlDockerfile(
  content: string,
  filename = "Dockerfile.control",
) {
  const errors: string[] = [];
  const stages = parseDockerfileStages(content);
  if (stages.length === 0) {
    errors.push(`${filename}: missing FROM instruction`);
    return {
      valid: false,
      unprivilegedUser: false,
      healthcheck: false,
      errors,
    };
  }

  const finalStage = stages[stages.length - 1];

  // Validate non-root USER in runtime stage (PLAT-4, T-0603)
  let unprivilegedUser = false;
  const userInstructions = finalStage.instructions.filter((i) =>
    i.instruction === "USER"
  );
  if (userInstructions.length === 0) {
    errors.push(
      `${filename}: missing USER directive in final runtime stage (must run as unprivileged user railfog or UID 10001 per PLAT-4)`,
    );
  } else {
    const lastUser = userInstructions[userInstructions.length - 1].args.trim();
    const [userName] = lastUser.split(":");
    if (userName === "root" || userName === "0") {
      errors.push(
        `${filename}: runs as root user; must run as unprivileged user railfog or UID 10001 per PLAT-4`,
      );
    } else if (isUnprivilegedUser(userName)) {
      unprivilegedUser = true;
    } else {
      errors.push(
        `${filename}: USER must be '${UNPRIVILEGED_USER}' or UID ${UNPRIVILEGED_UID}, found: ${userName}`,
      );
    }
  }

  // Validate EXPOSE 8081 for control plane (PLAT-1)
  const exposeInstructions = finalStage.instructions.filter((i) =>
    i.instruction === "EXPOSE"
  );
  const portRegex = new RegExp(`\\b${CONTROL_PLANE_PORT}\\b`);
  const portValid = exposeInstructions.some((i) => portRegex.test(i.args));
  if (!portValid) {
    errors.push(`${filename}: missing EXPOSE ${CONTROL_PLANE_PORT} directive`);
  }

  // Validate native HEALTHCHECK probing /healthz per PLAT-1
  let healthcheck = false;
  let controlHealthzValid = false;
  const healthcheckInstructions = finalStage.instructions.filter(
    (i) =>
      i.instruction === "HEALTHCHECK" &&
      !i.args.toUpperCase().startsWith("NONE"),
  );
  if (healthcheckInstructions.length === 0) {
    errors.push(`${filename}: missing HEALTHCHECK directive per PLAT-1`);
  } else {
    healthcheck = true;
    const hasHealthz = healthcheckInstructions.some((i) =>
      i.args.includes("/healthz")
    );
    if (!hasHealthz) {
      errors.push(`${filename}: HEALTHCHECK must probe /healthz per PLAT-1`);
    } else {
      controlHealthzValid = true;
    }
  }

  const valid = unprivilegedUser && portValid && healthcheck &&
    controlHealthzValid;
  return { valid, unprivilegedUser, healthcheck, errors };
}

function validateRuntimeDockerfile(
  content: string,
  filename = "Dockerfile.runtime",
) {
  const errors: string[] = [];
  const stages = parseDockerfileStages(content);
  if (stages.length === 0) {
    errors.push(`${filename}: missing FROM instruction`);
    return {
      valid: false,
      unprivilegedUser: false,
      healthcheck: false,
      errors,
    };
  }

  const finalStage = stages[stages.length - 1];

  // Validate non-root USER in runtime stage (PLAT-4, T-0603)
  let unprivilegedUser = false;
  const userInstructions = finalStage.instructions.filter((i) =>
    i.instruction === "USER"
  );
  if (userInstructions.length === 0) {
    errors.push(
      `${filename}: missing USER directive in final runtime stage (must run as unprivileged user railfog or UID 10001 per PLAT-4)`,
    );
  } else {
    const lastUser = userInstructions[userInstructions.length - 1].args.trim();
    const [userName] = lastUser.split(":");
    if (userName === "root" || userName === "0") {
      errors.push(
        `${filename}: runs as root user; must run as unprivileged user railfog or UID 10001 per PLAT-4`,
      );
    } else if (isUnprivilegedUser(userName)) {
      unprivilegedUser = true;
    } else {
      errors.push(
        `${filename}: USER must be '${UNPRIVILEGED_USER}' or UID ${UNPRIVILEGED_UID}, found: ${userName}`,
      );
    }
  }

  // Validate EXPOSE 8080 for data plane (PLAT-1)
  const exposeInstructions = finalStage.instructions.filter((i) =>
    i.instruction === "EXPOSE"
  );
  const portRegex = new RegExp(`\\b${DATA_PLANE_PORT}\\b`);
  const portValid = exposeInstructions.some((i) => portRegex.test(i.args));
  if (!portValid) {
    errors.push(`${filename}: missing EXPOSE ${DATA_PLANE_PORT} directive`);
  }

  // Validate native HEALTHCHECK probing /healthz per PLAT-1
  let healthcheck = false;
  let runtimeHealthzValid = false;
  const healthcheckInstructions = finalStage.instructions.filter(
    (i) =>
      i.instruction === "HEALTHCHECK" &&
      !i.args.toUpperCase().startsWith("NONE"),
  );
  if (healthcheckInstructions.length === 0) {
    errors.push(`${filename}: missing HEALTHCHECK directive per PLAT-1`);
  } else {
    healthcheck = true;
    const hasHealthz = healthcheckInstructions.some((i) =>
      i.args.includes("/healthz")
    );
    if (!hasHealthz) {
      errors.push(`${filename}: HEALTHCHECK must probe /healthz per PLAT-1`);
    } else {
      runtimeHealthzValid = true;
    }
  }

  const valid = unprivilegedUser && portValid && healthcheck &&
    runtimeHealthzValid;
  return { valid, unprivilegedUser, healthcheck, errors };
}

function getServiceNetworks(service: Record<string, unknown>): string[] {
  if (Array.isArray(service.networks)) {
    return service.networks.map((n) => String(n));
  }
  if (service.networks && typeof service.networks === "object") {
    return Object.keys(service.networks);
  }
  return [];
}

function hasControlReference(service: Record<string, unknown>): boolean {
  const env = service.environment;
  if (Array.isArray(env)) {
    return env.some((item) => {
      const str = String(item);
      return str.includes("RAILFOG_CONTROL_URL") ||
        str.includes("railfog-control");
    });
  }
  if (env && typeof env === "object") {
    return Object.entries(env).some(([key, val]) => {
      return key.includes("RAILFOG_CONTROL_URL") ||
        String(val).includes("railfog-control");
    });
  }
  return false;
}

function exposesPort(
  service: Record<string, unknown>,
  targetPort: number,
): boolean {
  const ports = service.ports;
  if (Array.isArray(ports)) {
    return ports.some((p) => {
      if (typeof p === "number") return p === targetPort;
      if (typeof p === "string") {
        const parts = p.split(":");
        const lastPart = parts[parts.length - 1].split("/")[0];
        const containerPort = parseInt(lastPart, 10);
        if (containerPort === targetPort) return true;
        if (parts.length > 1) {
          const hostPart = parts[parts.length - 2].split("/")[0];
          if (parseInt(hostPart, 10) === targetPort) return true;
        }
      }
      if (p && typeof p === "object") {
        const obj = p as Record<string, unknown>;
        if (obj.target === targetPort || obj.published === targetPort) {
          return true;
        }
      }
      return false;
    });
  }
  return false;
}

function isPortPubliclyExposed(
  service: Record<string, unknown>,
  targetPort: number,
): boolean {
  const ports = service.ports;
  if (!Array.isArray(ports) || ports.length === 0) {
    return false;
  }
  for (const p of ports) {
    if (typeof p === "number" && p === targetPort) {
      return true;
    }
    if (typeof p === "string") {
      const parts = p.split(":");
      if (parts.length === 1) {
        if (parseInt(parts[0].split("/")[0], 10) === targetPort) return true;
      } else if (parts.length === 2) {
        if (
          parseInt(parts[1].split("/")[0], 10) === targetPort ||
          parseInt(parts[0], 10) === targetPort
        ) {
          return true;
        }
      } else if (parts.length === 3) {
        const hostIp = parts[0];
        const containerPort = parseInt(parts[2].split("/")[0], 10);
        const hostPort = parseInt(parts[1], 10);
        if (containerPort === targetPort || hostPort === targetPort) {
          if (
            hostIp !== "127.0.0.1" && hostIp !== "localhost" && hostIp !== "::1"
          ) {
            return true;
          }
        }
      }
    }
    if (p && typeof p === "object") {
      const obj = p as Record<string, unknown>;
      const hostIp = typeof obj.host_ip === "string" ? obj.host_ip : "";
      if (obj.target === targetPort || obj.published === targetPort) {
        if (
          hostIp !== "127.0.0.1" && hostIp !== "localhost" && hostIp !== "::1"
        ) {
          return true;
        }
      }
    }
  }
  return false;
}

function validateComposeConfig(
  content: string,
  filename = "docker-compose.yaml",
) {
  const errors: string[] = [];
  let parsed: unknown;
  try {
    parsed = parseYaml(content);
  } catch (err) {
    errors.push(
      `${filename}: invalid YAML syntax: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return { valid: false, unprivilegedOk: false, errors };
  }

  if (!parsed || typeof parsed !== "object") {
    errors.push(`${filename}: expected a YAML mapping document`);
    return { valid: false, unprivilegedOk: false, errors };
  }

  const compose = parsed as Record<string, unknown>;
  const services = compose.services;
  if (!services || typeof services !== "object") {
    errors.push(`${filename}: missing 'services' definition`);
    return { valid: false, unprivilegedOk: false, errors };
  }

  const servicesMap = services as Record<string, Record<string, unknown>>;
  const controlService = servicesMap["railfog-control"];
  const runtimeService = servicesMap["railfog-runtime"];

  let hasRequiredServices = true;
  if (!controlService) {
    errors.push(
      `${filename}: missing required service 'railfog-control' per PLAT-1`,
    );
    hasRequiredServices = false;
  }
  if (!runtimeService) {
    errors.push(
      `${filename}: missing required service 'railfog-runtime' per PLAT-1`,
    );
    hasRequiredServices = false;
  }

  if (!hasRequiredServices || !controlService || !runtimeService) {
    return { valid: false, unprivilegedOk: false, errors };
  }

  // 1. Internal network check
  let networkValid = true;
  const topNetworks = compose.networks;
  if (
    !topNetworks || typeof topNetworks !== "object" ||
    Object.keys(topNetworks).length === 0
  ) {
    errors.push(
      `${filename}: missing top-level 'networks' definition for internal isolation per PLAT-1`,
    );
    networkValid = false;
  }

  const controlNetworks = getServiceNetworks(controlService);
  const runtimeNetworks = getServiceNetworks(runtimeService);
  const sharedNetworks = controlNetworks.filter((n) =>
    runtimeNetworks.includes(n)
  );
  if (sharedNetworks.length === 0) {
    errors.push(
      `${filename}: services 'railfog-control' and 'railfog-runtime' must share an internal network per PLAT-1`,
    );
    networkValid = false;
  }

  // 2. Runtime references Control check
  let linkValid = true;
  const referencesControl = hasControlReference(runtimeService);
  if (!referencesControl) {
    errors.push(
      `${filename}: 'railfog-runtime' must reference 'railfog-control' (e.g. via RAILFOG_CONTROL_URL) per PLAT-1`,
    );
    linkValid = false;
  }

  // 3. Port 8080 exposed by runtime
  let runtimePortValid = true;
  if (!exposesPort(runtimeService, DATA_PLANE_PORT)) {
    errors.push(
      `${filename}: 'railfog-runtime' must expose data plane port ${DATA_PLANE_PORT}`,
    );
    runtimePortValid = false;
  }

  // 4. Port 8081 NOT publicly exposed by control
  let controlExposureValid = true;
  if (isPortPubliclyExposed(controlService, CONTROL_PLANE_PORT)) {
    errors.push(
      `${filename}: 'railfog-control' port ${CONTROL_PLANE_PORT} must not be publicly exposed to host interfaces (must be internal-only or loopback-bound) per PLAT-1`,
    );
    controlExposureValid = false;
  }

  // 5. Security options & cap_drop (PLAT-4)
  let securityValid = true;
  for (const [name, svc] of Object.entries(servicesMap)) {
    const privVal = svc.privileged;
    if (
      privVal === true ||
      privVal === 1 ||
      (typeof privVal === "string" && (
        privVal.toLowerCase() === "true" ||
        privVal.toLowerCase() === "yes" ||
        privVal === "1"
      ))
    ) {
      errors.push(
        `${filename}: service '${name}' must not run with privileged: true (forbidden per PLAT-4)`,
      );
      securityValid = false;
    }

    if (svc.cap_add !== undefined) {
      const capAdd = Array.isArray(svc.cap_add) ? svc.cap_add : [svc.cap_add];
      if (capAdd.length > 0) {
        errors.push(
          `${filename}: service '${name}' must not grant capabilities via cap_add per PLAT-4`,
        );
        securityValid = false;
      }
    }

    const secOpt = svc.security_opt;
    if (Array.isArray(secOpt)) {
      const hasFalse = secOpt.some((s) => {
        const normalized = String(s).toLowerCase().replace(/\s+/g, "");
        return normalized === "no-new-privileges:false" ||
          normalized === "no-new-privileges=false";
      });
      if (hasFalse) {
        errors.push(
          `${filename}: service '${name}' must not disable no-new-privileges per PLAT-4`,
        );
        securityValid = false;
      }
    }
  }

  const capDrop = runtimeService.cap_drop;
  const hasCapDropAll = Array.isArray(capDrop) &&
    capDrop.some((c) => String(c).toUpperCase() === "ALL");
  if (!hasCapDropAll) {
    errors.push(
      `${filename}: 'railfog-runtime' must configure cap_drop: [ALL] per PLAT-4`,
    );
    securityValid = false;
  }

  const secOpt = runtimeService.security_opt;
  const hasNoNewPrivileges = Array.isArray(secOpt) &&
    secOpt.some((s) => {
      const normalized = String(s).toLowerCase().replace(/\s+/g, "");
      return normalized === "no-new-privileges:true" ||
        normalized === "no-new-privileges=true" ||
        normalized === "no-new-privileges";
    });
  if (!hasNoNewPrivileges) {
    errors.push(
      `${filename}: 'railfog-runtime' must configure security_opt with no-new-privileges:true per PLAT-4`,
    );
    securityValid = false;
  }

  // 6. Check unprivileged user in compose
  let unprivilegedOk = true;
  for (const [name, svc] of Object.entries(servicesMap)) {
    if (svc.user !== undefined) {
      if (isRootUser(svc.user)) {
        errors.push(
          `${filename}: service '${name}' must not specify root user per PLAT-4`,
        );
        unprivilegedOk = false;
      } else if (!isUnprivilegedUser(String(svc.user))) {
        errors.push(
          `${filename}: service '${name}' user must be '${UNPRIVILEGED_USER}' or UID ${UNPRIVILEGED_UID} per PLAT-4, found: ${svc.user}`,
        );
        unprivilegedOk = false;
      }
    }
  }

  const valid = networkValid && linkValid && runtimePortValid &&
    controlExposureValid && securityValid &&
    unprivilegedOk;
  return { valid, unprivilegedOk, errors };
}

/**
 * Validates container packaging specifications within the given directory.
 */
export async function validatePackagingSpecs(
  infraDir: string,
): Promise<ContainerSpecValidation> {
  const errors: string[] = [];

  const controlPath = join(infraDir, "Dockerfile.control");
  const runtimePath = join(infraDir, "Dockerfile.runtime");
  const composePath = join(infraDir, "docker-compose.yaml");

  let controlValid = false;
  let runtimeValid = false;
  let composeValid = false;
  let controlUnprivileged = false;
  let runtimeUnprivileged = false;
  let controlHealthcheck = false;
  let runtimeHealthcheck = false;

  // 1. Dockerfile.control
  let controlContent: string | null = null;
  try {
    controlContent = await Deno.readTextFile(controlPath);
  } catch (_e) {
    errors.push(`Dockerfile.control does not exist at ${controlPath}`);
  }

  if (controlContent !== null) {
    const res = validateControlDockerfile(controlContent);
    controlValid = res.valid;
    controlUnprivileged = res.unprivilegedUser;
    controlHealthcheck = res.healthcheck;
    errors.push(...res.errors);
  }

  // 2. Dockerfile.runtime
  let runtimeContent: string | null = null;
  try {
    runtimeContent = await Deno.readTextFile(runtimePath);
  } catch (_e) {
    errors.push(`Dockerfile.runtime does not exist at ${runtimePath}`);
  }

  if (runtimeContent !== null) {
    const res = validateRuntimeDockerfile(runtimeContent);
    runtimeValid = res.valid;
    runtimeUnprivileged = res.unprivilegedUser;
    runtimeHealthcheck = res.healthcheck;
    errors.push(...res.errors);
  }

  // 3. docker-compose.yaml
  let composeContent: string | null = null;
  try {
    composeContent = await Deno.readTextFile(composePath);
  } catch (_e) {
    errors.push(`docker-compose.yaml does not exist at ${composePath}`);
  }

  let composeUnprivilegedOk = true;
  if (composeContent !== null) {
    const res = validateComposeConfig(composeContent);
    composeValid = res.valid;
    if (!res.unprivilegedOk) {
      composeUnprivilegedOk = false;
    }
    errors.push(...res.errors);
  }

  const hasUnprivilegedUser = controlUnprivileged && runtimeUnprivileged &&
    composeUnprivilegedOk;
  const hasHealthcheck = controlHealthcheck && runtimeHealthcheck;

  return {
    dockerfileControlValid: controlValid,
    dockerfileRuntimeValid: runtimeValid,
    composeConfigValid: composeValid,
    hasUnprivilegedUser,
    hasHealthcheck,
    errors,
  };
}

// ============================================================================
// Synthetic Fixtures & Unit Tests
// ============================================================================

const VALID_DOCKERFILE_CONTROL = `
FROM denoland/deno:alpine
WORKDIR /app
COPY . .
EXPOSE 8081
USER 10001
HEALTHCHECK --interval=10s --timeout=3s --retries=3 CMD curl -f http://localhost:8081/healthz || exit 1
CMD ["run", "--allow-all", "apps/api/mod.ts"]
`;

const VALID_DOCKERFILE_RUNTIME = `
FROM denoland/deno:alpine
WORKDIR /app
COPY . .
EXPOSE 8080
USER railfog
HEALTHCHECK --interval=10s --timeout=3s --retries=3 CMD curl -f http://localhost:8080/healthz || exit 1
CMD ["run", "--allow-all", "runtime/mod.ts"]
`;

const VALID_COMPOSE_YAML = `
version: "3.8"
networks:
  railfog-internal:
    driver: bridge
services:
  railfog-control:
    build:
      context: .
      dockerfile: Dockerfile.control
    networks:
      - railfog-internal
    expose:
      - "8081"
  railfog-runtime:
    build:
      context: .
      dockerfile: Dockerfile.runtime
    networks:
      - railfog-internal
    ports:
      - "8080:8080"
    environment:
      - RAILFOG_CONTROL_URL=http://railfog-control:8081
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
`;

async function createSyntheticInfra(
  files: {
    control?: string;
    runtime?: string;
    compose?: string;
  },
): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await Deno.makeTempDir({ prefix: "railfog-packaging-test-" });
  if (files.control !== undefined) {
    await Deno.writeTextFile(join(dir, "Dockerfile.control"), files.control);
  }
  if (files.runtime !== undefined) {
    await Deno.writeTextFile(join(dir, "Dockerfile.runtime"), files.runtime);
  }
  if (files.compose !== undefined) {
    await Deno.writeTextFile(join(dir, "docker-compose.yaml"), files.compose);
  }
  return {
    dir,
    cleanup: async () => {
      await Deno.remove(dir, { recursive: true });
    },
  };
}

Deno.test("validatePackagingSpecs - static validator against valid configuration passes with all flags true and no errors", async () => {
  const { dir, cleanup } = await createSyntheticInfra({
    control: VALID_DOCKERFILE_CONTROL,
    runtime: VALID_DOCKERFILE_RUNTIME,
    compose: VALID_COMPOSE_YAML,
  });

  try {
    const result = await validatePackagingSpecs(dir);
    assertEquals(result.dockerfileControlValid, true);
    assertEquals(result.dockerfileRuntimeValid, true);
    assertEquals(result.composeConfigValid, true);
    assertEquals(result.hasUnprivilegedUser, true);
    assertEquals(result.hasHealthcheck, true);
    assertEquals(result.errors, []);
  } finally {
    await cleanup();
  }
});

Deno.test("validatePackagingSpecs - static validator detects root user in Dockerfile and fails hasUnprivilegedUser", async () => {
  const rootControl = VALID_DOCKERFILE_CONTROL.replace(
    "USER 10001",
    "USER root",
  );
  const { dir, cleanup } = await createSyntheticInfra({
    control: rootControl,
    runtime: VALID_DOCKERFILE_RUNTIME,
    compose: VALID_COMPOSE_YAML,
  });

  try {
    const result = await validatePackagingSpecs(dir);
    assertFalse(result.hasUnprivilegedUser);
    assertFalse(result.dockerfileControlValid);
    assert(result.errors.some((e) => e.includes("runs as root user")));
  } finally {
    await cleanup();
  }
});

Deno.test("validatePackagingSpecs - static validator detects missing USER directive and fails hasUnprivilegedUser", async () => {
  const noUserRuntime = VALID_DOCKERFILE_RUNTIME.replace("USER railfog", "");
  const { dir, cleanup } = await createSyntheticInfra({
    control: VALID_DOCKERFILE_CONTROL,
    runtime: noUserRuntime,
    compose: VALID_COMPOSE_YAML,
  });

  try {
    const result = await validatePackagingSpecs(dir);
    assertFalse(result.hasUnprivilegedUser);
    assertFalse(result.dockerfileRuntimeValid);
    assert(result.errors.some((e) => e.includes("missing USER directive")));
  } finally {
    await cleanup();
  }
});

Deno.test("validatePackagingSpecs - static validator accepts non-root UID 10001 and 'railfog' user", async () => {
  const controlWithUid = VALID_DOCKERFILE_CONTROL.replace(
    "USER 10001",
    "USER 10001:10001",
  );
  const runtimeWithName = VALID_DOCKERFILE_RUNTIME.replace(
    "USER railfog",
    "USER railfog:railfog",
  );
  const { dir, cleanup } = await createSyntheticInfra({
    control: controlWithUid,
    runtime: runtimeWithName,
    compose: VALID_COMPOSE_YAML,
  });

  try {
    const result = await validatePackagingSpecs(dir);
    assertEquals(result.hasUnprivilegedUser, true);
    assertEquals(result.dockerfileControlValid, true);
    assertEquals(result.dockerfileRuntimeValid, true);
    assertEquals(result.errors, []);
  } finally {
    await cleanup();
  }
});

Deno.test("validatePackagingSpecs - static validator detects missing HEALTHCHECK directive", async () => {
  const noHealthControl = VALID_DOCKERFILE_CONTROL.replace(
    /HEALTHCHECK[^\n]+/,
    "",
  );
  const { dir, cleanup } = await createSyntheticInfra({
    control: noHealthControl,
    runtime: VALID_DOCKERFILE_RUNTIME,
    compose: VALID_COMPOSE_YAML,
  });

  try {
    const result = await validatePackagingSpecs(dir);
    assertFalse(result.hasHealthcheck);
    assertFalse(result.dockerfileControlValid);
    assert(
      result.errors.some((e) => e.includes("missing HEALTHCHECK directive")),
    );
  } finally {
    await cleanup();
  }
});

Deno.test("validatePackagingSpecs - static validator enforces /healthz probe in control HEALTHCHECK (PLAT-1)", async () => {
  const badHealthzControl = VALID_DOCKERFILE_CONTROL.replace(
    "/healthz",
    "/wrong-path",
  );
  const { dir, cleanup } = await createSyntheticInfra({
    control: badHealthzControl,
    runtime: VALID_DOCKERFILE_RUNTIME,
    compose: VALID_COMPOSE_YAML,
  });

  try {
    const result = await validatePackagingSpecs(dir);
    assertFalse(result.dockerfileControlValid);
    assert(
      result.errors.some((e) =>
        e.includes("HEALTHCHECK must probe /healthz per PLAT-1")
      ),
    );
  } finally {
    await cleanup();
  }
});

Deno.test("validatePackagingSpecs - static validator detects wrong EXPOSE port in control Dockerfile", async () => {
  const badPortControl = VALID_DOCKERFILE_CONTROL.replace(
    "EXPOSE 8081",
    "EXPOSE 8080",
  );
  const { dir, cleanup } = await createSyntheticInfra({
    control: badPortControl,
    runtime: VALID_DOCKERFILE_RUNTIME,
    compose: VALID_COMPOSE_YAML,
  });

  try {
    const result = await validatePackagingSpecs(dir);
    assertFalse(result.dockerfileControlValid);
    assert(
      result.errors.some((e) =>
        e.includes(`missing EXPOSE ${CONTROL_PLANE_PORT}`)
      ),
    );
  } finally {
    await cleanup();
  }
});

Deno.test("validatePackagingSpecs - static validator detects wrong EXPOSE port in runtime Dockerfile", async () => {
  const badPortRuntime = VALID_DOCKERFILE_RUNTIME.replace(
    "EXPOSE 8080",
    "EXPOSE 8081",
  );
  const { dir, cleanup } = await createSyntheticInfra({
    control: VALID_DOCKERFILE_CONTROL,
    runtime: badPortRuntime,
    compose: VALID_COMPOSE_YAML,
  });

  try {
    const result = await validatePackagingSpecs(dir);
    assertFalse(result.dockerfileRuntimeValid);
    assert(
      result.errors.some((e) =>
        e.includes(`missing EXPOSE ${DATA_PLANE_PORT}`)
      ),
    );
  } finally {
    await cleanup();
  }
});

Deno.test("validatePackagingSpecs - static validator detects missing internal network in compose", async () => {
  const noNetCompose = VALID_COMPOSE_YAML.replace(
    /networks:[\s\S]*?driver: bridge/,
    "",
  );
  const { dir, cleanup } = await createSyntheticInfra({
    control: VALID_DOCKERFILE_CONTROL,
    runtime: VALID_DOCKERFILE_RUNTIME,
    compose: noNetCompose,
  });

  try {
    const result = await validatePackagingSpecs(dir);
    assertFalse(result.composeConfigValid);
    assert(
      result.errors.some((e) =>
        e.includes("missing top-level 'networks' definition")
      ),
    );
  } finally {
    await cleanup();
  }
});

Deno.test("validatePackagingSpecs - static validator detects missing reference to control plane in runtime compose config", async () => {
  const noLinkCompose = VALID_COMPOSE_YAML.replace(
    "RAILFOG_CONTROL_URL=http://railfog-control:8081",
    "OTHER_VAR=123",
  );
  const { dir, cleanup } = await createSyntheticInfra({
    control: VALID_DOCKERFILE_CONTROL,
    runtime: VALID_DOCKERFILE_RUNTIME,
    compose: noLinkCompose,
  });

  try {
    const result = await validatePackagingSpecs(dir);
    assertFalse(result.composeConfigValid);
    assert(
      result.errors.some((e) => e.includes("must reference 'railfog-control'")),
    );
  } finally {
    await cleanup();
  }
});

Deno.test("validatePackagingSpecs - static validator detects publicly exposed control plane port 8081", async () => {
  const publicControlCompose = VALID_COMPOSE_YAML.replace(
    'expose:\n      - "8081"',
    'ports:\n      - "8081:8081"',
  );
  const { dir, cleanup } = await createSyntheticInfra({
    control: VALID_DOCKERFILE_CONTROL,
    runtime: VALID_DOCKERFILE_RUNTIME,
    compose: publicControlCompose,
  });

  try {
    const result = await validatePackagingSpecs(dir);
    assertFalse(result.composeConfigValid);
    assert(
      result.errors.some((e) => e.includes("must not be publicly exposed")),
    );
  } finally {
    await cleanup();
  }
});

Deno.test("validatePackagingSpecs - static validator detects privileged: true in compose config (PLAT-4)", async () => {
  const privCompose = VALID_COMPOSE_YAML.replace(
    "railfog-runtime:",
    "railfog-runtime:\n    privileged: true",
  );
  const { dir, cleanup } = await createSyntheticInfra({
    control: VALID_DOCKERFILE_CONTROL,
    runtime: VALID_DOCKERFILE_RUNTIME,
    compose: privCompose,
  });

  try {
    const result = await validatePackagingSpecs(dir);
    assertFalse(result.composeConfigValid);
    assert(
      result.errors.some((e) =>
        e.includes("must not run with privileged: true")
      ),
    );
  } finally {
    await cleanup();
  }
});

Deno.test("validatePackagingSpecs - static validator detects missing cap_drop [ALL] in compose config (PLAT-4)", async () => {
  const noCapDropCompose = VALID_COMPOSE_YAML.replace(
    "cap_drop:\n      - ALL",
    "",
  );
  const { dir, cleanup } = await createSyntheticInfra({
    control: VALID_DOCKERFILE_CONTROL,
    runtime: VALID_DOCKERFILE_RUNTIME,
    compose: noCapDropCompose,
  });

  try {
    const result = await validatePackagingSpecs(dir);
    assertFalse(result.composeConfigValid);
    assert(result.errors.some((e) => e.includes("cap_drop: [ALL]")));
  } finally {
    await cleanup();
  }
});

Deno.test("validatePackagingSpecs - static validator detects missing security_opt no-new-privileges in compose config (PLAT-4)", async () => {
  const noSecOptCompose = VALID_COMPOSE_YAML.replace(
    "security_opt:\n      - no-new-privileges:true",
    "",
  );
  const { dir, cleanup } = await createSyntheticInfra({
    control: VALID_DOCKERFILE_CONTROL,
    runtime: VALID_DOCKERFILE_RUNTIME,
    compose: noSecOptCompose,
  });

  try {
    const result = await validatePackagingSpecs(dir);
    assertFalse(result.composeConfigValid);
    assert(
      result.errors.some((e) =>
        e.includes("security_opt with no-new-privileges:true")
      ),
    );
  } finally {
    await cleanup();
  }
});

Deno.test("validatePackagingSpecs - static validator detects root user via 0:0, 0, or root:root in compose config (PLAT-4)", async () => {
  for (const rootUser of ['"0:0"', "0", '"root:root"', '"0"', '"root"']) {
    const rootUserCompose = VALID_COMPOSE_YAML.replace(
      "railfog-runtime:",
      `railfog-runtime:\n    user: ${rootUser}`,
    );
    const { dir, cleanup } = await createSyntheticInfra({
      control: VALID_DOCKERFILE_CONTROL,
      runtime: VALID_DOCKERFILE_RUNTIME,
      compose: rootUserCompose,
    });

    try {
      const result = await validatePackagingSpecs(dir);
      assertFalse(
        result.hasUnprivilegedUser,
        `Expected hasUnprivilegedUser to be false for root user ${rootUser}`,
      );
      assertFalse(
        result.composeConfigValid,
        `Expected composeConfigValid to be false for root user ${rootUser}`,
      );
      assert(
        result.errors.some((e) => e.includes("must not specify root user")),
        `Expected error message for root user ${rootUser}`,
      );
    } finally {
      await cleanup();
    }
  }
});

Deno.test("validatePackagingSpecs - static validator detects security_opt no-new-privileges:false (PLAT-4)", async () => {
  const badSecOptCompose = VALID_COMPOSE_YAML.replace(
    "security_opt:\n      - no-new-privileges:true",
    "security_opt:\n      - no-new-privileges:false",
  );
  const { dir, cleanup } = await createSyntheticInfra({
    control: VALID_DOCKERFILE_CONTROL,
    runtime: VALID_DOCKERFILE_RUNTIME,
    compose: badSecOptCompose,
  });

  try {
    const result = await validatePackagingSpecs(dir);
    assertFalse(result.composeConfigValid);
    assert(
      result.errors.some((e) =>
        e.includes("must not disable no-new-privileges") ||
        e.includes("security_opt with no-new-privileges:true")
      ),
    );
  } finally {
    await cleanup();
  }
});

Deno.test("validatePackagingSpecs - static validator detects forbidden cap_add in compose config (PLAT-4)", async () => {
  const capAddCompose = VALID_COMPOSE_YAML.replace(
    "cap_drop:\n      - ALL",
    "cap_drop:\n      - ALL\n    cap_add:\n      - SYS_ADMIN",
  );
  const { dir, cleanup } = await createSyntheticInfra({
    control: VALID_DOCKERFILE_CONTROL,
    runtime: VALID_DOCKERFILE_RUNTIME,
    compose: capAddCompose,
  });

  try {
    const result = await validatePackagingSpecs(dir);
    assertFalse(result.composeConfigValid);
    assert(
      result.errors.some((e) =>
        e.includes("must not grant capabilities via cap_add")
      ),
    );
  } finally {
    await cleanup();
  }
});

Deno.test("validatePackagingSpecs - static validator detects privileged: 'true' string in compose config (PLAT-4)", async () => {
  const strPrivCompose = VALID_COMPOSE_YAML.replace(
    "railfog-runtime:",
    'railfog-runtime:\n    privileged: "true"',
  );
  const { dir, cleanup } = await createSyntheticInfra({
    control: VALID_DOCKERFILE_CONTROL,
    runtime: VALID_DOCKERFILE_RUNTIME,
    compose: strPrivCompose,
  });

  try {
    const result = await validatePackagingSpecs(dir);
    assertFalse(result.composeConfigValid);
    assert(
      result.errors.some((e) =>
        e.includes("must not run with privileged: true")
      ),
    );
  } finally {
    await cleanup();
  }
});

Deno.test("validatePackagingSpecs - static validator detects missing /healthz in runtime Dockerfile (PLAT-1)", async () => {
  const badHealthzRuntime = VALID_DOCKERFILE_RUNTIME.replace(
    "/healthz",
    "/wrong-path",
  );
  const { dir, cleanup } = await createSyntheticInfra({
    control: VALID_DOCKERFILE_CONTROL,
    runtime: badHealthzRuntime,
    compose: VALID_COMPOSE_YAML,
  });

  try {
    const result = await validatePackagingSpecs(dir);
    assertFalse(result.dockerfileRuntimeValid);
    assert(
      result.errors.some((e) =>
        e.includes("HEALTHCHECK must probe /healthz per PLAT-1")
      ),
    );
  } finally {
    await cleanup();
  }
});

// ============================================================================
// Live Tests against repository infra/ directory
// ============================================================================

const repoRoot = resolve(import.meta.dirname ?? ".", "../..");

Deno.test("Live packaging specs validation against infra/ (T-0603)", async (t) => {
  const infraDir = join(repoRoot, "infra");
  const validation = await validatePackagingSpecs(infraDir);

  await t.step("infra/Dockerfile.control exists and is valid", () => {
    assertEquals(
      validation.dockerfileControlValid,
      true,
      `Control Dockerfile invalid: ${validation.errors.join("; ")}`,
    );
  });

  await t.step("infra/Dockerfile.runtime exists and is valid", () => {
    assertEquals(
      validation.dockerfileRuntimeValid,
      true,
      `Runtime Dockerfile invalid: ${validation.errors.join("; ")}`,
    );
  });

  await t.step("infra/docker-compose.yaml exists and is valid", () => {
    assertEquals(
      validation.composeConfigValid,
      true,
      `Compose config invalid: ${validation.errors.join("; ")}`,
    );
  });

  await t.step("specifies unprivileged user execution (PLAT-4)", () => {
    assertEquals(
      validation.hasUnprivilegedUser,
      true,
      `Unprivileged user check failed: ${validation.errors.join("; ")}`,
    );
  });

  await t.step("specifies container healthchecks (PLAT-1)", () => {
    assertEquals(
      validation.hasHealthcheck,
      true,
      `Healthcheck check failed: ${validation.errors.join("; ")}`,
    );
  });

  await t.step("zero validation errors recorded", () => {
    assertEquals(
      validation.errors,
      [],
      `Expected 0 validation errors, got: ${validation.errors.join("; ")}`,
    );
  });
});
