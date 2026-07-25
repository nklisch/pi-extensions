import {
  isSensitiveFieldName,
  isSensitiveQueryName,
} from "../../domain/sensitive-fields.js";

export type RedactedCommand = Readonly<{
  executable: string;
  args: readonly string[];
}>;
const URL_CREDENTIAL = /(\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:)[^\s/@]+(@)/gi;
const URL_USERINFO = /(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi;
const BEARER = /(\bBearer\s+)[^\s,;]+/gi;
const BASIC = /(\bBasic\s+)[^\s,;]+/gi;
const QUERY_VALUE = /([?&])([^=&#\s]+)=([^&#\s]*)/g;

function replaceExplicitSecrets(value: string, secrets: readonly string[]): string {
  return [...secrets]
    .filter((secret) => secret.length > 0)
    .sort((left, right) => right.length - left.length)
    .reduce((result, secret) => result.split(secret).join("[REDACTED]"), value);
}

/**
 * Rebuilds diagnostic text instead of relying on a best-effort stderr scrub.
 * Explicit values are accepted for adapters that obtained a token from a
 * credential provider; the structural substitutions cover common Git/HTTP
 * credential forms even when an adapter forgot to register the value.
 */
export function redactText(value: string, secrets: readonly string[] = []): string {
  if (typeof value !== "string") return "[REDACTED]";
  return replaceExplicitSecrets(value, secrets)
    .replace(URL_CREDENTIAL, "$1[REDACTED]$2")
    .replace(URL_USERINFO, "$1[REDACTED]@")
    .replace(BEARER, "$1[REDACTED]")
    .replace(BASIC, "$1[REDACTED]")
    .replace(QUERY_VALUE, (match, prefix: string, rawName: string) => {
      let name = rawName;
      try {
        name = decodeURIComponent(rawName);
      } catch {
        // Malformed names are left intact; explicit secret redaction still ran.
      }
      return isSensitiveQueryName(name)
        ? `${prefix}${rawName}=[REDACTED]`
        : match;
    });
}

export function redactCommand(
  executable: string,
  args: readonly string[],
  secrets: readonly string[] = [],
): RedactedCommand {
  if (typeof executable !== "string" || executable.length === 0) {
    throw new TypeError("command executable must be a non-empty string");
  }
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
    throw new TypeError("command arguments must be strings");
  }
  return Object.freeze({
    executable: redactText(executable, secrets),
    args: Object.freeze(args.map((arg) => redactText(arg, secrets))),
  });
}

export function redactEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  secrets: readonly string[] = [],
): Readonly<Record<string, string | undefined>> {
  const result: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(environment)) {
    result[key] = value === undefined
      ? undefined
      : isSensitiveFieldName(key)
        ? "[REDACTED]"
        : redactText(value, secrets);
  }
  return Object.freeze(result);
}
