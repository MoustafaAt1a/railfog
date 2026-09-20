/**
 * Tests for connect-time egress IP address and CIDR blocker.
 *
 * Spec references:
 * - contracts/platform.contract.md#PLAT-5: Network policy: allowlist + mandatory IP block (SSRF-safe).
 *   Mandatory-block ranges enforced at egress proxy by resolved IP at connect time,
 *   independent of allowlist and immune to DNS rebinding:
 *     - 169.254.0.0/16, fd00:ec2::/8 (link-local / cloud metadata)
 *     - 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16 (RFC1918 private ranges)
 *     - 127.0.0.0/8, ::1/128 (loopback)
 *     - 0.0.0.0/8, 224.0.0.0/4, 240.0.0.0/4, fe80::/10, ff00::/8 (unspecified/multicast/reserved)
 *     - Configurable internal RailFog service addresses
 */

import { assertEquals, assertRejects } from "@std/assert";
import {
  EgressIpBlocker,
  type EgressIpBlockerOptions,
  type IpBlockResult,
} from "../../runtime/sandbox/egress-ip-blocker.ts";

// ============================================================================
// AC1: Cloud Metadata Blocking (PLAT-5)
// ============================================================================

Deno.test("AC1 — Blocks AWS/GCP/Azure IPv4 cloud metadata (169.254.169.254)", async () => {
  // spec: contracts/platform.contract.md#PLAT-5 — 169.254.0.0/16 link-local / cloud metadata
  const blocker = new EgressIpBlocker();

  assertEquals(blocker.isIpBlocked("169.254.169.254"), true);

  const result: IpBlockResult = await blocker.validateDestination(
    "169.254.169.254",
  );
  assertEquals(result.blocked, true);
  assertEquals(result.ip, "169.254.169.254");
});

Deno.test("AC1 — Blocks AWS IPv6 cloud metadata ([fd00:ec2::254] and fd00:ec2::/8)", async () => {
  // spec: contracts/platform.contract.md#PLAT-5 — fd00:ec2::/8 cloud metadata
  const blocker = new EgressIpBlocker();

  assertEquals(blocker.isIpBlocked("fd00:ec2::254"), true);
  assertEquals(blocker.isIpBlocked("fd00:ec2:1234::1"), true);

  const resultBracketed = await blocker.validateDestination("[fd00:ec2::254]");
  assertEquals(resultBracketed.blocked, true);

  const resultRaw = await blocker.validateDestination("fd00:ec2::254");
  assertEquals(resultRaw.blocked, true);
});

Deno.test("AC1 — Blocks cloud metadata with explicit ports", async () => {
  // spec: contracts/platform.contract.md#PLAT-5
  const blocker = new EgressIpBlocker();

  const ipv4Result = await blocker.validateDestination("169.254.169.254:80");
  assertEquals(ipv4Result.blocked, true);

  const ipv6Result = await blocker.validateDestination("[fd00:ec2::254]:8080");
  assertEquals(ipv6Result.blocked, true);
});

Deno.test("AC1 — Blocks entire link-local range (169.254.0.0/16)", () => {
  // spec: contracts/platform.contract.md#PLAT-5
  const blocker = new EgressIpBlocker();

  // AWS ECS metadata endpoint
  assertEquals(blocker.isIpBlocked("169.254.170.2"), true);
  // Range boundary points
  assertEquals(blocker.isIpBlocked("169.254.0.1"), true);
  assertEquals(blocker.isIpBlocked("169.254.255.254"), true);
  assertEquals(blocker.isIpBlocked("169.254.1.1"), true);
});

// ============================================================================
// AC2: RFC1918 Private Ranges and Loopback Blocking (PLAT-5)
// ============================================================================

