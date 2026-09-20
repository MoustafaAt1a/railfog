/**
 * Content Addressing Helpers
 * Spec-anchor: docs/contracts/objects.contract.md OBJ-4 (Content addressing)
 */

import { encodeHex } from "@std/encoding/hex";
import { encodeBase64 } from "@std/encoding/base64";
import { crypto } from "@std/crypto";

export async function computeSha256(
  data: Uint8Array | ArrayBuffer,
): Promise<Uint8Array> {
  const hash = await crypto.subtle.digest("SHA-256", data as BufferSource);
  return new Uint8Array(hash);
}

export async function computeArtifactId(
  data: Uint8Array | ArrayBuffer,
): Promise<string> {
  const hash = await computeSha256(data);
  return "sha256:" + encodeHex(hash);
}

export async function computeIntegrity(
  data: Uint8Array | ArrayBuffer,
): Promise<string> {
  const hash = await computeSha256(data);
  return "sha256-" + encodeBase64(hash);
}
