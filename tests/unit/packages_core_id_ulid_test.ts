import { assert, assertEquals, assertFalse } from "@std/assert";
import { generateUlid, isValidUlid } from "../../packages/core/id/ulid.ts";

Deno.test("generateUlid - sorts lexicographically by time", () => {
  let time = 1694611200000;
  const mockNow = () => time;
  // 80 bits = 10 bytes
  const mockRandom = () => new Uint8Array(10).fill(0);

  const ulid1 = generateUlid(mockNow, mockRandom);
  time += 1; // 1 ms later
  const ulid2 = generateUlid(mockNow, mockRandom);

  assert(ulid2 > ulid1, `Expected ${ulid2} to sort after ${ulid1}`);
});

Deno.test("generateUlid - length and Crockford Base32 alphabet", () => {
  const ulid = generateUlid();
  assertEquals(ulid.length, 26);

  // Crockford Base32 alphabet (no I, L, O, U)
  assert(
    /^[0-9A-HJKMNP-TV-Z]{26}$/.test(ulid),
    `ULID ${ulid} is not valid Crockford Base32`,
  );
});

Deno.test("isValidUlid - valid ULID returns true", () => {
  const mockNow = () => 1694611200000;
  const mockRandom = () => new Uint8Array(10).fill(255);
  const ulid = generateUlid(mockNow, mockRandom);

  assert(isValidUlid(ulid), `Expected ${ulid} to be valid`);
});

Deno.test("isValidUlid - boundary and malformed cases", () => {
  // Empty
  assertFalse(isValidUlid(""));
  // Too short
  assertFalse(isValidUlid("01HGW2K8"));
  // Too long
  assertFalse(isValidUlid("01HGW2K89012345678901234567"));
  // Invalid chars: I, L, O, U
  assertFalse(isValidUlid("01HGW2K890123456789012345I"));
  assertFalse(isValidUlid("01HGW2K890123456789012345L"));
  assertFalse(isValidUlid("01HGW2K890123456789012345O"));
  assertFalse(isValidUlid("01HGW2K890123456789012345U"));
  // Invalid chars: lowercase or other symbols
  assertFalse(isValidUlid("01hgw2k8901234567890123456"));
  assertFalse(isValidUlid("01HGW2K890123456789012345-"));
});

Deno.test("generateUlid - default behavior uses real time and randomness", () => {
  const ulid1 = generateUlid();
  const ulid2 = generateUlid();

  assertEquals(ulid1.length, 26);
  assertEquals(ulid2.length, 26);
  assert(
    ulid1 !== ulid2,
    "Two sequential default calls should not produce identical ULIDs",
  );
  assert(isValidUlid(ulid1), `Expected ${ulid1} to be valid`);
  assert(isValidUlid(ulid2), `Expected ${ulid2} to be valid`);
});
