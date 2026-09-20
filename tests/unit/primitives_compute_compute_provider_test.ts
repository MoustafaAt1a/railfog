import { assertEquals, assertExists } from "@std/assert";
import type {
  Artifact,
  ComputeProvider,
  ExecutionResult,
  InvocationRequest,
  IsolationProvider,
  Limits,
} from "../../primitives/compute/compute-provider.ts";

/**
 * Task T-0201: ComputeProvider and IsolationProvider Interface Tests
 * Spec references: PLAT-4, PLAT-16, FN-5, OBJ-4
 */

Deno.test("AC1 & AC2: ComputeProvider conforming mock implementation and Limits validation", async () => {
  // AC2: Limits instantiated with MVP defaults from FN-5
  const limits: Limits = {
    cpuMs: 200,
    timeoutMs: 30000,
    memoryMb: 128,
    concurrency: 50,
  };

  // Limits with optional concurrency omitted
  const minimalLimits: Limits = {
    cpuMs: 200,
    timeoutMs: 30000,
    memoryMb: 128,
  };

  assertEquals(limits.cpuMs, 200);
  assertEquals(limits.timeoutMs, 30000);
  assertEquals(limits.memoryMb, 128);
  assertEquals(limits.concurrency, 50);
  assertEquals(minimalLimits.concurrency, undefined);

  // AC3: Artifact interface per OBJ-4
  const artifactBytes: Artifact = {
    id:
      "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    integrity: "sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=",
    entrypoint: "api.ts",
    code: new Uint8Array([1, 2, 3]),
  };

  const artifactStream: Artifact = {
    id:
      "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    integrity: "sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=",
    entrypoint: "api.ts",
    code: new ReadableStream<Uint8Array>(),
  };

  assertExists(artifactBytes.id);
  assertExists(artifactStream.integrity);

  // AC1: Mock ComputeProvider
  class MockComputeProvider implements ComputeProvider {
    run(artifact: Artifact, limits: Limits): Promise<ExecutionResult> {
      const result: ExecutionResult = {
        statusCode: 200,
        headers: { "content-type": "application/json" },
        body: new Uint8Array([123, 125]),
        cpuTimeMs: 12,
        wallClockMs: 25,
      };
      // Verify limits and artifact can be read without type errors
      if (limits.cpuMs > 0 && artifact.id.startsWith("sha256:")) {
        return Promise.resolve(result);
      }
      return Promise.resolve(result);
    }
  }

  const computeProvider: ComputeProvider = new MockComputeProvider();
  const res = await computeProvider.run(artifactBytes, limits);

  assertEquals(res.statusCode, 200);
  assertEquals(res.headers["content-type"], "application/json");
  assertEquals(res.body, new Uint8Array([123, 125]));
  assertEquals(res.cpuTimeMs, 12);
  assertEquals(res.wallClockMs, 25);
});

Deno.test("AC1: IsolationProvider conforming mock implementation", async () => {
  const limits: Limits = {
    cpuMs: 200,
    timeoutMs: 30000,
    memoryMb: 128,
  };

  const artifact: Artifact = {
    id:
      "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    integrity: "sha256-ASNFZ458467475846748574895748957489=",
    entrypoint: "index.ts",
    code: new Uint8Array(),
  };

  class MockIsolationProvider implements IsolationProvider {
    run(_artifact: Artifact, _limits: Limits): Promise<ExecutionResult> {
      return Promise.resolve({
        statusCode: 204,
        headers: {},
        body: new Uint8Array(0),
        cpuTimeMs: 5,
        wallClockMs: 10,
      });
    }
  }

  const isolationProvider: IsolationProvider = new MockIsolationProvider();
  const result = await isolationProvider.run(artifact, limits);
  assertEquals(result.statusCode, 204);
  assertEquals(result.cpuTimeMs, 5);
  assertEquals(result.wallClockMs, 10);
});

