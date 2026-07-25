import { isIP } from "node:net";
import { lookup as nodeLookup } from "node:dns/promises";

export type NetworkAddress = Readonly<{ address: string; family: 4 | 6 }>;
export type NetworkLookup = (
  hostname: string,
  options: Readonly<{ all: true; verbatim: true }>,
) => Promise<readonly NetworkAddress[]>;

export type NetworkEgressPolicyOptions = Readonly<{
  privateOrigins?: readonly string[];
  credentialOrigins?: readonly string[];
  redirectOrigins?: readonly string[];
  lookup?: NetworkLookup;
}>;

export type ApprovedNetworkTarget = Readonly<{
  url: URL;
  protocol: "https:" | "ssh:";
  origin: string;
  hostname: string;
  port: string;
  address: string;
  family: 4 | 6;
  credentialsApproved: boolean;
}>;

export class NetworkEgressPolicyError extends Error {
  readonly kind: "policy" | "resolution";

  constructor(kind: "policy" | "resolution", message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "NetworkEgressPolicyError";
    this.kind = kind;
  }
}

type AddressClass = "public" | "private" | "forbidden";

const SCP_REMOTE = /^(?:(?<user>[A-Za-z0-9._-]+)@)?(?<host>[A-Za-z0-9.-]+):(?<path>[^/\\\s:][^\s]*)$/u;
const FORBIDDEN_HOST_SUFFIXES = [
  ".localhost",
  ".local",
  ".internal",
  ".home.arpa",
  ".test",
  ".invalid",
  ".example",
];

function ipv4Bytes(address: string): readonly [number, number, number, number] | undefined {
  if (isIP(address) !== 4) return undefined;
  const values = address.split(".").map(Number);
  return values.length === 4 && values.every((value) => Number.isInteger(value) && value >= 0 && value <= 255)
    ? values as [number, number, number, number]
    : undefined;
}

function ipv4Class(address: string): AddressClass {
  const bytes = ipv4Bytes(address);
  if (bytes === undefined) return "forbidden";
  const [a, b, c] = bytes;
  if (a === 10 || a === 100 && b >= 64 && b <= 127 || a === 127 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168) return "private";
  if (a === 0 || a === 169 && b === 254 ||
      a === 192 && (
        b === 0 && (c === 0 || c === 2) || b === 31 && c === 196 ||
        b === 52 && c === 193 || b === 88 && c === 99 || b === 175 && c === 48
      ) ||
      a === 198 && (b === 18 || b === 19 || b === 51 && c === 100) ||
      a === 203 && b === 0 && c === 113 || a >= 224) return "forbidden";
  return "public";
}

function ipv6Value(address: string): bigint | undefined {
  const zone = address.indexOf("%");
  const input = (zone < 0 ? address : address.slice(0, zone)).toLowerCase();
  if (isIP(input) !== 6) return undefined;
  const halves = input.split("::");
  if (halves.length > 2) return undefined;
  const parse = (part: string): number[] => {
    if (part.length === 0) return [];
    const words: number[] = [];
    for (const segment of part.split(":")) {
      if (segment.includes(".")) {
        const bytes = ipv4Bytes(segment);
        if (bytes === undefined) return [];
        words.push((bytes[0] << 8) | bytes[1], (bytes[2] << 8) | bytes[3]);
      } else {
        const value = Number.parseInt(segment, 16);
        if (!/^[0-9a-f]{1,4}$/u.test(segment) || !Number.isInteger(value)) return [];
        words.push(value);
      }
    }
    return words;
  };
  const left = parse(halves[0] ?? "");
  const right = parse(halves[1] ?? "");
  const zeroCount = halves.length === 2 ? 8 - left.length - right.length : 0;
  const words = [...left, ...Array.from({ length: zeroCount }, () => 0), ...right];
  if (words.length !== 8) return undefined;
  return words.reduce((result, word) => result << 16n | BigInt(word), 0n);
}

function prefix(value: bigint, bits: number, expected: bigint): boolean {
  return value >> BigInt(128 - bits) === expected >> BigInt(128 - bits);
}

