/**
 * ULID Generator
 * Spec-anchor: docs/contracts/platform.contract.md PLAT-14 (ULID algorithm)
 */

const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ULID_REGEX = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export function generateUlid(
  now: () => number = Date.now,
  random: () => Uint8Array = () => crypto.getRandomValues(new Uint8Array(10)),
): string {
  // 48-bit timestamp encoded into 10 characters of Crockford Base32
  let t = now();
  let timeChars = "";
  for (let i = 0; i < 10; i++) {
    timeChars = ENCODING[t % 32] + timeChars;
    t = Math.floor(t / 32);
  }

  // 80-bit randomness (10 bytes) encoded into 16 characters
  const bytes = random();
  let b0 = bytes[0],
    b1 = bytes[1],
    b2 = bytes[2],
    b3 = bytes[3],
    b4 = bytes[4];
  let randChars = "";

  // First 5 bytes (40 bits) -> 8 chars
  randChars += ENCODING[(b0 >> 3) & 0x1f];
  randChars += ENCODING[((b0 & 0x07) << 2) | (b1 >> 6)];
  randChars += ENCODING[(b1 >> 1) & 0x1f];
  randChars += ENCODING[((b1 & 0x01) << 4) | (b2 >> 4)];
  randChars += ENCODING[((b2 & 0x0f) << 1) | (b3 >> 7)];
  randChars += ENCODING[(b3 >> 2) & 0x1f];
  randChars += ENCODING[((b3 & 0x03) << 3) | (b4 >> 5)];
  randChars += ENCODING[b4 & 0x1f];

  // Next 5 bytes (40 bits) -> 8 chars
  b0 = bytes[5];
  b1 = bytes[6];
  b2 = bytes[7];
  b3 = bytes[8];
  b4 = bytes[9];
  randChars += ENCODING[(b0 >> 3) & 0x1f];
  randChars += ENCODING[((b0 & 0x07) << 2) | (b1 >> 6)];
  randChars += ENCODING[(b1 >> 1) & 0x1f];
  randChars += ENCODING[((b1 & 0x01) << 4) | (b2 >> 4)];
  randChars += ENCODING[((b2 & 0x0f) << 1) | (b3 >> 7)];
  randChars += ENCODING[(b3 >> 2) & 0x1f];
  randChars += ENCODING[((b3 & 0x03) << 3) | (b4 >> 5)];
  randChars += ENCODING[b4 & 0x1f];

  return timeChars + randChars;
}

export function isValidUlid(value: string): boolean {
  return ULID_REGEX.test(value);
}
