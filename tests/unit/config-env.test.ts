import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { interpolateEnv, loadConfig } from "../../src/config/load.js";
import { createPgPool } from "../../src/connectors/postgres/client.js";
import { GraneError } from "../../src/errors.js";

const LOAD_SRC = join(dirname(fileURLToPath(import.meta.url)), "../../src/config/load.ts");

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const prev: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(vars)) {
    prev[name] = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    fn();
  } finally {
    for (const [name, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

function expectUnsetOnly(err: unknown, name: string, secrets: string[]): void {
  expect(err).toBeInstanceOf(GraneError);
  const message = (err as Error).message;
  expect(message).toBe(`Unset environment variable: ${name}`);
  expect(message).toContain(name);
  expect(message).not.toMatch(/postgres:\/\//i);
  expect(message).not.toMatch(/mysql:\/\//i);
  expect(message).not.toContain("@");
  expect(message).not.toContain("://");
  for (const secret of secrets) {
    expect(message).not.toContain(secret);
  }
}

function passwordOf(url: string): string {
  const parsed = new URL(url.replace(/^postgres(ql)?:/i, "http:"));
  return decodeURIComponent(parsed.password);
}

describe("connection env interpolation", () => {
  it("expands ${VAR} and ${VAR:-default}", () => {
    const env = { DATABASE_URL: "postgres://ro@db/app" };
    expect(interpolateEnv("${DATABASE_URL}", env)).toBe("postgres://ro@db/app");
    expect(interpolateEnv("${MISSING:-fallback}", env)).toBe("fallback");
  });

  it("expands ${GRANE_DB_PASSWORD} inside ${DATABASE_URL} (MCP template DSN)", () => {
    const env = {
      DATABASE_URL: "postgres://grane_ro:${GRANE_DB_PASSWORD}@warehouse.example.com:5432/analytics",
      GRANE_DB_PASSWORD: "only-on-this-machine",
    };
    expect(interpolateEnv("${DATABASE_URL}", env)).toBe(
      "postgres://grane_ro:only-on-this-machine@warehouse.example.com:5432/analytics",
    );
  });

  it("p${GITHUB_TOKEN}x must never pull in the token", () => {
    const env = {
      DATABASE_URL: "postgres://u:${GRANE_DB_PASSWORD}@h/db",
      GRANE_DB_PASSWORD: "p${GITHUB_TOKEN}x",
      GITHUB_TOKEN: "ghs_should_never_appear",
    };
    const url = interpolateEnv("${DATABASE_URL}", env) as string;
    expect(url).not.toContain("ghs_should_never_appear");
    expect(passwordOf(url)).toBe("p${GITHUB_TOKEN}x");
  });

  it("nested default ${NOPE:-${GITHUB_TOKEN}} must not pull in another variable", () => {
    const env = { GITHUB_TOKEN: "ghs_should_never_appear" };
    const result = interpolateEnv("${NOPE:-${GITHUB_TOKEN}}", env);
    expect(result).not.toContain("ghs_should_never_appear");
  });

  it("literal pa${HOME}ss is unchanged unless the field opts in", () => {
    const env = { HOME: "/injected-home", PW: "pa${HOME}ss" };
    expect(interpolateEnv("${PW}", env, { field: "password" })).toBe("pa${HOME}ss");
    expect(interpolateEnv("pa${HOME}ss", env, { field: "password" })).toBe("pa/injected-homess");
  });

  it("self-reference A=x${A} must not loop", () => {
    expect(interpolateEnv("${A}", { A: "x${A}" })).toBe("x${A}");
  });

  it("fails if the depth is set back to 1 (YAML-only replace drops DATABASE_URL templates)", () => {
    const src = readFileSync(LOAD_SRC, "utf8");
    expect(src).not.toMatch(/for\s*\(\s*let\s+\w+\s*=\s*0\s*;\s*\w+\s*<\s*depth/);
    expect(src).not.toMatch(/\bdepth\s*=\s*1\b/);
    const env = {
      DATABASE_URL: "postgres://u:${GRANE_DB_PASSWORD}@h/db",
      GRANE_DB_PASSWORD: "only-on-this-machine",
    };
    expect(interpolateEnv("${DATABASE_URL}", env)).toBe("postgres://u:only-on-this-machine@h/db");
  });

  it("single pass: a substituted value containing ${OTHER} is never expanded again", () => {
    const env = {
      DATABASE_URL: "postgres://u:${GRANE_DB_PASSWORD}@h/db",
      GRANE_DB_PASSWORD: "p@ss${OTHER}",
      OTHER: "injected-secret",
    };
    const url = interpolateEnv("${DATABASE_URL}", env) as string;
    expect(url).not.toContain("injected-secret");
    expect(passwordOf(url)).toBe("p@ss${OTHER}");
  });

  it("malicious env value containing ${OTHER} does not inject", () => {
    const env = {
      USER: "admin${OTHER}",
      OTHER: "injected-secret",
    };
    const url = interpolateEnv("postgres://${USER}@h/db", env) as string;
    expect(url).not.toContain("injected-secret");
    expect(decodeURIComponent(new URL(url.replace(/^postgres:/, "http:")).username)).toBe(
      "admin${OTHER}",
    );
  });

  it("does not follow ${A} → ${B} → secret chains (no recursion)", () => {
    const env = {
      A: "${B}",
      B: "${C}",
      C: "injected-secret",
    };
    expect(interpolateEnv("${A}", env)).toBe("${B}");
    expect(interpolateEnv("${A}", env)).not.toContain("injected-secret");
  });

  it("URL-encodes a password like a@b:c/d#e?f", () => {
    const special = "a@b:c/d#e?f";
    const env = {
      DATABASE_URL: "postgres://grane_ro:${GRANE_DB_PASSWORD}@warehouse.example.com:5432/analytics",
      GRANE_DB_PASSWORD: special,
    };
    const url = interpolateEnv("${DATABASE_URL}", env) as string;
    expect(url).toContain(`:${encodeURIComponent(special)}@`);
    expect(url).not.toContain(`:${special}@`);
    expect(passwordOf(url)).toBe(special);
  });

  it("URL-encodes substituted values inside URL userinfo/password", () => {
    const special = "p@ss:w/rd?#%[]";
    const env = {
      DATABASE_URL: "postgres://grane_ro:${GRANE_DB_PASSWORD}@warehouse.example.com:5432/analytics",
      GRANE_DB_PASSWORD: special,
    };
    const url = interpolateEnv("${DATABASE_URL}", env) as string;
    expect(url).toContain(`:${encodeURIComponent(special)}@`);
    expect(url).not.toContain(`:${special}@`);
    expect(passwordOf(url)).toBe(special);
    expect(() => new URL(url.replace(/^postgres:/, "http:"))).not.toThrow();
  });

  it("URL-encodes userinfo when the YAML is a URL template", () => {
    const special = "a@b:c/#?%";
    const env = { GRANE_DB_PASSWORD: special };
    const url = interpolateEnv("postgres://u:${GRANE_DB_PASSWORD}@h/db", env, { field: "url" }) as string;
    expect(url).toBe(`postgres://u:${encodeURIComponent(special)}@h/db`);
    expect(passwordOf(url)).toBe(special);
  });

  it("does not encode a discrete connection.password field", () => {
    const special = "p@ss:w/rd";
    expect(interpolateEnv("${GRANE_DB_PASSWORD}", { GRANE_DB_PASSWORD: special }, { field: "password" })).toBe(
      special,
    );
  });

  it("refuses an unset referenced variable naming only that variable", () => {
    const secret = "super-secret-dsn-password";
    const env = { GRANE_DB_PASSWORD: secret };
    try {
      interpolateEnv("postgres://u:${MISSING_DB_URL}@h/db", env);
      throw new Error("expected unset variable to refuse");
    } catch (err) {
      expectUnsetOnly(err, "MISSING_DB_URL", [secret, "postgres://", "h/db"]);
    }
  });

  it("unset DATABASE_URL names DATABASE_URL only and does not echo other secrets", () => {
    const secret = "only-on-this-machine";
    try {
      interpolateEnv("${DATABASE_URL}", { GRANE_DB_PASSWORD: secret });
      throw new Error("expected unset variable to refuse");
    } catch (err) {
      expectUnsetOnly(err, "DATABASE_URL", [secret]);
    }
  });

  it("unset password inside a template URL names the password variable only", () => {
    const env = {
      DATABASE_URL: "postgres://grane_ro:${GRANE_DB_PASSWORD}@warehouse.example.com:5432/analytics",
    };
    try {
      interpolateEnv("${DATABASE_URL}", env);
      throw new Error("expected unset variable to refuse");
    } catch (err) {
      expectUnsetOnly(err, "GRANE_DB_PASSWORD", [
        "postgres://",
        "warehouse.example.com",
        "analytics",
        "grane_ro",
      ]);
    }
  });

  it("loadConfig resolves a nested DATABASE_URL from the process env", () => {
    const dir = mkdtempSync(join(tmpdir(), "grane-env-"));
    dirs.push(dir);
    writeFileSync(
      join(dir, "grane.yml"),
      "connection:\n  type: postgres\n  url: ${DATABASE_URL}\n",
    );
    withEnv(
      {
        DATABASE_URL: "postgres://grane_ro:${GRANE_DB_PASSWORD}@warehouse.example.com:5432/analytics",
        GRANE_DB_PASSWORD: "only-on-this-machine",
      },
      () => {
        const loaded = loadConfig(dir);
        expect(loaded.config.connection.url).toBe(
          "postgres://grane_ro:only-on-this-machine@warehouse.example.com:5432/analytics",
        );
        expect(loaded.config.connection.url).not.toContain("${");
        expect(() => createPgPool(loaded.config.connection)).not.toThrow(/unresolved environment variable/);
      },
    );
  });

  it("loadConfig encodes special characters in a template DATABASE_URL password", () => {
    const dir = mkdtempSync(join(tmpdir(), "grane-enc-"));
    dirs.push(dir);
    writeFileSync(
      join(dir, "grane.yml"),
      "connection:\n  type: postgres\n  url: ${DATABASE_URL}\n",
    );
    const special = "p@ss:w/rd?#%";
    withEnv(
      {
        DATABASE_URL: "postgres://grane_ro:${GRANE_DB_PASSWORD}@warehouse.example.com:5432/analytics",
        GRANE_DB_PASSWORD: special,
      },
      () => {
        const loaded = loadConfig(dir);
        const url = loaded.config.connection.url!;
        expect(url).toContain(encodeURIComponent(special));
        expect(passwordOf(url)).toBe(special);
        expect(() => createPgPool(loaded.config.connection)).not.toThrow();
      },
    );
  });

  it("loadConfig refuses unset connection vars without echoing the URL", () => {
    const dir = mkdtempSync(join(tmpdir(), "grane-unset-"));
    dirs.push(dir);
    writeFileSync(
      join(dir, "grane.yml"),
      "connection:\n  type: postgres\n  url: postgres://u:${GRANE_DB_PASSWORD}@secret-host.example/db\n",
    );
    withEnv({ GRANE_DB_PASSWORD: undefined }, () => {
      try {
        loadConfig(dir);
        throw new Error("expected unset variable to refuse");
      } catch (err) {
        expectUnsetOnly(err, "GRANE_DB_PASSWORD", ["secret-host.example", "postgres://", "u:"]);
      }
    });
  });

  it("discrete connection.password: ${GRANE_DB_PASSWORD} still interpolates", () => {
    const dir = mkdtempSync(join(tmpdir(), "grane-pw-"));
    dirs.push(dir);
    writeFileSync(
      join(dir, "grane.yml"),
      [
        "connection:",
        "  type: postgres",
        "  host: warehouse.example.com",
        "  port: 5432",
        "  database: analytics",
        "  user: grane_ro",
        "  password: ${GRANE_DB_PASSWORD}",
        "",
      ].join("\n"),
    );
    withEnv({ GRANE_DB_PASSWORD: "only-on-this-machine" }, () => {
      const loaded = loadConfig(dir);
      expect(loaded.config.connection.password).toBe("only-on-this-machine");
    });
  });

  it("literal $ in connection URLs is unchanged (not ${VAR})", () => {
    const env = { HOME: "/injected", DATABASE_URL: "postgres://ro@db/app?app=$HOME" };
    expect(interpolateEnv("postgres://ro@db/app$suffix", env)).toBe("postgres://ro@db/app$suffix");
    expect(interpolateEnv("${DATABASE_URL}", env)).toBe("postgres://ro@db/app?app=$HOME");
    expect(interpolateEnv("$DATABASE_URL", env)).toBe("$DATABASE_URL");
  });

  it("expands only connection fields; metric SQL and literal $ stay as authored", () => {
    const dir = mkdtempSync(join(tmpdir(), "grane-literal-"));
    dirs.push(dir);
    writeFileSync(
      join(dir, "grane.yml"),
      [
        "connection:",
        "  type: postgres",
        "  url: postgres://ro@db/app$suffix",
        "entities:",
        "  orders:",
        "    table: orders",
        "    primary_key: id",
        "metrics:",
        "  revenue:",
        "    entity: orders",
        "    type: sum",
        "    sql: ${INJECT}",
        "audit:",
        "  path: ${MISSING_AUDIT_PATH}",
        "",
      ].join("\n"),
    );
    withEnv({ INJECT: "injected-secret", MISSING_AUDIT_PATH: undefined, HOME: "/injected" }, () => {
      const loaded = loadConfig(dir);
      expect(loaded.config.connection.url).toBe("postgres://ro@db/app$suffix");
      expect(loaded.config.metrics.revenue?.sql).toBe("${INJECT}");
      expect(loaded.config.audit.path).toBe("${MISSING_AUDIT_PATH}");
    });
  });

  it("loadConfig leaves pa${HOME}ss in metric SQL; connection.password opts in", () => {
    const dir = mkdtempSync(join(tmpdir(), "grane-home-"));
    dirs.push(dir);
    writeFileSync(
      join(dir, "grane.yml"),
      [
        "connection:",
        "  type: postgres",
        "  host: warehouse.example.com",
        "  database: analytics",
        "  user: grane_ro",
        "  password: pa${HOME}ss",
        "entities:",
        "  orders: { table: orders, primary_key: id }",
        "metrics:",
        "  revenue:",
        "    entity: orders",
        "    type: sum",
        "    sql: pa${HOME}ss",
        "",
      ].join("\n"),
    );
    withEnv({ HOME: "xx" }, () => {
      const loaded = loadConfig(dir);
      expect(loaded.config.connection.password).toBe("paxxss");
      expect(loaded.config.metrics.revenue?.sql).toBe("pa${HOME}ss");
    });
  });
});