function ipv6Class(address: string): AddressClass {
  const value = ipv6Value(address);
  if (value === undefined) return "forbidden";
  // IPv4-mapped IPv6 must inherit the embedded IPv4 decision.
  if (prefix(value, 96, 0xffffn << 32n)) {
    const embedded = Number(value & 0xffff_ffffn);
    return ipv4Class(`${embedded >>> 24}.${embedded >>> 16 & 255}.${embedded >>> 8 & 255}.${embedded & 255}`);
  }
  if (value === 1n) return "private";
  if (value === 0n || prefix(value, 10, 0xfe80n << 112n) ||
      prefix(value, 8, 0xffn << 120n) || prefix(value, 96, 0x64ff9bn << 96n) ||
      prefix(value, 48, 0x64ff9b0001n << 80n) || prefix(value, 64, 0x100n << 112n) ||
      prefix(value, 23, 0x2001n << 112n) || prefix(value, 32, 0x20010db8n << 96n) ||
      prefix(value, 16, 0x2002n << 112n)) return "forbidden";
  if (prefix(value, 7, 0xfcn << 120n) || prefix(value, 10, 0xfec0n << 112n)) return "private";
  return prefix(value, 3, 0x2n << 124n) ? "public" : "forbidden";
}

function addressClass(address: string): AddressClass {
  const family = isIP(address);
  return family === 4 ? ipv4Class(address) : family === 6 ? ipv6Class(address) : "forbidden";
}

function stripBrackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

function endpointUrl(value: string): URL {
  const scp = SCP_REMOTE.exec(value);
  if (scp !== null) {
    const user = scp.groups?.user;
    const authority = `${user === undefined ? "" : `${encodeURIComponent(user)}@`}${scp.groups?.host ?? ""}`;
    return new URL(`ssh://${authority}/${scp.groups?.path ?? ""}`);
  }
  return new URL(value);
}

function canonicalOrigin(parsed: URL): string {
  const port = parsed.port || (parsed.protocol === "https:" ? "443" : "22");
  const user = parsed.protocol === "ssh:" && parsed.username.length > 0 ? `${parsed.username}@` : "";
  return `${parsed.protocol}//${user}${stripBrackets(parsed.hostname).toLowerCase()}:${port}`;
}

function exactOrigin(value: string): string {
  let parsed: URL;
  try {
    parsed = endpointUrl(value);
  } catch (error) {
    throw new TypeError("network authority is invalid", { cause: error });
  }
  if ((parsed.protocol !== "https:" && parsed.protocol !== "ssh:") || parsed.hostname.length === 0 ||
      parsed.password.length > 0 || parsed.search.length > 0 || parsed.hash.length > 0 ||
      parsed.pathname !== "" && parsed.pathname !== "/") {
    throw new TypeError("network authority must be an exact credential-free HTTPS or SSH origin");
  }
  return canonicalOrigin(parsed);
}

function authoritySet(values: readonly string[] | undefined): ReadonlySet<string> {
  return new Set((values ?? []).map(exactOrigin));
}

function sourceEndpoint(value: string): Readonly<{ url: URL; origin: string; protocol: "https:" | "ssh:"; hostname: string; port: string }> {
  let url: URL;
  try {
    url = endpointUrl(value);
  } catch (error) {
    throw new NetworkEgressPolicyError("policy", "network destination is invalid", error);
  }
  if ((url.protocol !== "https:" && url.protocol !== "ssh:") || url.hostname.length === 0 ||
      url.password.length > 0 || url.search.length > 0 || url.hash.length > 0 ||
      url.protocol === "https:" && url.username.length > 0) {
    throw new NetworkEgressPolicyError("policy", "network destination is not an approved protocol authority");
  }
  const protocol = url.protocol;
  const hostname = stripBrackets(url.hostname).toLowerCase();
  const port = url.port || (protocol === "https:" ? "443" : "22");
  return { url, origin: canonicalOrigin(url), protocol, hostname, port };
}

function forbiddenHostname(hostname: string): boolean {
  return hostname === "localhost" || !hostname.includes(".") && isIP(hostname) === 0 ||
    FORBIDDEN_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix));
}

function compareAddress(left: NetworkAddress, right: NetworkAddress): number {
  return left.family - right.family || left.address.localeCompare(right.address);
}