Deno.test("AC2 — Blocks RFC1918 10.0.0.0/8 private network", async () => {
  // spec: contracts/platform.contract.md#PLAT-5 — 10.0.0.0/8
  const blocker = new EgressIpBlocker();

  assertEquals(blocker.isIpBlocked("10.0.0.1"), true);
  assertEquals(blocker.isIpBlocked("10.255.255.255"), true);
  assertEquals(blocker.isIpBlocked("10.10.10.10"), true);

  const result = await blocker.validateDestination("10.0.0.1:8080");
  assertEquals(result.blocked, true);
});

Deno.test("AC2 — Blocks RFC1918 172.16.0.0/12 private network", async () => {
  // spec: contracts/platform.contract.md#PLAT-5 — 172.16.0.0/12
  const blocker = new EgressIpBlocker();

  assertEquals(blocker.isIpBlocked("172.16.0.1"), true);
  assertEquals(blocker.isIpBlocked("172.16.0.5"), true);
  assertEquals(blocker.isIpBlocked("172.31.255.255"), true);
  assertEquals(blocker.isIpBlocked("172.20.1.100"), true);

  const result = await blocker.validateDestination("172.16.0.5");
  assertEquals(result.blocked, true);
});

Deno.test("AC2 — Blocks RFC1918 192.168.0.0/16 private network", async () => {
  // spec: contracts/platform.contract.md#PLAT-5 — 192.168.0.0/16
  const blocker = new EgressIpBlocker();

  assertEquals(blocker.isIpBlocked("192.168.0.1"), true);
  assertEquals(blocker.isIpBlocked("192.168.1.1"), true);
  assertEquals(blocker.isIpBlocked("192.168.255.255"), true);

  const result = await blocker.validateDestination("192.168.1.1:443");
  assertEquals(result.blocked, true);
});

Deno.test("AC2 — Blocks loopback IPv4 127.0.0.0/8 and IPv6 ::1/128", async () => {
  // spec: contracts/platform.contract.md#PLAT-5 — 127.0.0.0/8, ::1/128
  const blocker = new EgressIpBlocker();

  assertEquals(blocker.isIpBlocked("127.0.0.1"), true);
  assertEquals(blocker.isIpBlocked("127.0.0.2"), true);
  assertEquals(blocker.isIpBlocked("127.255.255.255"), true);
  assertEquals(blocker.isIpBlocked("::1"), true);

  const v4Result = await blocker.validateDestination("127.0.0.1:3000");
  assertEquals(v4Result.blocked, true);

  const v6Result = await blocker.validateDestination("[::1]:8080");
  assertEquals(v6Result.blocked, true);
});

// ============================================================================
// Unit: Additional Mandatory Blocked Ranges (PLAT-5 & Scope)
// ============================================================================

Deno.test("Unit — Blocks 0.0.0.0/8, multicast 224.0.0.0/4, reserved 240.0.0.0/4", () => {
  // spec: contracts/platform.contract.md#PLAT-5 — 0.0.0.0/8, 224.0.0.0/4, 240.0.0.0/4
  const blocker = new EgressIpBlocker();

  // Current network / unspecified
  assertEquals(blocker.isIpBlocked("0.0.0.0"), true);
  assertEquals(blocker.isIpBlocked("0.0.0.1"), true);
  assertEquals(blocker.isIpBlocked("0.255.255.255"), true);

  // Multicast
  assertEquals(blocker.isIpBlocked("224.0.0.1"), true);
  assertEquals(blocker.isIpBlocked("239.255.255.255"), true);

  // Future reserved / broadcast
  assertEquals(blocker.isIpBlocked("240.0.0.1"), true);
  assertEquals(blocker.isIpBlocked("255.255.255.255"), true);
});

Deno.test("Unit — Blocks IPv6 link-local fe80::/10, multicast ff00::/8, unspecified ::", () => {
  // spec: contracts/platform.contract.md#PLAT-5
  const blocker = new EgressIpBlocker();

  assertEquals(blocker.isIpBlocked("fe80::1"), true);
  assertEquals(blocker.isIpBlocked("fe80::a00:27ff:fe8e:a3be"), true);
  assertEquals(blocker.isIpBlocked("ff02::1"), true);
  assertEquals(blocker.isIpBlocked("ff05::2"), true);
  assertEquals(blocker.isIpBlocked("::"), true);
});

