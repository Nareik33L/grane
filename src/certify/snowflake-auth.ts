import { createPrivateKey } from "node:crypto";
import { readFileSync, statSync } from "node:fs";

/**
 * Named failure this blocks: an automated certify run that uses a Snowflake
 * user with no TYPE (treated as human / PERSON) and password-only sign-in.
 * Password-only is being phased out; that user needs MFA and the run fails.
 * https://docs.snowflake.com/en/user-guide/security-mfa-rollout
 *
 * Cert-only. The runtime Snowflake connector must not import this module
 * or read GRANE_CERT_*.
 */
export const SNOWFLAKE_PASSWORD_AUTH_WARNING =
  "GRANE_CERT_SNOWFLAKE_PASSWORD is set without GRANE_CERT_SNOWFLAKE_PRIVATE_KEY. " +
  "That value is a password or a PAT (not distinguishable). " +
  "Password-only sign-in is being phased out " +
  "(https://docs.snowflake.com/en/user-guide/security-mfa-rollout). " +
  "A user with no TYPE counts as human (CREATE USER without TYPE creates PERSON) " +
  "and needs MFA, so an automated certify run will fail. " +
  "Prefer TYPE=SERVICE with key-pair auth. A PAT still requires TYPE=SERVICE and a network policy.";

export const SNOWFLAKE_PRIVATE_KEY_ENV = "GRANE_CERT_SNOWFLAKE_PRIVATE_KEY";
export const SNOWFLAKE_PRIVATE_KEY_PASSPHRASE_ENV = "GRANE_CERT_SNOWFLAKE_PRIVATE_KEY_PASSPHRASE";
export const SNOWFLAKE_PASSWORD_ENV = "GRANE_CERT_SNOWFLAKE_PASSWORD";

export type SnowflakeSdkAuth =
  | { kind: "jwt"; authenticator: "SNOWFLAKE_JWT"; privateKey: string }
  | { kind: "password"; password: string; warning: string }
  | { kind: "missing" };

function looksLikePem(value: string): boolean {
  return /BEGIN [A-Z ]*PRIVATE KEY/.test(value);
}

function loadPem(value: string): string {
  const normalized = looksLikePem(value) ? value.replace(/\\n/g, "\n") : value;
  if (looksLikePem(normalized)) return normalized;
  try {
    if (!statSync(value).isFile()) {
      throw new Error(`${SNOWFLAKE_PRIVATE_KEY_ENV} is not a PEM document or a key file path.`);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`${SNOWFLAKE_PRIVATE_KEY_ENV} is not a PEM document or a readable key file path.`);
    }
    throw err;
  }
  return readFileSync(value, "utf8");
}

function decryptPem(pem: string, passphrase?: string): string {
  const key = createPrivateKey({
    key: pem,
    format: "pem",
    passphrase: passphrase || undefined,
  });
  return key.export({ format: "pem", type: "pkcs8" }).toString();
}

/** Resolve Snowflake *cert* auth from GRANE_CERT_* only. */
export function resolveSnowflakeCertAuth(env: NodeJS.Dict<string> = process.env): SnowflakeSdkAuth {
  const keyVal = env[SNOWFLAKE_PRIVATE_KEY_ENV]?.trim();
  const passphrase = env[SNOWFLAKE_PRIVATE_KEY_PASSPHRASE_ENV];
  if (keyVal) {
    return {
      kind: "jwt",
      authenticator: "SNOWFLAKE_JWT",
      privateKey: decryptPem(loadPem(keyVal), passphrase?.trim() || undefined),
    };
  }
  const password = env[SNOWFLAKE_PASSWORD_ENV]?.trim();
  if (password) {
    return { kind: "password", password, warning: SNOWFLAKE_PASSWORD_AUTH_WARNING };
  }
  return { kind: "missing" };
}

/** Fields spread into snowflake-sdk createConnection for certify. */
export function snowflakeSdkAuthFields(auth: SnowflakeSdkAuth): Record<string, unknown> {
  if (auth.kind === "jwt") {
    return { authenticator: "SNOWFLAKE_JWT", privateKey: auth.privateKey };
  }
  if (auth.kind === "password") return { password: auth.password };
  return {};
}

export function warnSnowflakePasswordAuth(
  auth: SnowflakeSdkAuth,
  warn: (msg: string) => void = console.warn,
): void {
  if (auth.kind === "password") warn(auth.warning);
}
