import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { interpolateEnv, loadConfig } from "../../src/config/load.js";
import { writeInitProject } from "../../src/cli/init-project.js";
import { graneConfigSchema } from "../../src/config/schema.js";
import { createPgPool } from "../../src/connectors/postgres/client.js";
import { createConnector } from "../../src/connectors/create.js";
import { GraneError } from "../../src/errors.js";
import { runDoctor } from "../../src/mcp/connect/doctor.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const LOAD_SRC = join(ROOT, "src/config/load.ts");

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

function envWithoutDatabaseUrl(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = { ...process.env, ...extra };
  delete env.DATABASE_URL;
  return env;
}

describe("connection env interpolation", () => {
  it("expands ${VAR} and ${VAR:-default}", () => {
    const env = { DATABASE_URL: "postgres://ro@db/app" };
    expect(interpolateEnv("${DATABASE_URL}", env)).toBe("postgres://ro@db/app");
    expect(interpolateEnv("${MISSING:-fallback}", env)).toBe("fallback");
  });

  it("does not expand ${VAR} inside an env DATABASE_URL value", () => {
    const env = {
      DATABASE_URL: "postgres://grane_ro:${GRANE_DB_PASSWORD}@warehouse.example.com:5432/analytics",
      GRANE_DB_PASSWORD: "only-on-this-machine",
    };
    expect(interpolateEnv("${DATABASE_URL}", env)).toBe(
      "postgres://grane_ro:${GRANE_DB_PASSWORD}@warehouse.example.com:5432/analytics",
    );
    expect(interpolateEnv("${DATABASE_URL}", env)).not.toContain("only-on-this-machine");
  });

  it("p${GITHUB_TOKEN}x in a YAML userinfo ${VAR} is encoded and never expanded", () => {
    const env = {
      GRANE_DB_PASSWORD: "p${GITHUB_TOKEN}x",
      GITHUB_TOKEN: "ghs_should_never_appear",
    };
    const url = interpolateEnv("postgres://u:${GRANE_DB_PASSWORD}@h/db", env, { field: "url" }) as string;
    expect(url).not.toContain("ghs_should_never_appear");
    expect(passwordOf(url)).toBe("p${GITHUB_TOKEN}x");
    expect(url).toContain(encodeURIComponent("p${GITHUB_TOKEN}x"));
  });

  it("p${GITHUB_TOKEN}x in an env DSN password stays literal", () => {
    const env = {
      DATABASE_URL: "postgres://u:p${GITHUB_TOKEN}x@h/db",
      GITHUB_TOKEN: "ghs_should_never_appear",
    };
    const url = interpolateEnv("${DATABASE_URL}", env, { field: "url" }) as string;
    expect(url).toBe("postgres://u:p${GITHUB_TOKEN}x@h/db");
    expect(url).not.toContain("ghs_should_never_appear");
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

  it("fails if a depth loop is reintroduced (substituted values must not be re-scanned)", () => {
    const src = readFileSync(LOAD_SRC, "utf8");
    expect(src).not.toMatch(/for\s*\(\s*let\s+\w+\s*=\s*0\s*;\s*\w+\s*<\s*depth/);
    expect(src).not.toMatch(/\bdepth\s*=\s*1\b/);
    expect(src).not.toMatch(/decodeURIComponent/);
    const env = {
      DATABASE_URL: "postgres://u:${GRANE_DB_PASSWORD}@h/db",
      GRANE_DB_PASSWORD: "only-on-this-machine",
    };
    expect(interpolateEnv("${DATABASE_URL}", env)).toBe("postgres://u:${GRANE_DB_PASSWORD}@h/db");
  });

  it("single pass: a substituted value containing ${OTHER} is never expanded again", () => {
    const env = {
      GRANE_DB_PASSWORD: "p@ss${OTHER}",
      OTHER: "injected-secret",
    };
    const url = interpolateEnv("postgres://u:${GRANE_DB_PASSWORD}@h/db", env, { field: "url" }) as string;
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

  it("URL-encodes a password like a@b:c/d#e?f in a YAML URL template", () => {
    const special = "a@b:c/d#e?f";
    const url = interpolateEnv(
      "postgres://grane_ro:${GRANE_DB_PASSWORD}@warehouse.example.com:5432/analytics",
      { GRANE_DB_PASSWORD: special },
      { field: "url" },
    ) as string;
    expect(url).toContain(`:${encodeURIComponent(special)}@`);
    expect(url).not.toContain(`:${special}@`);
    expect(passwordOf(url)).toBe(special);
  });

  it("URL-encodes substituted values inside YAML URL userinfo/password", () => {
    const special = "p@ss:w/rd?#%[]";
    const url = interpolateEnv(
      "postgres://grane_ro:${GRANE_DB_PASSWORD}@warehouse.example.com:5432/analytics",
      { GRANE_DB_PASSWORD: special },
      { field: "url" },
    ) as string;
    expect(url).toContain(`:${encodeURIComponent(special)}@`);
    expect(url).not.toContain(`:${special}@`);
    expect(passwordOf(url)).toBe(special);
    expect(() => new URL(url.replace(/^postgres:/, "http:"))).not.toThrow();
  });

  it("always encodes a raw YAML userinfo ${VAR} (100%40off is not treated as already encoded)", () => {
    const pw = "100%40off";
    const url = interpolateEnv("postgres://u:${PW}@h/db", { PW: pw }, { field: "url" }) as string;
    expect(url).toBe(`postgres://u:${encodeURIComponent(pw)}@h/db`);
    expect(url).toContain("100%2540off");
    expect(url).not.toMatch(/:100%40off@/);
    expect(passwordOf(url)).toBe(pw);
  });

  it("always encodes an already-percent-looking YAML userinfo ${VAR} (p%40ss → p%2540ss)", () => {
    const pw = "p%40ss";
    const url = interpolateEnv("postgres://u:${PW}@h/db", { PW: pw }, { field: "url" }) as string;
    expect(url).toBe(`postgres://u:${encodeURIComponent(pw)}@h/db`);
    expect(url).toContain("p%2540ss");
    expect(url).not.toMatch(/:p%40ss@/);
    expect(passwordOf(url)).toBe(pw);
  });

  it("complete env DSN is the opt-out: already-encoded p%40ss is not encoded again", () => {
    const env = { DATABASE_URL: "postgres://u:p%40ss@h/db" };
    expect(interpolateEnv("${DATABASE_URL}", env, { field: "url" })).toBe("postgres://u:p%40ss@h/db");
  });

  it("complete env DSN is the opt-out: 100%40off in the DSN is not re-encoded", () => {
    const env = { DATABASE_URL: "postgres://u:100%40off@h/db" };
    expect(interpolateEnv("${DATABASE_URL}", env, { field: "url" })).toBe("postgres://u:100%40off@h/db");
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

  it("unset password inside a YAML URL template names the password variable only", () => {
    try {
      interpolateEnv(
        "postgres://grane_ro:${GRANE_DB_PASSWORD}@warehouse.example.com:5432/analytics",
        {},
        { field: "url" },
      );
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

  it("loadConfig does not expand ${VAR} inside an env DATABASE_URL", () => {
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
          "postgres://grane_ro:${GRANE_DB_PASSWORD}@warehouse.example.com:5432/analytics",
        );
        expect(loaded.config.connection.url).not.toContain("only-on-this-machine");
        expect(() => createPgPool(loaded.config.connection)).not.toThrow();
      },
    );
  });

  it("loadConfig leaves a literal ${UPPER} in an env DSN password", () => {
    const dir = mkdtempSync(join(tmpdir(), "grane-literal-upper-"));
    dirs.push(dir);
    writeFileSync(
      join(dir, "grane.yml"),
      "connection:\n  type: postgres\n  url: ${DATABASE_URL}\n",
    );
    withEnv({ DATABASE_URL: "postgres://u:p${HOME}x@h/db", HOME: "/injected-home" }, () => {
      const loaded = loadConfig(dir);
      expect(loaded.config.connection.url).toBe("postgres://u:p${HOME}x@h/db");
      expect(loaded.config.connection.url).not.toContain("/injected-home");
      expect(() => createPgPool(loaded.config.connection)).not.toThrow();
      expect(() => createConnector(loaded.config.connection)).not.toThrow();
    });
  });

  it("loadConfig encodes special characters in a YAML URL-template password", () => {
    const dir = mkdtempSync(join(tmpdir(), "grane-enc-"));
    dirs.push(dir);
    writeFileSync(
      join(dir, "grane.yml"),
      "connection:\n  type: postgres\n  url: postgres://grane_ro:${GRANE_DB_PASSWORD}@warehouse.example.com:5432/analytics\n",
    );
    const special = "p@ss:w/rd?#%";
    withEnv({ GRANE_DB_PASSWORD: special }, () => {
      const loaded = loadConfig(dir);
      const url = loaded.config.connection.url!;
      expect(url).toContain(encodeURIComponent(special));
      expect(passwordOf(url)).toBe(special);
      expect(() => createPgPool(loaded.config.connection)).not.toThrow();
    });
  });

  it("loadConfig encodes 100%40off and p%40ss in YAML userinfo; env DSN is the opt-out", () => {
    const yamlDir = mkdtempSync(join(tmpdir(), "grane-pct-yaml-"));
    const dsnDir = mkdtempSync(join(tmpdir(), "grane-pct-dsn-"));
    dirs.push(yamlDir, dsnDir);
    writeFileSync(
      join(yamlDir, "grane.yml"),
      "connection:\n  type: postgres\n  url: postgres://u:${PW}@h/db\n",
    );
    writeFileSync(
      join(dsnDir, "grane.yml"),
      "connection:\n  type: postgres\n  url: ${DATABASE_URL}\n",
    );
    withEnv({ PW: "100%40off" }, () => {
      const url = loadConfig(yamlDir).config.connection.url!;
      expect(url).toBe(`postgres://u:${encodeURIComponent("100%40off")}@h/db`);
      expect(passwordOf(url)).toBe("100%40off");
    });
    withEnv({ PW: "p%40ss" }, () => {
      const url = loadConfig(yamlDir).config.connection.url!;
      expect(url).toBe(`postgres://u:${encodeURIComponent("p%40ss")}@h/db`);
      expect(passwordOf(url)).toBe("p%40ss");
    });
    withEnv({ DATABASE_URL: "postgres://u:p%40ss@h/db" }, () => {
      expect(loadConfig(dsnDir).config.connection.url).toBe("postgres://u:p%40ss@h/db");
    });
    withEnv({ DATABASE_URL: "postgres://u:100%40off@h/db" }, () => {
      expect(loadConfig(dsnDir).config.connection.url).toBe("postgres://u:100%40off@h/db");
    });
  });

  it("loadConfig leaves unset connection vars; createPgPool refuses without echoing the URL", () => {
    const dir = mkdtempSync(join(tmpdir(), "grane-unset-"));
    dirs.push(dir);
    writeFileSync(
      join(dir, "grane.yml"),
      "connection:\n  type: postgres\n  url: postgres://u:${GRANE_DB_PASSWORD}@secret-host.example/db\n",
    );
    withEnv({ GRANE_DB_PASSWORD: undefined }, () => {
      const loaded = loadConfig(dir);
      expect(loaded.config.connection.url).toBe(
        "postgres://u:${GRANE_DB_PASSWORD}@secret-host.example/db",
      );
      try {
        createPgPool(loaded.config.connection);
        throw new Error("expected unset variable to refuse at connect");
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

  it("createPgPool unresolved error names the variable and does not echo the URL", () => {
    const secret = "hunter2-s3cret";
    const host = "secret-host.internal";
    const url = `postgres://grane_ro:${secret}@${host}:5432/\${UNSET_DB}`;
    const connection = graneConfigSchema.parse({ connection: { type: "postgres", url } }).connection;
    try {
      createPgPool(connection);
      throw new Error("expected unset variable to refuse");
    } catch (err) {
      expectUnsetOnly(err, "UNSET_DB", [secret, host, "postgres://", "grane_ro", url]);
    }
  });

  it("loadConfig of init YAML succeeds when DATABASE_URL is unset", () => {
    const dir = mkdtempSync(join(tmpdir(), "grane-init-unset-"));
    dirs.push(dir);
    writeInitProject(dir);
    withEnv({ DATABASE_URL: undefined }, () => {
      const loaded = loadConfig(dir);
      expect(loaded.config.connection.url).toBe("${DATABASE_URL}");
      try {
        createPgPool(loaded.config.connection);
        throw new Error("expected connect-time refuse");
      } catch (err) {
        expectUnsetOnly(err, "DATABASE_URL", ["postgres://"]);
      }
    });
  });

  it("validate --offline succeeds when DATABASE_URL is unset", () => {
    const dir = mkdtempSync(join(tmpdir(), "grane-val-offline-"));
    dirs.push(dir);
    writeInitProject(dir);
    const cli = spawnSync("npx", ["tsx", "src/cli/index.ts", "-p", dir, "validate", "--offline"], {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 45_000,
      env: envWithoutDatabaseUrl(),
    });
    expect(cli.status, `${cli.stderr}\n${cli.stdout}`).toBe(0);
    expect(cli.stdout).toMatch(/0\/0 metrics valid/);
    expect(`${cli.stdout}\n${cli.stderr}`).not.toMatch(/Unset environment variable/);
  });

  it("doctor --json runs when DATABASE_URL is unset", () => {
    const dir = mkdtempSync(join(tmpdir(), "grane-doc-json-"));
    dirs.push(dir);
    writeInitProject(dir);
    const cli = spawnSync("npx", ["tsx", "src/cli/index.ts", "-p", dir, "doctor", "--json", "--offline"], {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 45_000,
      env: envWithoutDatabaseUrl({ GITHUB_TOKEN: "", GH_TOKEN: "" }),
    });
    expect(`${cli.stdout}\n${cli.stderr}`).not.toMatch(/Unset environment variable/);
    const body = JSON.parse(cli.stdout) as { ok: boolean; checks: unknown[] };
    expect(Array.isArray(body.checks)).toBe(true);
  });

  it("mcp doctor works when DATABASE_URL is unset", async () => {
    const dir = mkdtempSync(join(tmpdir(), "grane-mcp-doc-"));
    dirs.push(dir);
    writeInitProject(dir);
    const result = await withEnvAsync({ DATABASE_URL: undefined }, () =>
      runDoctor({
        projectDir: dir,
        offline: true,
        skipMcp: true,
        launch: { command: "grane", prefixArgs: [], source: "override" },
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.checks.find((c) => c.name === "project")?.ok).toBe(true);
    expect(result.checks.find((c) => c.name === "model")?.ok).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/Unset environment variable/);
  });
});

async function withEnvAsync<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const prev: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(vars)) {
    prev[name] = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [name, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}
