import { generateKeyPairSync } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { cloudCertCredentialsAvailable, missingCertEnvVars } from "../../src/certify/env.js";
import {
  resolveSnowflakeCertAuth,
  SNOWFLAKE_PASSWORD_AUTH_WARNING,
  snowflakeSdkAuthFields,
  warnSnowflakePasswordAuth,
} from "../../src/certify/snowflake-auth.js";
import { snowflakeRuntimeCreateOptions } from "../../src/connectors/snowflake.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

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
    expect(SNOWFLAKE_PASSWORD_AUTH_WARNING).toMatch(/password or a PAT/);
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

  it("snowflakeSdkAuthFields passes authenticator SNOWFLAKE_JWT to the driver", () => {
    const privateKey = "-----BEGIN PRIVATE KEY-----\nMII\n-----END PRIVATE KEY-----";
    const fields = snowflakeSdkAuthFields({
      kind: "jwt",
      authenticator: "SNOWFLAKE_JWT",
      privateKey,
    });
    expect(fields).toEqual({ authenticator: "SNOWFLAKE_JWT", privateKey });
    expect(fields).toHaveProperty("authenticator", "SNOWFLAKE_JWT");
    expect(fields).not.toHaveProperty("password");
    const authSrc = readFileSync(join(ROOT, "src/certify/snowflake-auth.ts"), "utf8");
    expect(authSrc).toMatch(
      /if \(auth\.kind === "jwt"\) \{\s*return \{ authenticator: "SNOWFLAKE_JWT", privateKey: auth\.privateKey \};/,
    );
    const engineSrc = readFileSync(join(ROOT, "tests/helpers/engines/snowflake-cert.ts"), "utf8");
    expect(engineSrc).toMatch(/\.\.\.snowflakeSdkAuthFields\(auth\)/);
  });

  it("runtime connector ignores GRANE_CERT_SNOWFLAKE_PRIVATE_KEY and uses connection.password", () => {
    const { privatePem } = pemPair();
    const saved = process.env.GRANE_CERT_SNOWFLAKE_PRIVATE_KEY;
    process.env.GRANE_CERT_SNOWFLAKE_PRIVATE_KEY = privatePem;
    try {
      const opts = snowflakeRuntimeCreateOptions({
        type: "snowflake",
        account: "xy12345",
        user: "runtime_user",
        password: "runtime-password",
        warehouse: "COMPUTE_WH",
        database: "ANALYTICS",
        schema: "PUBLIC",
        ssl_verify: true,
        pool_size: 5,
      });
      expect(opts).toEqual({
        account: "xy12345",
        username: "runtime_user",
        password: "runtime-password",
        warehouse: "COMPUTE_WH",
        database: "ANALYTICS",
        schema: "PUBLIC",
        role: undefined,
        application: "Grane",
      });
      expect(opts.authenticator).toBeUndefined();
      expect(opts.privateKey).toBeUndefined();
      expect(JSON.stringify(opts)).not.toMatch(/BEGIN PRIVATE KEY/);
    } finally {
      if (saved === undefined) delete process.env.GRANE_CERT_SNOWFLAKE_PRIVATE_KEY;
      else process.env.GRANE_CERT_SNOWFLAKE_PRIVATE_KEY = saved;
    }
  });

  it("runtime Snowflake connector never reads GRANE_CERT_* or the cert resolver", () => {
    const src = readFileSync(join(ROOT, "src/connectors/snowflake.ts"), "utf8");
    expect(src).not.toMatch(/GRANE_CERT/);
    expect(src).not.toMatch(/resolveSnowflakeCertAuth/);
    expect(src).not.toMatch(/snowflake-auth/);
    expect(src).not.toMatch(/SNOWFLAKE_PASSWORD_AUTH_WARNING/);
    expect(existsSync(join(ROOT, "src/connectors/snowflake-auth.ts"))).toBe(false);
  });

  it("runtime key-pair uses connection.private_key, not GRANE_CERT_*", () => {
    const { privatePem } = pemPair();
    const envPem = pemPair().privatePem;
    const saved = process.env.GRANE_CERT_SNOWFLAKE_PRIVATE_KEY;
    process.env.GRANE_CERT_SNOWFLAKE_PRIVATE_KEY = envPem;
    try {
      const opts = snowflakeRuntimeCreateOptions({
        type: "snowflake",
        account: "xy12345",
        user: "runtime_user",
        password: "ignored-when-key-set",
        private_key: privatePem,
        warehouse: "COMPUTE_WH",
        database: "ANALYTICS",
        schema: "PUBLIC",
        ssl_verify: true,
        pool_size: 5,
      });
      expect(opts.authenticator).toBe("SNOWFLAKE_JWT");
      expect(opts.password).toBeUndefined();
      expect(opts.privateKey).toMatch(/BEGIN PRIVATE KEY/);
      expect(String(opts.privateKey)).not.toContain(envPem);
    } finally {
      if (saved === undefined) delete process.env.GRANE_CERT_SNOWFLAKE_PRIVATE_KEY;
      else process.env.GRANE_CERT_SNOWFLAKE_PRIVATE_KEY = saved;
    }
  });

  it("runtime private_key errors never mention GRANE_CERT_*", () => {
    expect(() =>
      snowflakeRuntimeCreateOptions({
        type: "snowflake",
        account: "xy12345",
        user: "runtime_user",
        password: "runtime-password",
        private_key: "/no/such/grane-runtime-key.p8",
        warehouse: "COMPUTE_WH",
        database: "ANALYTICS",
        schema: "PUBLIC",
        ssl_verify: true,
        pool_size: 5,
      }),
    ).toThrow(/connection\.private_key/);
    try {
      snowflakeRuntimeCreateOptions({
        type: "snowflake",
        account: "xy12345",
        user: "runtime_user",
        password: "runtime-password",
        private_key: "/no/such/grane-runtime-key.p8",
        warehouse: "COMPUTE_WH",
        database: "ANALYTICS",
        schema: "PUBLIC",
        ssl_verify: true,
        pool_size: 5,
      });
    } catch (err) {
      expect(String(err)).toMatch(/connection\.private_key/);
      expect(String(err)).not.toMatch(/GRANE_CERT/);
    }
  });
});
