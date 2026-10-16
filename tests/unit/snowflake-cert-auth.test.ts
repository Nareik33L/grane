import { generateKeyPairSync } from "node:crypto";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cloudCertCredentialsAvailable, missingCertEnvVars } from "../../src/certify/env.js";
import {
  resolveSnowflakeCertAuth,
  SNOWFLAKE_PASSWORD_AUTH_WARNING,
  snowflakeSdkAuthFields,
  warnSnowflakePasswordAuth,
} from "../../src/connectors/snowflake-auth.js";

function pemPair(passphrase?: string): { privatePem: string; encrypted?: string } {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  if (!passphrase) return { privatePem };
  const encrypted = privateKey.export({ type: "pkcs8", format: "pem", cipher: "aes-256-cbc", passphrase }).toString();
  return { privatePem, encrypted };
}

describe("Snowflake cert key-pair auth (P0-2)", () => {
  it("names the failure: password-only / no TYPE user needs MFA so an automated certify run will fail", () => {
    expect(SNOWFLAKE_PASSWORD_AUTH_WARNING).toMatch(/Password-only sign-in is being phased out/);
    expect(SNOWFLAKE_PASSWORD_AUTH_WARNING).toMatch(/https:\/\/docs\.snowflake\.com\/en\/user-guide\/security-mfa-rollout/);
    expect(SNOWFLAKE_PASSWORD_AUTH_WARNING).toMatch(/user with no TYPE counts as human/);
    expect(SNOWFLAKE_PASSWORD_AUTH_WARNING).toMatch(/needs MFA, so an automated certify run will fail/);
    expect(SNOWFLAKE_PASSWORD_AUTH_WARNING).toMatch(/TYPE=SERVICE/);
  });

  it("available() with key-pair and no password; password-only still available but warns", () => {
    const base = {
      GRANE_CERT_SNOWFLAKE_ACCOUNT: "xy12345",
      GRANE_CERT_SNOWFLAKE_USER: "GRANE_CERT",
      GRANE_CERT_SNOWFLAKE_WAREHOUSE: "CERT_WH",
      GRANE_CERT_SNOWFLAKE_DATABASE: "CERT_DB",
    };
    expect(cloudCertCredentialsAvailable("snowflake", base).available).toBe(false);
    expect(missingCertEnvVars("snowflake", base)).toContain(
      "GRANE_CERT_SNOWFLAKE_PASSWORD or GRANE_CERT_SNOWFLAKE_PRIVATE_KEY",
    );
    expect(
      cloudCertCredentialsAvailable("snowflake", { ...base, GRANE_CERT_SNOWFLAKE_PRIVATE_KEY: "/tmp/rsa_key.p8" })
        .available,
    ).toBe(true);
    expect(
      cloudCertCredentialsAvailable("snowflake", { ...base, GRANE_CERT_SNOWFLAKE_PASSWORD: "legacy" }).available,
    ).toBe(true);

    const warned: string[] = [];
    const passwordAuth = resolveSnowflakeCertAuth({ GRANE_CERT_SNOWFLAKE_PASSWORD: "legacy" });
    warnSnowflakePasswordAuth(passwordAuth, (msg) => warned.push(msg));
    expect(passwordAuth.kind).toBe("password");
    expect(warned).toEqual([SNOWFLAKE_PASSWORD_AUTH_WARNING]);
  });

  it("loads PKCS8 PEM in memory and from a 0600 path; passphrase decrypts", () => {
    const { privatePem, encrypted } = pemPair("s3cret");
    const jwt = resolveSnowflakeCertAuth({ GRANE_CERT_SNOWFLAKE_PRIVATE_KEY: privatePem });
    expect(jwt.kind).toBe("jwt");
    if (jwt.kind !== "jwt") return;
    expect(jwt.authenticator).toBe("SNOWFLAKE_JWT");
    expect(jwt.privateKey).toMatch(/BEGIN PRIVATE KEY/);
    expect(snowflakeSdkAuthFields(jwt).password).toBeUndefined();

    const dir = mkdtempSync(join(tmpdir(), "grane-sf-key-"));
    const path = join(dir, "rsa_key.p8");
    writeFileSync(path, privatePem);
    chmodSync(path, 0o600);
    const fromPath = resolveSnowflakeCertAuth({ GRANE_CERT_SNOWFLAKE_PRIVATE_KEY: path });
    expect(fromPath.kind).toBe("jwt");

    const enc = resolveSnowflakeCertAuth({
      GRANE_CERT_SNOWFLAKE_PRIVATE_KEY: encrypted,
      GRANE_CERT_SNOWFLAKE_PRIVATE_KEY_PASSPHRASE: "s3cret",
    });
    expect(enc.kind).toBe("jwt");
    if (enc.kind === "jwt") expect(enc.privateKey).toMatch(/BEGIN PRIVATE KEY/);

    const keyWins = resolveSnowflakeCertAuth({
      GRANE_CERT_SNOWFLAKE_PRIVATE_KEY: privatePem,
      GRANE_CERT_SNOWFLAKE_PASSWORD: "legacy",
    });
    expect(keyWins.kind).toBe("jwt");
  });
});
