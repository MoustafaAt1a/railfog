// spec: contracts/functions.contract.md#FN-1 — Definition & handler signature
// spec: contracts/functions.contract.md#FN-2 — Unified triggers (no fifth primitive)
// spec: contracts/functions.contract.md#FN-4 — RailFogContext injection surface
// spec: contracts/functions.contract.md#FN-5 — Resource limits MVP defaults
// spec: contracts/platform.contract.md#PLAT-19 — Repository structure: primitives/functions
// spec: tasks/milestone-0.7-repo-consolidation/T-0705-functions-primitive-definitions.md

import { assert, assertEquals } from "@std/assert";
import {
  calculateTimeRemaining,
  DEFAULT_FUNCTION_LIMITS,
  type EnvBinding,
  type FunctionHandler,
  type FunctionLimits,
  type HttpTriggerConfig,
  type QueueTriggerConfig,
  type RailFogContext,
  type ScheduleTriggerConfig,
  type TriggerDefinition,
  type WebhookTriggerConfig,
} from "@railfog/primitives/functions";
import type { KVBinding } from "../../sdk/typescript/types.ts";
import type { ObjectBinding } from "../../sdk/typescript/types.ts";
import type { QueueBinding } from "../../sdk/typescript/types.ts";

Deno.test("T-0705: FunctionHandler executes with standard Request and RailFogContext (FN-1)", async () => {
  const handler: FunctionHandler = async (req, ctx) => {
    const _body = await req.text();
    const url = new URL(req.url);
    const remaining = ctx.timeRemaining();
    return new Response(
      JSON.stringify({
        path: url.pathname,
        requestId: ctx.requestId,
        remaining,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  const mockKv = {} as KVBinding;
  const mockObjects = {} as ObjectBinding;
  const mockQueues = {} as QueueBinding;
  const mockEnv: EnvBinding = {
    get: (key: string) => (key === "API_KEY" ? "secret-123" : undefined),
    has: (key: string) => key === "API_KEY",
  };

  const deadline = Date.now() + 5000;
  const ctx: RailFogContext = {
    requestId: "01J8Z9W6T8NGR6S00000000000",
    project: "proj_01",
    function: "hello",
    revision: "rev_01",
    deadline,
    timeRemaining: () => calculateTimeRemaining(deadline),
    kv: mockKv,
    objects: mockObjects,
    queues: mockQueues,
    env: mockEnv,
  };

  const req = new Request("https://example.com/hello");
  const res = await handler(req, ctx);

  assertEquals(res.status, 200);
  const data = await res.json();
  assertEquals(data.path, "/hello");
  assertEquals(data.requestId, "01J8Z9W6T8NGR6S00000000000");
  assert(data.remaining > 0 && data.remaining <= 5000);
});

Deno.test("T-0705: TriggerDefinition represents unified triggers without separate workers (FN-2)", () => {
  const httpTrigger: HttpTriggerConfig = { type: "http", route: "/api/users" };
  const queueTrigger: QueueTriggerConfig = {
    type: "queue",
    queueName: "jobs",
    batchSize: 10,
  };
  const scheduleTrigger: ScheduleTriggerConfig = {
    type: "schedule",
    cron: "*/5 * * * *",
  };
  const webhookTrigger: WebhookTriggerConfig = {
    type: "webhook",
    endpoint: "/webhook/stripe",
  };

  const triggers: TriggerDefinition[] = [
    httpTrigger,
    queueTrigger,
    scheduleTrigger,
    webhookTrigger,
  ];

  assertEquals(triggers.length, 4);
  assertEquals(triggers[0].type, "http");
  assertEquals(triggers[1].type, "queue");
  assertEquals(triggers[2].type, "schedule");
  assertEquals(triggers[3].type, "webhook");
});

Deno.test("T-0705: RailFogContext timeRemaining calculates deadline and clamps to zero (FN-4)", () => {
  // Future deadline
  const futureDeadline = Date.now() + 10_000;
  const remainingFuture = calculateTimeRemaining(futureDeadline);
  assert(remainingFuture > 9000 && remainingFuture <= 10_000);

  // Past deadline
  const pastDeadline = Date.now() - 5000;
  const remainingPast = calculateTimeRemaining(pastDeadline);
  assertEquals(remainingPast, 0);
});

Deno.test("T-0705: DEFAULT_FUNCTION_LIMITS conforms to FN-5 resource limits specification", () => {
  const limits: FunctionLimits = DEFAULT_FUNCTION_LIMITS;

  assertEquals(limits.cpuMs, 200);
  assertEquals(limits.timeoutMs, 30_000);
  assertEquals(limits.memoryMb, 128);
  assertEquals(limits.concurrency, 50);
});
