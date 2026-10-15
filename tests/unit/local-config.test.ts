import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  localGraneConfigPath,
  readSetupTone,
  writeSetupTone,
} from "../../src/setup/local-config.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const temps: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "grane-local-cfg-"));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  temps.length = 0;
});

describe("writeSetupTone", () => {
  it("writes atomically as a regular file with mode 0600 and keeps extra keys", () => {
    const home = tempDir();
    writeSetupTone(home, "plain");
    const file = localGraneConfigPath(home);
    const st = lstatSync(file);
    expect(st.isSymbolicLink()).toBe(false);
    expect(st.isFile()).toBe(true);
    expect(st.mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ setup_tone: "plain" });
    expect(readdirSync(join(home, ".grane")).filter((n) => n.endsWith(".tmp"))).toEqual([]);

    writeFileSync(file, `${JSON.stringify({ setup_tone: "plain", keep: true }, null, 2)}\n`);
    writeSetupTone(home, "technical");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ setup_tone: "technical", keep: true });
    expect(lstatSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(file).isFile()).toBe(true);
    expect(readdirSync(join(home, ".grane")).filter((n) => n.endsWith(".tmp"))).toEqual([]);
    expect(readFileSync(join(ROOT, "src/setup/local-config.ts"), "utf8")).toMatch(/flag:\s*"wx"/);
  });

  it("refuses a symlinked config.json and leaves the target untouched", () => {
    const home = tempDir();
    const outside = join(tempDir(), "target.json");
    writeFileSync(outside, '{"secret":"keep"}\n');
    mkdirSync(join(home, ".grane"));
    const file = localGraneConfigPath(home);
    symlinkSync(outside, file);
    expect(() => writeSetupTone(home, "plain")).toThrow(/symlink|regular file/);
    expect(readFileSync(outside, "utf8")).toBe('{"secret":"keep"}\n');
    expect(lstatSync(file).isSymbolicLink()).toBe(true);
    expect(readSetupTone(home)).toBeNull();
  });

  it("refuses a symlinked ~/.grane directory and leaves the target untouched", () => {
    const home = tempDir();
    const outside = tempDir();
    writeFileSync(join(outside, "config.json"), '{"secret":"keep"}\n');
    symlinkSync(outside, join(home, ".grane"));
    expect(() => writeSetupTone(home, "plain")).toThrow(/symlink|regular directory/);
    expect(readFileSync(join(outside, "config.json"), "utf8")).toBe('{"secret":"keep"}\n');
    expect(lstatSync(join(home, ".grane")).isSymbolicLink()).toBe(true);
    expect(existsSync(join(outside, "other"))).toBe(false);
    expect(readSetupTone(home)).toBeNull();
  });

  it("refuses invalid JSON and does not overwrite the file", () => {
    const home = tempDir();
    const file = localGraneConfigPath(home);
    mkdirSync(join(home, ".grane"));
    writeFileSync(file, "{nope");
    expect(() => writeSetupTone(home, "plain")).toThrow(/not valid JSON/);
    expect(() => writeSetupTone(home, "plain")).toThrow(/Fix that file or delete it/);
    expect(readFileSync(file, "utf8")).toBe("{nope");
  });

  it("refuses a JSON array and does not overwrite the file", () => {
    const home = tempDir();
    const file = localGraneConfigPath(home);
    mkdirSync(join(home, ".grane"));
    writeFileSync(file, "[1]\n");
    expect(() => writeSetupTone(home, "plain")).toThrow(/JSON object/);
    expect(readFileSync(file, "utf8")).toBe("[1]\n");
  });
});
