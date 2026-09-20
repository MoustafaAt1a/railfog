// spec: contracts/platform.contract.md#PLAT-5 — Network policy: allowlist + mandatory IP block (SSRF-safe)

export interface IpBlockResult {
  blocked: boolean;
  ip: string;
  reason?: string;
}

export interface EgressIpBlockerOptions {
  additionalBlockedRanges?: string[];
  dnsResolver?: (host: string) => Promise<string[]>;
}

export interface EgressIpBlocker {
  isIpBlocked(ip: string): boolean;
  validateDestination(hostOrIp: string): Promise<IpBlockResult>;
}

interface Ipv4Cidr {
  network: bigint;
  mask: bigint;
}

interface Ipv6Cidr {
  network: bigint;
  mask: bigint;
}

type ParsedIp =
  | { type: "ipv4"; value: bigint }
  | { type: "ipv6"; value: bigint };

// spec: contracts/platform.contract.md#PLAT-5 — Mandatory-block ranges enforced at egress proxy
const MANDATORY_BLOCKED_IPV4_CIDRS: readonly string[] = [
  "169.254.0.0/16", // Link-local / cloud metadata (AWS/GCP/Azure)
  "10.0.0.0/8", // RFC1918 private network
  "172.16.0.0/12", // RFC1918 private network
  "192.168.0.0/16", // RFC1918 private network
  "127.0.0.0/8", // Loopback IPv4
  "0.0.0.0/8", // Unspecified / current network
  "224.0.0.0/4", // Multicast
  "240.0.0.0/4", // Reserved / Class E
];

// spec: contracts/platform.contract.md#PLAT-5 — Mandatory-block ranges enforced at egress proxy
const MANDATORY_BLOCKED_IPV6_CIDRS: readonly string[] = [
  "fd00:ec2::/8", // AWS IPv6 cloud metadata
  "::1/128", // Loopback IPv6
  "fe80::/10", // Link-local IPv6
  "ff00::/8", // Multicast IPv6
  "::/128", // Unspecified IPv6
];

const BITS_IPV4 = 32n;
const BITS_IPV6 = 128n;
const IPV4_MAX = 0xffffffffn;

function parseIpv4Cidr(cidr: string): Ipv4Cidr {
  const slashIdx = cidr.indexOf("/");
  const ipStr = slashIdx === -1 ? cidr : cidr.slice(0, slashIdx);
  const prefixStr = slashIdx === -1 ? "32" : cidr.slice(slashIdx + 1);
  const prefixLen = parseInt(prefixStr, 10);
  if (isNaN(prefixLen) || prefixLen < 0 || prefixLen > 32) {
    throw new Error(`Invalid IPv4 CIDR prefix: ${cidr}`);
  }
  const ipVal = parseIPv4(ipStr);
  if (ipVal === null) {
    throw new Error(`Invalid IPv4 address in CIDR: ${cidr}`);
  }
  const mask = prefixLen === 0
    ? 0n
    : (((1n << BigInt(prefixLen)) - 1n) << (BITS_IPV4 - BigInt(prefixLen))) &
      IPV4_MAX;
  const network = ipVal & mask;
  return { network, mask };
}

function parseIpv6Cidr(cidr: string): Ipv6Cidr {
  const slashIdx = cidr.indexOf("/");
  const ipStr = slashIdx === -1 ? cidr : cidr.slice(0, slashIdx);
  const prefixStr = slashIdx === -1 ? "128" : cidr.slice(slashIdx + 1);
  const prefixLen = parseInt(prefixStr, 10);
  if (isNaN(prefixLen) || prefixLen < 0 || prefixLen > 128) {
    throw new Error(`Invalid IPv6 CIDR prefix: ${cidr}`);
  }
  const ipVal = parseIPv6(ipStr);
  if (ipVal === null) {
    throw new Error(`Invalid IPv6 address in CIDR: ${cidr}`);
  }
  const mask = prefixLen === 0
    ? 0n
    : ((1n << BigInt(prefixLen)) - 1n) << (BITS_IPV6 - BigInt(prefixLen));
  const network = ipVal & mask;
  return { network, mask };
}

/**
 * Strips surrounding brackets from IPv6 literals and removes port suffixes.
 * Preserves unbracketed IPv6 colons.
 */
function stripPortAndBrackets(input: string): string {
  const trimmed = input.trim();
  const bracketMatch = trimmed.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (bracketMatch) {
    return bracketMatch[1];
  }
  const portMatch = trimmed.match(/^([^:]+):(\d+)$/);
  if (portMatch) {
    return portMatch[1];
  }
  return trimmed;
}