Deno.test("Unit — Supports configurable additional blocked ranges for internal services", async () => {
  // spec: contracts/platform.contract.md#PLAT-5 — configurable RailFog internal service addresses
  const customOptions: EgressIpBlockerOptions = {
    additionalBlockedRanges: ["198.51.100.0/24", "203.0.113.50/32"],
  };
  const customBlocker = new EgressIpBlocker(customOptions);

  assertEquals(customBlocker.isIpBlocked("198.51.100.15"), true);
  assertEquals(customBlocker.isIpBlocked("203.0.113.50"), true);
  // Adjacent unlisted address is allowed
  assertEquals(customBlocker.isIpBlocked("203.0.113.51"), false);

  const customResult = await customBlocker.validateDestination(
    "198.51.100.15:8080",
  );
  assertEquals(customResult.blocked, true);
});

// ============================================================================
// AC4: Valid Public Internet IPs Allowed
// ============================================================================

Deno.test("AC4 — Allows valid public IPv4 addresses", async () => {
  // spec: contracts/platform.contract.md#PLAT-5
  const blocker = new EgressIpBlocker();

  assertEquals(blocker.isIpBlocked("93.184.216.34"), false);
  assertEquals(blocker.isIpBlocked("8.8.8.8"), false);
  assertEquals(blocker.isIpBlocked("1.1.1.1"), false);

  const result = await blocker.validateDestination("93.184.216.34:443");
  assertEquals(result.blocked, false);
  assertEquals(result.ip, "93.184.216.34");
});

Deno.test("AC4 — Allows valid public IPv6 addresses", async () => {
  // spec: contracts/platform.contract.md#PLAT-5
  const blocker = new EgressIpBlocker();

  assertEquals(blocker.isIpBlocked("2606:4700:4700::1111"), false);
  assertEquals(blocker.isIpBlocked("2001:4860:4860::8888"), false);

  const result = await blocker.validateDestination(
    "[2606:4700:4700::1111]:443",
  );
  assertEquals(result.blocked, false);
  assertEquals(result.ip, "2606:4700:4700::1111");
});

Deno.test("AC4 — Accurately permits addresses at strict CIDR boundaries", () => {
  // spec: contracts/platform.contract.md#PLAT-5 — Ensure CIDR masks don't bleed into public IP space
  const blocker = new EgressIpBlocker();

  // Around 10.0.0.0/8
  assertEquals(blocker.isIpBlocked("9.255.255.255"), false);
  assertEquals(blocker.isIpBlocked("11.0.0.0"), false);

  // Around 172.16.0.0/12
  assertEquals(blocker.isIpBlocked("172.15.255.255"), false);
  assertEquals(blocker.isIpBlocked("172.32.0.0"), false);

  // Around 192.168.0.0/16
  assertEquals(blocker.isIpBlocked("192.167.255.255"), false);
  assertEquals(blocker.isIpBlocked("192.169.0.0"), false);

  // Around 169.254.0.0/16
  assertEquals(blocker.isIpBlocked("169.253.255.255"), false);
  assertEquals(blocker.isIpBlocked("169.255.0.0"), false);
});

// ============================================================================
// AC3 & Integration: Connect-time DNS Resolution & Rebinding Resistance
// ============================================================================

Deno.test("AC3 — Intercepts DNS rebinding targeting cloud metadata at connect time", async () => {
  // spec: contracts/platform.contract.md#PLAT-5 — immune to DNS rebinding
  // Attacker domain simulates public IP on initial check, but resolves to 169.254.169.254 at connect time
  const blocker = new EgressIpBlocker({
    dnsResolver: (_host: string) => Promise.resolve(["169.254.169.254"]),
  });

  const result = await blocker.validateDestination("rebind-attack.example.com");
  assertEquals(result.blocked, true);
  assertEquals(result.ip, "169.254.169.254");
});