Deno.test("Security: Interface signatures expose no direct host filesystem, process, or ambient credentials (PLAT-4, PLAT-16)", () => {
  // Verify Artifact structure relies strictly on content addressing and byte stream/buffer
  const sampleArtifact: Artifact = {
    id: "sha256:test",
    integrity: "sha256-test",
    entrypoint: "api.ts",
    code: new Uint8Array(),
  };

  const artifactKeys = Object.keys(sampleArtifact).sort();
  assertEquals(artifactKeys, ["code", "entrypoint", "id", "integrity"]);

  // Verify Limits structure contains strictly numerical resource boundaries
  const sampleLimits: Limits = {
    cpuMs: 200,
    timeoutMs: 30000,
    memoryMb: 128,
    concurrency: 50,
  };

  const limitKeys = Object.keys(sampleLimits).sort();
  assertEquals(limitKeys, ["concurrency", "cpuMs", "memoryMb", "timeoutMs"]);

  // Verify ExecutionResult contains strictly isolated HTTP response elements and metric measurements
  const sampleResult: ExecutionResult = {
    statusCode: 200,
    headers: {},
    body: new Uint8Array(),
    cpuTimeMs: 1,
    wallClockMs: 2,
  };

  const resultKeys = Object.keys(sampleResult).sort();
  assertEquals(resultKeys, [
    "body",
    "cpuTimeMs",
    "headers",
    "statusCode",
    "wallClockMs",
  ]);

  // Static type check: Assert that no host-ambient or process primitives exist on interfaces
  type DisallowedHostKeys =
    | "pid"
    | "fs"
    | "filePath"
    | "hostPath"
    | "env"
    | "credentials"
    | "token"
    | "socket";

  type AssertNoDisallowed<T, K extends string> = K extends keyof T ? never
    : true;

  const _artifactSafe: AssertNoDisallowed<Artifact, DisallowedHostKeys> = true;
  const _limitsSafe: AssertNoDisallowed<Limits, DisallowedHostKeys> = true;
  const _resultSafe: AssertNoDisallowed<ExecutionResult, DisallowedHostKeys> =
    true;
  assertEquals(_artifactSafe && _limitsSafe && _resultSafe, true);
});

Deno.test("Adversarial PLAT-4/PLAT-16: Artifact.code rejects host filesystem paths, file descriptors, and OS handles", () => {
  type NotAssignable<T, U> = [T] extends [U] ? false : true;

  // Attempt to assign string file path (e.g. "/etc/passwd" or "C:\\Windows\\win.ini")
  const stringNotAssignable: NotAssignable<string, Artifact["code"]> = true;
  // Attempt to assign integer file descriptor (e.g. 0, 1, 2, 3)
  const numberNotAssignable: NotAssignable<number, Artifact["code"]> = true;
  // Attempt to assign Deno.FsFile or file system handles
  const fsFileNotAssignable: NotAssignable<Deno.FsFile, Artifact["code"]> =
    true;
  // Attempt to assign string stream instead of byte stream
  const stringStreamNotAssignable: NotAssignable<
    ReadableStream<string>,
    Artifact["code"]
  > = true;

  assertEquals(stringNotAssignable, true);
  assertEquals(numberNotAssignable, true);
  assertEquals(fsFileNotAssignable, true);
  assertEquals(stringStreamNotAssignable, true);
});

Deno.test("Adversarial PLAT-4/FN-5: Limits and Artifact reject ambient process, cwd, env, and credentials", () => {
  type NotAssignable<T, U> = [T] extends [U] ? false : true;

  // Limits cannot accept ambient host process spawn or environment fields
  const noCwd: NotAssignable<{ cwd: string }, Limits> = true;
  const noEnv: NotAssignable<{ env: Record<string, string> }, Limits> = true;
  const noPid: NotAssignable<{ pid: number }, Limits> = true;
  const noUid: NotAssignable<{ uid: number }, Limits> = true;
  const noGid: NotAssignable<{ gid: number }, Limits> = true;
  const noShell: NotAssignable<{ shell: string }, Limits> = true;
  const noToken: NotAssignable<{ token: string }, Limits> = true;
  const noCredentials: NotAssignable<{ credentials: unknown }, Limits> = true;

  // Artifact cannot accept host file paths or file descriptors
  const noFilePath: NotAssignable<{ filePath: string }, Artifact> = true;
  const noFd: NotAssignable<{ fd: number }, Artifact> = true;
  const noHostPath: NotAssignable<{ hostPath: string }, Artifact> = true;

  assertEquals(
    noCwd && noEnv && noPid && noUid && noGid && noShell && noToken &&
      noCredentials,
    true,
  );
  assertEquals(noFilePath && noFd && noHostPath, true);
});

