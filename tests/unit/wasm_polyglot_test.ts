// spec: contracts/functions.contract.md#FN-1 — WebAssembly polyglot execution in functions
// spec: contracts/platform.contract.md#PLAT-4 — Sandbox execution

import { assertEquals } from "@std/assert";
import { createMockContext, handle } from "@railfog/sdk";

// Valid WebAssembly binary module exporting add(i32, i32) -> i32
const WASM_ADD_MODULE = new Uint8Array([
  0x00,
  0x61,
  0x73,
  0x6d,
  0x01,
  0x00,
  0x00,
  0x00, // \0asm v1
  0x01,
  0x07,
  0x01,
  0x60,
  0x02,
  0x7f,
  0x7f,
  0x01,
  0x7f, // Type: (i32, i32) -> i32
  0x03,
  0x02,
  0x01,
  0x00, // Function index 0 uses Type 0
  0x07,
  0x07,
  0x01,
  0x03,
  0x61,
  0x64,
  0x64,
  0x00,
  0x00, // Export "add"
  0x0a,
  0x09,
  0x01,
  0x07,
  0x00,
  0x20,
  0x00,
  0x20,
  0x01,
  0x6a,
  0x0b, // Code: local.get 0, local.get 1, i32.add
]);

Deno.test("FN-1 / PLAT-4: WebAssembly polyglot execution inside handle()", async () => {
  const wasmModule = await WebAssembly.compile(WASM_ADD_MODULE);
  const instance = await WebAssembly.instantiate(wasmModule);
  const { add } = instance.exports as { add: (a: number, b: number) => number };

  const handler = handle(({ query, json }) => {
    const a = Number(query.a ?? 5);
    const b = Number(query.b ?? 10);
    const sum = add(a, b);
    return json({ ok: true, sum, engine: "wasm" });
  });

  const ctx = createMockContext();
  const req = new Request("https://edge.railfog.net/api/math?a=40&b=2");
  const res = await handler(req, ctx);

  assertEquals(res.status, 200);
  const data = await res.json();
  assertEquals(data, { ok: true, sum: 42, engine: "wasm" });
});
