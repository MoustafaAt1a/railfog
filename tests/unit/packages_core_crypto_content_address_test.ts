import { assertEquals } from "@std/assert";
import {
  computeArtifactId,
  computeIntegrity,
} from "../../packages/core/crypto/content-address.ts";
import { encodeHex } from "@std/encoding/hex";
import { encodeBase64 } from "@std/encoding/base64";
import { crypto } from "@std/crypto";

Deno.test("content-address - computeArtifactId returns sha256 hex string", async () => {
  const data = new TextEncoder().encode("hello world");
  const expectedHash = await crypto.subtle.digest("SHA-256", data);
  const expectedHex = "sha256:" + encodeHex(expectedHash);

  const result = await computeArtifactId(data);
  assertEquals(result, expectedHex);
});

Deno.test("content-address - computeIntegrity returns sha256 base64 string", async () => {
  const data = new TextEncoder().encode("hello world");
  const expectedHash = await crypto.subtle.digest("SHA-256", data);
  const expectedBase64 = "sha256-" + encodeBase64(expectedHash);

  const result = await computeIntegrity(data);
  assertEquals(result, expectedBase64);
});