Deno.test("Adversarial PLAT-4/PLAT-16: ExecutionResult bounds HTTP response without leaking host process handles or signals", () => {
  type NotAssignable<T, U> = [T] extends [U] ? false : true;

  // ExecutionResult cannot leak host process metadata, exit signals, or unmanaged stderr
  const noResultPid: NotAssignable<ExecutionResult, { pid: number }> = true;
  const noResultExitCode: NotAssignable<ExecutionResult, { exitCode: number }> =
    true;
  const noResultSignal: NotAssignable<ExecutionResult, { signal: string }> =
    true;
  const noResultEnv: NotAssignable<
    ExecutionResult,
    { env: Record<string, string> }
  > = true;
  const noResultFs: NotAssignable<ExecutionResult, { fs: unknown }> = true;
  const noResultStderr: NotAssignable<ExecutionResult, { stderr: string }> =
    true;

  assertEquals(
    noResultPid && noResultExitCode && noResultSignal && noResultEnv &&
      noResultFs && noResultStderr,
    true,
  );
});

Deno.test("Adversarial PLAT-16: Provider signatures strictly reject ambient parameter smuggling", () => {
  type ComputeParams = Parameters<ComputeProvider["run"]>;
  type IsolationParams = Parameters<IsolationProvider["run"]>;

  type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends
    (<T>() => T extends Y ? 1 : 2) ? true : false;
  type NotAssignable<T, U> = [T] extends [U] ? false : true;

  // Both run() signatures accept 2 to 3 arguments: (artifact, limits, invocation?)
  const computeArgCountValid: Equal<ComputeParams["length"], 2 | 3> = true;
  const isolationArgCountValid: Equal<IsolationParams["length"], 2 | 3> = true;

  // Parameter 0 must be Artifact
  const computeParam0Valid: Equal<ComputeParams[0], Artifact> = true;
  const isolationParam0Valid: Equal<IsolationParams[0], Artifact> = true;

  // Parameter 1 must be Limits
  const computeParam1Valid: Equal<ComputeParams[1], Limits> = true;
  const isolationParam1Valid: Equal<IsolationParams[1], Limits> = true;

  // Parameter 2 must be optional InvocationRequest (InvocationRequest | undefined)
  const computeParam2Valid: Equal<
    ComputeParams[2],
    InvocationRequest | undefined
  > = true;
  const isolationParam2Valid: Equal<
    IsolationParams[2],
    InvocationRequest | undefined
  > = true;

  // Both run() signatures accept 2 to 3 arguments: (artifact, limits, invocation?)
  // By requiring length to strictly equal (2 | 3), 4+ parameters are statically impossible
  // 3rd parameter position must reject ambient host objects
  const noSmuggledEnvCompute: NotAssignable<
    { env: Record<string, string> },
    ComputeParams[2]
  > = true;
  const noSmuggledPidCompute: NotAssignable<
    { pid: number },
    ComputeParams[2]
  > = true;
  const noSmuggledCredsCompute: NotAssignable<
    { credentials: unknown },
    ComputeParams[2]
  > = true;
  const noSmuggledFsCompute: NotAssignable<
    Deno.FsFile,
    ComputeParams[2]
  > = true;

  const noSmuggledEnvIso: NotAssignable<
    { env: Record<string, string> },
    IsolationParams[2]
  > = true;
  const noSmuggledPidIso: NotAssignable<
    { pid: number },
    IsolationParams[2]
  > = true;
  const noSmuggledCredsIso: NotAssignable<
    { credentials: unknown },
    IsolationParams[2]
  > = true;
  const noSmuggledFsIso: NotAssignable<
    Deno.FsFile,
    IsolationParams[2]
  > = true;

  // Provider interfaces must not expose ambient configuration or execution methods
  type ComputeMethods = keyof ComputeProvider;
  type IsolationMethods = keyof IsolationProvider;

  const computeOnlyRun: Equal<ComputeMethods, "run"> = true;
  const isolationOnlyRun: Equal<IsolationMethods, "run"> = true;

  assertEquals(
    computeArgCountValid &&
      isolationArgCountValid &&
      computeParam0Valid &&
      isolationParam0Valid &&
      computeParam1Valid &&
      isolationParam1Valid &&
      computeParam2Valid &&
      isolationParam2Valid &&
      noSmuggledEnvCompute &&
      noSmuggledPidCompute &&
      noSmuggledCredsCompute &&
      noSmuggledFsCompute &&
      noSmuggledEnvIso &&
      noSmuggledPidIso &&
      noSmuggledCredsIso &&
      noSmuggledFsIso,
    true,
  );
  assertEquals(computeOnlyRun && isolationOnlyRun, true);
});