/**
 * Parses IPv4 addresses according to POSIX inet_aton semantics,
 * supporting decimal, octal (0-prefixed), hexadecimal (0x-prefixed),
 * and 1 to 4 part encodings.
 */
function parseIPv4(input: string): bigint | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const parts = trimmed.split(".");
  if (parts.length < 1 || parts.length > 4) {
    return null;
  }

  const parsedParts: bigint[] = [];
  for (const part of parts) {
    if (!part) return null;
    let val: bigint;
    if (part.startsWith("0x") || part.startsWith("0X")) {
      const hexDigits = part.slice(2);
      if (!hexDigits || !/^[0-9a-fA-F]+$/.test(hexDigits)) {
        return null;
      }
      val = BigInt("0x" + hexDigits);
    } else if (part.startsWith("0") && part.length > 1) {
      const octalDigits = part.slice(1);
      if (!/^[0-7]+$/.test(octalDigits)) {
        return null;
      }
      val = BigInt(parseInt(part, 8));
    } else {
      if (!/^[0-9]+$/.test(part)) {
        return null;
      }
      val = BigInt(part);
    }
    parsedParts.push(val);
  }

  if (parsedParts.length === 4) {
    if (
      parsedParts[0] > 255n || parsedParts[1] > 255n ||
      parsedParts[2] > 255n || parsedParts[3] > 255n
    ) {
      return null;
    }
    return (parsedParts[0] << 24n) | (parsedParts[1] << 16n) |
      (parsedParts[2] << 8n) | parsedParts[3];
  } else if (parsedParts.length === 3) {
    if (
      parsedParts[0] > 255n || parsedParts[1] > 255n ||
      parsedParts[2] > 65535n
    ) {
      return null;
    }
    return (parsedParts[0] << 24n) | (parsedParts[1] << 16n) | parsedParts[2];
  } else if (parsedParts.length === 2) {
    if (parsedParts[0] > 255n || parsedParts[1] > 16777215n) {
      return null;
    }
    return (parsedParts[0] << 24n) | parsedParts[1];
  } else {
    if (parsedParts[0] > IPV4_MAX) {
      return null;
    }
    return parsedParts[0];
  }
}

/**
 * Parses IPv6 addresses into 128-bit BigInt, converting any trailing
 * IPv4 dotted representations (e.g. ::ffff:127.0.0.1 or ::127.0.0.1).
 */
function parseIPv6(input: string): bigint | null {
  let str = input.trim();
  if (!str) return null;

  const lastColon = str.lastIndexOf(":");
  if (lastColon === -1) return null;

  const tail = str.slice(lastColon + 1);
  if (tail.includes(".")) {
    const v4Val = parseIPv4(tail);
    if (v4Val === null) return null;
    const high16 = ((v4Val >> 16n) & 0xffffn).toString(16);
    const low16 = (v4Val & 0xffffn).toString(16);
    str = str.slice(0, lastColon + 1) + high16 + ":" + low16;
  }

  const doubleColonIndex = str.indexOf("::");
  let fullHextets: string[];

  if (doubleColonIndex !== -1) {
    if (str.indexOf("::", doubleColonIndex + 2) !== -1) {
      return null;
    }
    const leftPart = str.slice(0, doubleColonIndex);
    const rightPart = str.slice(doubleColonIndex + 2);
    const leftHextets = leftPart ? leftPart.split(":") : [];
    const rightHextets = rightPart ? rightPart.split(":") : [];
    const totalSpecified = leftHextets.length + rightHextets.length;
    if (totalSpecified > 7) {
      return null;
    }
    const missingZeros = 8 - totalSpecified;
    fullHextets = [
      ...leftHextets,
      ...Array(missingZeros).fill("0"),
      ...rightHextets,
    ];
  } else {
    fullHextets = str.split(":");
    if (fullHextets.length !== 8) {
      return null;
    }
  }

  let bigintVal = 0n;
  for (const hextet of fullHextets) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(hextet)) {
      return null;
    }
    bigintVal = (bigintVal << 16n) | BigInt(parseInt(hextet, 16));
  }
  return bigintVal;
}

function tryParseIp(input: string): ParsedIp | null {
  const clean = stripPortAndBrackets(input);
  if (clean.includes(":")) {
    const v6 = parseIPv6(clean);
    if (v6 !== null) {
      return { type: "ipv6", value: v6 };
    }
    return null;
  }
  const v4 = parseIPv4(clean);
  if (v4 !== null) {
    return { type: "ipv4", value: v4 };
  }
  return null;
}

