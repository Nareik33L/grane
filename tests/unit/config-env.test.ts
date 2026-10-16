import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { interpolateEnv, loadConfig } from "../../src/config/load.js";
import { createPgPool } from "../../src/connectors/postgres/client.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("connection env interpolation", () => {
  it("expands ${VAR} and ${VAR:-default}", () => {
    const env = { DATABASE_URL: "postgres://ro@db/app" };
    expect(interpolateEnv("${DATABASE_URL}", env)).toBe("postgres://ro@db/app");
    expect(interpolateEnv("${MISSING:-fallback}", env)).toBe("fallback");
    expect(interpolateEnv("${MISSING}", env)).toBe("${MISSING}");
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

  it("loadConfig resolves a nested DATABASE_URL from the process env", () => {
    const dir = mkdtempSync(join(tmpdir(), "grane-env-"));
    dirs.push(dir);
    writeFileSync(
      join(dir, "grane.yml"),
      "connection:\n  type: postgres\n  url: ${DATABASE_URL}\n",
    );
    const prevUrl = process.env.DATABASE_URL;
    const prevPw = process.env.GRANE_DB_PASSWORD;
    process.env.DATABASE_URL = "postgres://grane_ro:${GRANE_DB_PASSWORD}@warehouse.example.com:5432/analytics";
    process.env.GRANE_DB_PASSWORD = "only-on-this-machine";
    try {
      const loaded = loadConfig(dir);
      expect(loaded.config.connection.url).toBe(
        "postgres://grane_ro:only-on-this-machine@warehouse.example.com:5432/analytics",
      );
      expect(loaded.config.connection.url).not.toContain("${");
      expect(() => createPgPool(loaded.config.connection)).not.toThrow(/unresolved environment variable/);
    } finally {
      if (prevUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = prevUrl;
      if (prevPw === undefined) delete process.env.GRANE_DB_PASSWORD;
      else process.env.GRANE_DB_PASSWORD = prevPw;
    }
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
    const prev = process.env.GRANE_DB_PASSWORD;
    process.env.GRANE_DB_PASSWORD = "only-on-this-machine";
    try {
      const loaded = loadConfig(dir);
      expect(loaded.config.connection.password).toBe("only-on-this-machine");
    } finally {
      if (prev === undefined) delete process.env.GRANE_DB_PASSWORD;
      else process.env.GRANE_DB_PASSWORD = prev;
    }
  });
});