Deno.test("Adversarial PLAT-4: Artifact stream consumption enforces pure in-memory chunking without host FS dependency", async () => {
  // Verify stream-based artifact can be fully processed in isolation without filesystem access
  const chunk1 = new Uint8Array([101, 120, 112, 111, 114, 116]);
  const chunk2 = new Uint8Array([32, 100, 101, 102, 97, 117, 108, 116]);

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(chunk1);
      controller.enqueue(chunk2);
      controller.close();
    },
  });

  const artifact: Artifact = {
    id:
      "sha256:streamtest0123456789abcdef0123456789abcdef0123456789abcdef01234567",
    integrity: "sha256-streamtestintegrityhashvalue1234567890=",
    entrypoint: "entry.ts",
    code: stream,
  };

  const limits: Limits = {
    cpuMs: 100,
    timeoutMs: 5000,
    memoryMb: 64,
  };

  class StreamConsumingProvider implements ComputeProvider {
    async run(art: Artifact, lim: Limits): Promise<ExecutionResult> {
      let totalBytes = 0;
      if (art.code instanceof ReadableStream) {
        const reader = art.code.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          totalBytes += value.byteLength;
        }
      } else {
        totalBytes = art.code.byteLength;
      }

      return {
        statusCode: 200,
        headers: { "content-length": String(totalBytes) },
        body: new Uint8Array([totalBytes]),
        cpuTimeMs: 1,
        wallClockMs: lim.timeoutMs > 0 ? 3 : 0,
      };
    }
  }

  const provider = new StreamConsumingProvider();
  const res = await provider.run(artifact, limits);
  assertEquals(res.statusCode, 200);
  assertEquals(res.headers["content-length"], "14");
  assertEquals(res.body, new Uint8Array([14]));
});

/**
 * Task T-0301: InvocationRequest Interface Extension and Isolation Boundary Tests
 * Spec references: PLAT-4, PLAT-16, ADR-0001
 */