async function defaultDnsResolver(host: string): Promise<string[]> {
  const [aResult, aaaaResult] = await Promise.allSettled([
    Deno.resolveDns(host, "A"),
    Deno.resolveDns(host, "AAAA"),
  ]);

  if (aResult.status === "rejected" && aaaaResult.status === "rejected") {
    throw aResult.reason;
  }

  const ips: string[] = [];
  if (aResult.status === "fulfilled") {
    ips.push(...aResult.value);
  }
  if (aaaaResult.status === "fulfilled") {
    ips.push(...aaaaResult.value);
  }
  return ips;
}

/**
 * Connect-time CIDR blocker for outbound network requests.
 * spec: contracts/platform.contract.md#PLAT-5
 */
export class EgressIpBlocker implements EgressIpBlocker {
  private readonly ipv4BlockedRanges: Ipv4Cidr[] = [];
  private readonly ipv6BlockedRanges: Ipv6Cidr[] = [];
  private readonly dnsResolver: (host: string) => Promise<string[]>;

  constructor(options?: EgressIpBlockerOptions) {
    this.dnsResolver = options?.dnsResolver ?? defaultDnsResolver;

    for (const cidr of MANDATORY_BLOCKED_IPV4_CIDRS) {
      this.ipv4BlockedRanges.push(parseIpv4Cidr(cidr));
    }
    for (const cidr of MANDATORY_BLOCKED_IPV6_CIDRS) {
      this.ipv6BlockedRanges.push(parseIpv6Cidr(cidr));
    }

    if (options?.additionalBlockedRanges) {
      for (const cidr of options.additionalBlockedRanges) {
        if (cidr.includes(":")) {
          this.ipv6BlockedRanges.push(parseIpv6Cidr(cidr));
        } else {
          this.ipv4BlockedRanges.push(parseIpv4Cidr(cidr));
        }
      }
    }
  }

  private isIpv4Blocked(v4Val: bigint): boolean {
    for (const cidr of this.ipv4BlockedRanges) {
      if ((v4Val & cidr.mask) === cidr.network) {
        return true;
      }
    }
    return false;
  }

  private isIpv6Blocked(v6Val: bigint): boolean {
    for (const cidr of this.ipv6BlockedRanges) {
      if ((v6Val & cidr.mask) === cidr.network) {
        return true;
      }
    }
    return false;
  }

  /**
   * Synchronously checks if an IP address falls within any blocked CIDR range.
   * Handles canonical and non-canonical IPv4 representations, IPv6,
   * IPv4-mapped IPv6, and deprecated IPv4-compatible IPv6 addresses.
   * spec: contracts/platform.contract.md#PLAT-5
   */
  public isIpBlocked(ip: string): boolean {
    const parsed = tryParseIp(ip);
    if (!parsed) {
      return true;
    }

    if (parsed.type === "ipv4") {
      return this.isIpv4Blocked(parsed.value);
    }

    const v6Val = parsed.value;

    // spec: contracts/platform.contract.md#PLAT-5 — IPv4-mapped IPv6 (::ffff:0:0/96)
    if ((v6Val >> 32n) === 0xffffn) {
      const v4Val = v6Val & IPV4_MAX;
      return this.isIpv4Blocked(v4Val);
    }

    // spec: contracts/platform.contract.md#PLAT-5 — Deprecated IPv4-compatible IPv6 (::0:0/96)
    if ((v6Val >> 32n) === 0n && v6Val > 1n) {
      const v4Val = v6Val & IPV4_MAX;
      return this.isIpv4Blocked(v4Val);
    }

    return this.isIpv6Blocked(v6Val);
  }

  /**
   * Validates an outbound destination (IP or hostname with optional port).
   * Resolves hostnames at connect time to prevent DNS rebinding attacks.
   * spec: contracts/platform.contract.md#PLAT-5
   */
  public async validateDestination(hostOrIp: string): Promise<IpBlockResult> {
    const target = stripPortAndBrackets(hostOrIp);
    const parsed = tryParseIp(target);

    if (parsed) {
      const blocked = this.isIpBlocked(target);
      if (blocked) {
        return {
          blocked: true,
          ip: target,
          reason: `Destination IP ${target} is in a blocked range`,
        };
      }
      return {
        blocked: false,
        ip: target,
      };
    }

    // spec: contracts/platform.contract.md#PLAT-5 — Connect-time DNS resolution prevents rebinding
    const ips = await this.dnsResolver(target);
    if (ips.length === 0) {
      return {
        blocked: true,
        ip: target,
        reason: "No IP addresses resolved",
      };
    }

    for (const resolvedIp of ips) {
      if (this.isIpBlocked(resolvedIp)) {
        return {
          blocked: true,
          ip: resolvedIp,
          reason: `Destination resolved to blocked IP ${resolvedIp}`,
        };
      }
    }

    return {
      blocked: false,
      ip: ips[0],
    };
  }
}