Deno.test("AC3 — Intercepts DNS rebinding targeting loopback (127.0.0.1)", async () => {
  // spec: contracts/platform.contract.md#PLAT-5
  const blocker = new EgressIpBlocker({
    dnsResolver: (_host: string) => Promise.resolve(["127.0.0.1"]),
  });

  const result = await blocker.validateDestination(
    "rebind-to-localhost.attacker.io:8080",
  );
  assertEquals(result.blocked, true);
  assertEquals(result.ip, "127.0.0.1");
});

Deno.test("AC3 — Blocks destination when DNS returns mixed public and blocked IPs (dual-homed evasion)", async () => {
  // spec: contracts/platform.contract.md#PLAT-5
  // If a hostname returns both a public IP and an internal/metadata IP, the connection MUST be rejected
  const blocker = new EgressIpBlocker({
    dnsResolver: (_host: string) =>
      Promise.resolve(["93.184.216.34", "169.254.169.254"]),
  });

  const result = await blocker.validateDestination("dual-homed.evil.com");
  assertEquals(result.blocked, true);
});

Deno.test("AC3 — Blocks destination when DNS returns mixed public and RFC1918 IPs", async () => {
  // spec: contracts/platform.contract.md#PLAT-5
  const blocker = new EgressIpBlocker({
    dnsResolver: (_host: string) =>
      Promise.resolve(["93.184.216.34", "10.0.0.1"]),
  });

  const result = await blocker.validateDestination("split-horizon.evil.com");
  assertEquals(result.blocked, true);
});

Deno.test("Integration — Resolves public hostname via custom resolver successfully", async () => {
  // spec: contracts/platform.contract.md#PLAT-5
  const blocker = new EgressIpBlocker({
    dnsResolver: (host: string) => {
      if (host === "api.stripe.com") {
        return Promise.resolve(["93.184.216.34"]);
      }
      return Promise.resolve([]);
    },
  });

  const result = await blocker.validateDestination("api.stripe.com:443");
  assertEquals(result.blocked, false);
  assertEquals(result.ip, "93.184.216.34");
});

Deno.test("Integration — Handles DNS resolution failure safely without bypass", async () => {
  // spec: contracts/platform.contract.md#PLAT-5 — fail-closed: unresolvable destination cannot connect
  const blocker = new EgressIpBlocker({
    dnsResolver: (_host: string) =>
      Promise.reject(new Error("DNS query failed: NXDOMAIN")),
  });

  await assertRejects(
    async () => {
      await blocker.validateDestination("nonexistent.invalid");
    },
    Error,
  );
});

Deno.test("Integration — Rejects destination when DNS resolves to zero IP addresses", async () => {
  // spec: contracts/platform.contract.md#PLAT-5 — fail-closed
  const blocker = new EgressIpBlocker({
    dnsResolver: (_host: string) => Promise.resolve([]),
  });

  const result = await blocker.validateDestination("empty.example.com");
  // Cannot verify safety if zero IPs are resolved
  assertEquals(result.blocked, true);
});

// ============================================================================
// Security Adversarial: Obfuscation and Encoding Evasion Attacks
// ============================================================================

Deno.test("Security — Blocks non-canonical IPv4 octal string encodings (0177.0.0.1)", async () => {
  // spec: contracts/platform.contract.md#PLAT-5 — normalize and reject non-canonical IP formats
  const blocker = new EgressIpBlocker();

  // Octal 0177 = 127
  assertEquals(blocker.isIpBlocked("0177.0.0.1"), true);
  assertEquals(blocker.isIpBlocked("0177.0000.0000.0001"), true);
  // Octal 012 = 10 (10.0.0.1)
  assertEquals(blocker.isIpBlocked("012.0.0.1"), true);
  // Octal 0251.0376.0251.0376 = 169.254.169.254
  assertEquals(blocker.isIpBlocked("0251.0376.0251.0376"), true);

  const result = await blocker.validateDestination("0177.0.0.1:80");
  assertEquals(result.blocked, true);
});

