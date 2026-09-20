import { assert, assertEquals, assertRejects } from "@std/assert";
import { LocalFSProvider } from "../../providers/objects/local-fs-provider.ts";
import { delay } from "@std/async";

Deno.test("LocalFSProvider - put and get round-trip with ArrayBuffer", async () => {
  const dir = await Deno.makeTempDir();
  const provider = new LocalFSProvider(dir);

  const key = "test/file1.txt";
  const data = new TextEncoder().encode("hello world").buffer;

  const { etag } = await provider.put(key, data);
  assert(etag);

  const stream = await provider.get(key);
  assert(stream);

  const reader = stream.getReader();
  const chunks = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }

  const totalLength = chunks.reduce((acc, val) => acc + val.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }

  assertEquals(new TextDecoder().decode(result), "hello world");
});

Deno.test("LocalFSProvider - put and get round-trip with ReadableStream", async () => {
  const dir = await Deno.makeTempDir();
  const provider = new LocalFSProvider(dir);

  const key = "test/file2.txt";
  const data = "hello world stream";
  const streamInput = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(data));
      controller.close();
    },
  });

  const { etag } = await provider.put(key, streamInput);
  assert(etag);

  const stream = await provider.get(key);
  assert(stream);

  const reader = stream.getReader();
  const chunks = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }

  const totalLength = chunks.reduce((acc, val) => acc + val.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }

  assertEquals(new TextDecoder().decode(result), "hello world stream");
});

Deno.test("LocalFSProvider - head returns size and etag", async () => {
  const dir = await Deno.makeTempDir();
  const provider = new LocalFSProvider(dir);

  const key = "test/head.txt";
  const data = new TextEncoder().encode("head content").buffer;

  const putResult = await provider.put(key, data);

  const head = await provider.head(key);
  assert(head);
  assertEquals(head.size, 12);
  assertEquals(head.etag, putResult.etag);

  const missing = await provider.head("missing.txt");
  assertEquals(missing, null);
});

Deno.test("LocalFSProvider - delete removes object", async () => {
  const dir = await Deno.makeTempDir();
  const provider = new LocalFSProvider(dir);

  const key = "test/delete.txt";
  const data = new TextEncoder().encode("delete content").buffer;

  await provider.put(key, data);
  let head = await provider.head(key);
  assert(head);

  await provider.delete(key);
  head = await provider.head(key);
  assertEquals(head, null);

  const stream = await provider.get(key);
  assertEquals(stream, null);
});

Deno.test("LocalFSProvider - list returns keys with pagination", async () => {
  const dir = await Deno.makeTempDir();
  const provider = new LocalFSProvider(dir);

  await provider.put("prefix/a.txt", new Uint8Array([1]).buffer);
  await provider.put("prefix/b.txt", new Uint8Array([2]).buffer);
  await provider.put("prefix/c.txt", new Uint8Array([3]).buffer);
  await provider.put("other/d.txt", new Uint8Array([4]).buffer);

  const page1 = await provider.list("prefix/", { limit: 2 });
  assertEquals(page1.keys, ["prefix/a.txt", "prefix/b.txt"]);
  assert(page1.cursor);

  const page2 = await provider.list("prefix/", {
    limit: 2,
    cursor: page1.cursor,
  });
  assertEquals(page2.keys, ["prefix/c.txt"]);
  assertEquals(page2.cursor, undefined);
});

Deno.test("LocalFSProvider - presign validation when expiresIn > maxExpiresIn", async () => {
  const dir = await Deno.makeTempDir();
  const provider = new LocalFSProvider(dir);

  await assertRejects(
    async () => {
      await provider.presign("test.txt", {
        method: "GET",
        expiresIn: 3600,
        maxExpiresIn: 1800,
      });
    },
    Error,
    "VALIDATION_FAILED",
  );
});

Deno.test("LocalFSProvider - presign returns url and expiresAt, rejects expired", async () => {
  const dir = await Deno.makeTempDir();
  const provider = new LocalFSProvider(dir);

  const { url, expiresAt } = await provider.presign("test.txt", {
    method: "GET",
    expiresIn: 1,
    maxExpiresIn: 3600,
  });
  assert(url);
  assert(expiresAt);

  // provider should have a verifyPresignedUrl method for local testing
  const verify1 = await provider.verifyPresignedUrl(url);
  assertEquals(verify1, true);

  await delay(1500); // 1.5 seconds wait

  const verify2 = await provider.verifyPresignedUrl(url);
  assertEquals(verify2, false);
});

Deno.test("LocalFSProvider - createMultipartUpload returns uploadId", async () => {
  const dir = await Deno.makeTempDir();
  const provider = new LocalFSProvider(dir);

  const res = await provider.createMultipartUpload("big.bin");
  assert(res.uploadId);
});