Deno.test("T-0301 AC1: InvocationRequest interface structure and ComputeProvider / IsolationProvider acceptance", async () => {
  const artifact: Artifact = {
    id:
      "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    integrity: "sha256-ASNFZ458467475846748574895748957489=",
    entrypoint: "index.ts",
    code: new Uint8Array([101, 99, 104, 111]),
  };

  const limits: Limits = {
    cpuMs: 100,
    timeoutMs: 5000,
    memoryMb: 64,
  };

  // Full InvocationRequest per ADR-0001
  const fullInvocation: InvocationRequest = {
    requestId: "req_01J8Z000000000000000000000",
    method: "POST",
    url: "https://example.com/api/v1/resource",
    headers: {
      "content-type": "application/json",
      "x-custom-header": "test-value",
    },
    body: new Uint8Array([1, 2, 3, 4]),
  };

  assertEquals(fullInvocation.requestId, "req_01J8Z000000000000000000000");
  assertEquals(fullInvocation.method, "POST");
  assertEquals(fullInvocation.url, "https://example.com/api/v1/resource");
  assertEquals(fullInvocation.headers?.["content-type"], "application/json");
  assertEquals(fullInvocation.headers?.["x-custom-header"], "test-value");
  assertEquals(fullInvocation.body, new Uint8Array([1, 2, 3, 4]));

  // Minimal InvocationRequest (only requestId is required)
  const minimalInvocation: InvocationRequest = {
    requestId: "req_minimal_01J8Z",
  };
  assertEquals(minimalInvocation.requestId, "req_minimal_01J8Z");
  assertEquals(minimalInvocation.method, undefined);
  assertEquals(minimalInvocation.url, undefined);
  assertEquals(minimalInvocation.headers, undefined);
  assertEquals(minimalInvocation.body, undefined);

  // ComputeProvider conforming implementation accepting invocation?: InvocationRequest
  class ConformingComputeProvider implements ComputeProvider {
    run(
      _artifact: Artifact,
      _limits: Limits,
      invocation?: InvocationRequest,
    ): Promise<ExecutionResult> {
      return Promise.resolve({
        statusCode: 200,
        headers: { "x-request-id": invocation?.requestId ?? "missing" },
        body: invocation?.body ?? new Uint8Array(0),
        cpuTimeMs: 10,
        wallClockMs: 20,
      });
    }
  }

  const computeProvider: ComputeProvider = new ConformingComputeProvider();
  const computeRes = await computeProvider.run(
    artifact,
    limits,
    fullInvocation,
  );
  assertEquals(computeRes.statusCode, 200);
  assertEquals(
    computeRes.headers["x-request-id"],
    "req_01J8Z000000000000000000000",
  );
  assertEquals(computeRes.body, new Uint8Array([1, 2, 3, 4]));

  // IsolationProvider conforming implementation accepting invocation?: InvocationRequest
  class ConformingIsolationProvider implements IsolationProvider {
    run(
      _artifact: Artifact,
      _limits: Limits,
      invocation?: InvocationRequest,
    ): Promise<ExecutionResult> {
      return Promise.resolve({
        statusCode: 200,
        headers: {
          "x-echo-method": invocation?.method ?? "GET",
          "x-request-id": invocation?.requestId ?? "missing",
        },
        body: invocation?.body ?? new Uint8Array(0),
        cpuTimeMs: 5,
        wallClockMs: 12,
      });
    }
  }

  const isolationProvider: IsolationProvider =
    new ConformingIsolationProvider();
  const isolationRes = await isolationProvider.run(
    artifact,
    limits,
    fullInvocation,
  );
  assertEquals(isolationRes.statusCode, 200);
  assertEquals(isolationRes.headers["x-echo-method"], "POST");
  assertEquals(
    isolationRes.headers["x-request-id"],
    "req_01J8Z000000000000000000000",
  );
  assertEquals(isolationRes.body, new Uint8Array([1, 2, 3, 4]));
});

Deno.test("T-0301 AC2: Backward compatibility when invocation is omitted, defaulting safely to empty GET per ADR-0001", async () => {
  const artifact: Artifact = {
    id:
      "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    integrity: "sha256-ASNFZ458467475846748574895748957489=",
    entrypoint: "index.ts",
    code: new Uint8Array([1]),
  };

  const limits: Limits = {
    cpuMs: 200,
    timeoutMs: 30000,
    memoryMb: 128,
  };

  class DefaultingIsolationProvider implements IsolationProvider {
    recordedMethod?: string;
    recordedBodyLength?: number;

    run(
      _artifact: Artifact,
      _limits: Limits,
      invocation?: InvocationRequest,
    ): Promise<ExecutionResult> {
      // Per ADR-0001: When invocation is omitted or method unspecified, default to empty GET
      const effectiveMethod = invocation?.method ?? "GET";
      const effectiveBody = invocation?.body ?? new Uint8Array(0);
      this.recordedMethod = effectiveMethod;
      this.recordedBodyLength = effectiveBody.byteLength;

      return Promise.resolve({
        statusCode: 200,
        headers: { "x-method": effectiveMethod },
        body: effectiveBody,
        cpuTimeMs: 2,
        wallClockMs: 5,
      });
    }
  }

  const provider: IsolationProvider = new DefaultingIsolationProvider();

  // Backward compatibility: 2 arguments only (invocation omitted)
  const resTwoArgs = await provider.run(artifact, limits);
  assertEquals(resTwoArgs.statusCode, 200);
  assertEquals(resTwoArgs.headers["x-method"], "GET");
  assertEquals(resTwoArgs.body.byteLength, 0);

  // Backward compatibility: explicit undefined as 3rd argument
  const resUndefinedArg = await provider.run(artifact, limits, undefined);
  assertEquals(resUndefinedArg.statusCode, 200);
  assertEquals(resUndefinedArg.headers["x-method"], "GET");
  assertEquals(resUndefinedArg.body.byteLength, 0);

  // Partial invocation: method omitted defaults to GET
  const partialInvocation: InvocationRequest = {
    requestId: "req_no_method_01J8Z",
  };
  const resPartial = await provider.run(artifact, limits, partialInvocation);
  assertEquals(resPartial.statusCode, 200);
  assertEquals(resPartial.headers["x-method"], "GET");
  assertEquals(resPartial.body.byteLength, 0);

  // Existing 2-argument implementation continues to satisfy ComputeProvider and IsolationProvider interfaces
  class ExistingTwoArgComputeProvider implements ComputeProvider {
    run(_art: Artifact, _lim: Limits): Promise<ExecutionResult> {
      return Promise.resolve({
        statusCode: 200,
        headers: {},
        body: new Uint8Array(0),
        cpuTimeMs: 1,
        wallClockMs: 1,
      });
    }
  }

  const existingCompute: ComputeProvider = new ExistingTwoArgComputeProvider();
  const existingRes = await existingCompute.run(artifact, limits);
  assertEquals(existingRes.statusCode, 200);
});