const NETWORK_POLICY_ENVIRONMENT = {
  privateOrigins: "PI_PLUGIN_HOST_PRIVATE_ORIGINS",
  credentialOrigins: "PI_PLUGIN_HOST_CREDENTIAL_ORIGINS",
  redirectOrigins: "PI_PLUGIN_HOST_REDIRECT_ORIGINS",
} as const;

function environmentOrigins(value: string | undefined, name: string): readonly string[] | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new TypeError(`${name} must be a JSON array of exact origins`, { cause: error });
  }
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string") || new Set(parsed).size !== parsed.length) {
    throw new TypeError(`${name} must be a unique JSON array of exact origins`);
  }
  return Object.freeze([...parsed].sort());
}

export function networkEgressPolicyOptionsFromEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): NetworkEgressPolicyOptions {
  if (environment === null || typeof environment !== "object") throw new TypeError("network policy environment is required");
  const result: Record<string, readonly string[]> = {};
  for (const [field, name] of Object.entries(NETWORK_POLICY_ENVIRONMENT)) {
    const origins = environmentOrigins(environment[name], name);
    if (origins !== undefined) result[field] = origins;
  }
  return Object.freeze(result);
}

export interface NetworkEgressPolicy {
  origin(value: string): string;
  authorize(value: string, protocol?: "https:" | "ssh:"): Promise<ApprovedNetworkTarget>;
  redirectAllowed(fromOrigin: string, toOrigin: string): boolean;
}

export function createNetworkEgressPolicy(options: NetworkEgressPolicyOptions = {}): NetworkEgressPolicy {
  const privateOrigins = authoritySet(options.privateOrigins);
  const credentialOrigins = authoritySet(options.credentialOrigins);
  const redirectOrigins = authoritySet(options.redirectOrigins);
  const lookup: NetworkLookup = options.lookup ?? (async (hostname, lookupOptions) =>
    await nodeLookup(hostname, lookupOptions) as readonly NetworkAddress[]);

  const policy: NetworkEgressPolicy = {
    origin(value: string): string {
      return sourceEndpoint(value).origin;
    },
    async authorize(value: string, expectedProtocol?: "https:" | "ssh:"): Promise<ApprovedNetworkTarget> {
      const endpoint = sourceEndpoint(value);
      if (expectedProtocol !== undefined && endpoint.protocol !== expectedProtocol) {
        throw new NetworkEgressPolicyError("policy", "network destination protocol changed");
      }
      if (forbiddenHostname(endpoint.hostname) && !privateOrigins.has(endpoint.origin)) {
        throw new NetworkEgressPolicyError("policy", "network destination host is not globally routable");
      }

      let addresses: readonly NetworkAddress[];
      const literalFamily = isIP(endpoint.hostname);
      if (literalFamily === 4 || literalFamily === 6) {
        addresses = [{ address: endpoint.hostname, family: literalFamily }];
      } else {
        try {
          addresses = await lookup(endpoint.hostname, { all: true, verbatim: true });
        } catch (error) {
          throw new NetworkEgressPolicyError("resolution", "network destination could not be resolved", error);
        }
      }
      if (addresses.length === 0 || addresses.some((entry) =>
        (entry.family !== 4 && entry.family !== 6) || isIP(entry.address) !== entry.family)) {
        throw new NetworkEgressPolicyError("resolution", "network destination returned invalid addresses");
      }
      const classified = addresses.map((entry) => ({ entry, classification: addressClass(entry.address) }));
      if (classified.some(({ classification }) => classification === "forbidden") ||
          classified.some(({ classification }) => classification === "private") && !privateOrigins.has(endpoint.origin)) {
        throw new NetworkEgressPolicyError("policy", "network destination resolved outside its approved address class");
      }
      const selected = [...addresses].sort(compareAddress)[0]!;
      return Object.freeze({
        ...endpoint,
        address: selected.address,
        family: selected.family,
        credentialsApproved: credentialOrigins.has(endpoint.origin),
      });
    },
    redirectAllowed(fromOrigin: string, toOrigin: string): boolean {
      return fromOrigin === toOrigin || redirectOrigins.has(toOrigin);
    },
  };
  return Object.freeze(policy);
}