Deno.test("Security — Blocks integer/decimal IPv4 encodings (2130706433)", async () => {
  // spec: contracts/platform.contract.md#PLAT-5
  const blocker = new EgressIpBlocker();

  // 2130706433 = 127.0.0.1
  assertEquals(blocker.isIpBlocked("2130706433"), true);
  // 2852039166 = 169.254.169.254
  assertEquals(blocker.isIpBlocked("2852039166"), true);
  // 167772161 = 10.0.0.1
  assertEquals(blocker.isIpBlocked("167772161"), true);
  // 3232235777 = 192.168.1.1
  assertEquals(blocker.isIpBlocked("3232235777"), true);

  const result = await blocker.validateDestination("2130706433");
  assertEquals(result.blocked, true);
});

Deno.test("Security — Blocks hexadecimal IPv4 encodings (0x7f.0.0.1, 0x7f000001)", async () => {
  // spec: contracts/platform.contract.md#PLAT-5
  const blocker = new EgressIpBlocker();

  // 0x7f = 127
  assertEquals(blocker.isIpBlocked("0x7f.0.0.1"), true);
  assertEquals(blocker.isIpBlocked("0x7f000001"), true);
  // 0xa9fea9fe = 169.254.169.254
  assertEquals(blocker.isIpBlocked("0xa9fea9fe"), true);
  // 0x0a000001 = 10.0.0.1
  assertEquals(blocker.isIpBlocked("0x0a000001"), true);

  const result = await blocker.validateDestination("0x7f.0.0.1:80");
  assertEquals(result.blocked, true);
});

Deno.test("Security — Blocks IPv4-mapped IPv6 addresses (::ffff:127.0.0.1, ::ffff:169.254.169.254)", async () => {
  // spec: contracts/platform.contract.md#PLAT-5 — IPv4-mapped IPv6 must be unpacked and checked against blocked ranges
  const blocker = new EgressIpBlocker();

  assertEquals(blocker.isIpBlocked("::ffff:127.0.0.1"), true);
  assertEquals(blocker.isIpBlocked("::ffff:169.254.169.254"), true);
  assertEquals(blocker.isIpBlocked("::ffff:10.0.0.1"), true);
  assertEquals(blocker.isIpBlocked("::ffff:192.168.1.1"), true);
  assertEquals(blocker.isIpBlocked("::ffff:172.16.0.1"), true);

  // Hexadecimal notation of IPv4-mapped IPv6 (::ffff:7f00:1 = 127.0.0.1, ::ffff:a9fe:a9fe = 169.254.169.254)
  assertEquals(blocker.isIpBlocked("::ffff:7f00:1"), true);
  assertEquals(blocker.isIpBlocked("::ffff:a9fe:a9fe"), true);

  const result = await blocker.validateDestination(
    "[::ffff:169.254.169.254]:80",
  );
  assertEquals(result.blocked, true);
});

Deno.test("Security — Correctly permits public IPv4 addresses presented as IPv4-mapped IPv6", async () => {
  // spec: contracts/platform.contract.md#PLAT-5
  const blocker = new EgressIpBlocker();

  // 93.184.216.34 is public; mapping it to IPv6 should still evaluate the underlying IPv4 address correctly
  assertEquals(blocker.isIpBlocked("::ffff:93.184.216.34"), false);

  const result = await blocker.validateDestination(
    "[::ffff:93.184.216.34]:443",
  );
  assertEquals(result.blocked, false);
});

Deno.test("Security — Blocks deprecated IPv4-compatible IPv6 addresses (::127.0.0.1, ::169.254.169.254)", async () => {
  // spec: contracts/platform.contract.md#PLAT-5
  const blocker = new EgressIpBlocker();

  assertEquals(blocker.isIpBlocked("::127.0.0.1"), true);
  assertEquals(blocker.isIpBlocked("::169.254.169.254"), true);

  const result = await blocker.validateDestination("[::127.0.0.1]:80");
  assertEquals(result.blocked, true);
});