Deno.test("T-0301 AC3 & Security: InvocationRequest strictly rejects host paths, process handles, ambient credentials, env, tokens, and sockets (PLAT-4, PLAT-16)", () => {
  // Runtime property key verification on fully populated InvocationRequest
  const sampleInvocation: InvocationRequest = {
    requestId: "req_test_01J8Z",
    method: "GET",
    url: "https://example.com/test",
    headers: { "accept": "application/json" },
    body: new Uint8Array([0]),
  };

  const invocationKeys = Object.keys(sampleInvocation).sort();
  assertEquals(invocationKeys, [
    "body",
    "headers",
    "method",
    "requestId",
    "url",
  ]);

  // Static type check: Disallow host-ambient and OS-level keys on InvocationRequest
  type DisallowedInvocationKeys =
    | "pid"
    | "fs"
    | "filePath"
    | "hostPath"
    | "env"
    | "credentials"
    | "token"
    | "socket"
    | "cwd"
    | "shell"
    | "uid"
    | "gid"
    | "process"
    | "fd";

  type AssertNoDisallowed<T, K extends string> = K extends keyof T ? never
    : true;

  const _invocationSafe: AssertNoDisallowed<
    InvocationRequest,
    DisallowedInvocationKeys
  > = true;
  assertEquals(_invocationSafe, true);

  // Static adversarial assignability: Ensure InvocationRequest rejects ambient smuggling
  type NotAssignable<T, U> = [T] extends [U] ? false : true;

  const noHostPath: NotAssignable<{ hostPath: string }, InvocationRequest> =
    true;
  const noFilePath: NotAssignable<{ filePath: string }, InvocationRequest> =
    true;
  const noPid: NotAssignable<{ pid: number }, InvocationRequest> = true;
  const noProcess: NotAssignable<{ process: unknown }, InvocationRequest> =
    true;
  const noEnv: NotAssignable<
    { env: Record<string, string> },
    InvocationRequest
  > = true;
  const noCredentials: NotAssignable<
    { credentials: unknown },
    InvocationRequest
  > = true;
  const noToken: NotAssignable<{ token: string }, InvocationRequest> = true;
  const noSocket: NotAssignable<{ socket: unknown }, InvocationRequest> = true;
  const noFs: NotAssignable<{ fs: unknown }, InvocationRequest> = true;
  const noCwd: NotAssignable<{ cwd: string }, InvocationRequest> = true;
  const noFd: NotAssignable<{ fd: number }, InvocationRequest> = true;

  // InvocationRequest.body rejects host-level file descriptors, streams, and strings
  const noStringBody: NotAssignable<string, InvocationRequest["body"]> = true;
  const noFdBody: NotAssignable<number, InvocationRequest["body"]> = true;
  const noFsFileBody: NotAssignable<Deno.FsFile, InvocationRequest["body"]> =
    true;
  const noStreamBody: NotAssignable<
    ReadableStream<Uint8Array>,
    InvocationRequest["body"]
  > = true;

  assertEquals(
    noHostPath &&
      noFilePath &&
      noPid &&
      noProcess &&
      noEnv &&
      noCredentials &&
      noToken &&
      noSocket &&
      noFs &&
      noCwd &&
      noFd &&
      noStringBody &&
      noFdBody &&
      noFsFileBody &&
      noStreamBody,
    true,
  );
});
