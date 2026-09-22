# High-Performance Polyglot Execution with WebAssembly (WASM)

> [!NOTE]
> **Documentation**: [SDK Overview](overview.md) &nbsp;|&nbsp; **Specification**:
> [FN-1 (Function Definition)](../contracts/functions.contract.md#FN-1),
> [PLAT-4 (Compute Isolation)](../contracts/platform.contract.md#PLAT-4)

RailFog functions are executed inside sandboxed V8 execution threads. Because V8
natively implements the WebAssembly Web Standard, you can run high-performance
code compiled from **Rust, C, C++, Go, or Zig** inside any RailFog function with
zero external dependencies and near-native CPU throughput.

---

## 1. When to Use WebAssembly in RailFog

| Workload | JavaScript / TypeScript | WebAssembly (Rust/C/Go) |
| :--- | :--- | :--- |
| **CRUD APIs & Orchestration** | Recommended (fastest DX, typed SDK) | Unnecessary boilerplate |
| **Image / Media Processing** | Slow (CPU intensive) | **Recommended (10x faster)** |
| **Cryptographic Hashing & Proofs** | Limited to Web Crypto APIs | **Recommended (custom algorithms)** |
| **Parsing & AST Analysis** | Moderate | **Recommended (zero GC overhead)** |
| **Embedded AI / ML Inference** | Slow | **Recommended (ONNX / Tinygrad)** |

---

## 2. Minimal Rust to WASM Example

### Step 1: Write Rust Function (`src/lib.rs`)

```rust
#[no_mangle]
pub extern "C" fn fibonacci(n: u32) -> u32 {
    match n {
        0 => 0,
        1 => 1,
        _ => fibonacci(n - 1) + fibonacci(n - 2),
    }
}

#[no_mangle]
pub extern "C" fn add(a: i32, b: i32) -> i32 {
    a + b
}
```

Compile to standalone WebAssembly:

```bash
cargo build --target wasm32-unknown-unknown --release
cp target/wasm32-unknown-unknown/release/math.wasm functions/math.wasm
```

---

## 3. Invoking WASM from `@railfog/sdk`

```typescript
import { handle } from "@railfog/sdk";

// Instantiated once when the warm isolate initializes
const wasmCode = await Deno.readFile(new URL("./math.wasm", import.meta.url));
const wasmModule = await WebAssembly.compile(wasmCode);
const instance = await WebAssembly.instantiate(wasmModule);

const { add, fibonacci } = instance.exports as {
  add: (a: number, b: number) => number;
  fibonacci: (n: number) => number;
};

export default handle(({ query, json, notFound }) => {
  const n = Number(query.n);
  if (isNaN(n) || n < 0) {
    notFound("Invalid query param 'n'");
  }

  const result = fibonacci(n);
  return json({ n, result });
});
```

---

## 4. Zero-Overhead Memory Sharing

For large binary datasets (e.g. image filters, audio transcoding), pass pointers
and write directly to `instance.exports.memory.buffer` using `Uint8Array`,
avoiding JSON serialization overhead.
