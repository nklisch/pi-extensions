const SENSITIVE_FIELD_PART = /authorization|authentication|credential|password|passphrase|secret|token|api[-_]?key|(?:^|[-_.])(?:auth|key|cookies?|signature|sig|session(?:[-_.]?id)?|jwt)(?:$|[-_.])/i;

/**
 * Classify structured names whose literal values could be credentials. This is
 * intentionally shared by compatibility validation, launch-template creation,
 * and diagnostic redaction so those boundaries cannot drift independently.
 */
export function isSensitiveFieldName(name: string): boolean {
  return typeof name === "string" && SENSITIVE_FIELD_PART.test(name);
}

export function isSensitiveQueryName(name: string): boolean {
  return isSensitiveFieldName(name);
}
