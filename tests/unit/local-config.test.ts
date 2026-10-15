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
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  localGraneConfigPath,
  readSetupTone,
  readSetupToneStrict,
  writeSetupTone,
} from "../../src/setup/local-config.js";

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
  });

  it("does not follow a planted config.json.tmp symlink (wx exclusive create)", () => {
    const home = tempDir();
    mkdirSync(join(home, ".grane"));
    const file = localGraneConfigPath(home);
    const outside = join(tempDir(), "sentinel.txt");
    writeFileSync(outside, "untouched\n");
    symlinkSync(outside, `${file}.tmp`);
    writeSetupTone(home, "plain");
    expect(readFileSync(outside, "utf8")).toBe("untouched\n");
    expect(lstatSync(`${file}.tmp`).isSymbolicLink()).toBe(true);
    expect(lstatSync(`${file}.tmp`).isFile()).toBe(false);
    expect(lstatSync(file).isSymbolicLink()).toBe(false);
    expect(lstatSync(file).isFile()).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ setup_tone: "plain" });
    expect(readSetupTone(home)).toBe("plain");
    const leftover = readdirSync(join(home, ".grane")).filter(
      (n) => n.endsWith(".tmp") && n !== "config.json.tmp",
    );
    expect(leftover).toEqual([]);
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

describe("readSetupToneStrict (MCP)", () => {
  it("never writes; missing file is null", () => {
    const home = tempDir();
    expect(readSetupToneStrict(home)).toBeNull();
    expect(existsSync(join(home, ".grane"))).toBe(false);
    writeSetupTone(home, "plain");
    const before = readFileSync(localGraneConfigPath(home), "utf8");
    expect(readSetupToneStrict(home)).toBe("plain");
    expect(readFileSync(localGraneConfigPath(home), "utf8")).toBe(before);
  });

  it("refuses a symlinked config.json with the same error as the writer", () => {
    const home = tempDir();
    const outside = join(tempDir(), "target.json");
    writeFileSync(outside, '{"setup_tone":"plain","secret":"keep"}\n');
    mkdirSync(join(home, ".grane"));
    const file = localGraneConfigPath(home);
    symlinkSync(outside, file);
    expect(() => writeSetupTone(home, "technical")).toThrow(/symlink|regular file/);
    expect(() => readSetupToneStrict(home)).toThrow(/symlink|regular file/);
    expect(readFileSync(outside, "utf8")).toBe('{"setup_tone":"plain","secret":"keep"}\n');
    expect(readSetupTone(home)).toBeNull();
  });

  it("refuses a symlinked ~/.grane directory with the same error as the writer", () => {
    const home = tempDir();
    const outside = tempDir();
    writeFileSync(join(outside, "config.json"), '{"setup_tone":"plain","secret":"keep"}\n');
    symlinkSync(outside, join(home, ".grane"));
    expect(() => writeSetupTone(home, "technical")).toThrow(/symlink|regular directory/);
    expect(() => readSetupToneStrict(home)).toThrow(/symlink|regular directory/);
    expect(readFileSync(join(outside, "config.json"), "utf8")).toBe(
      '{"setup_tone":"plain","secret":"keep"}\n',
    );
    expect(readSetupTone(home)).toBeNull();
  });

  it("refuses invalid JSON with the same error as the writer and does not write", () => {
    const home = tempDir();
    const file = localGraneConfigPath(home);
    mkdirSync(join(home, ".grane"));
    writeFileSync(file, "{nope");
    expect(() => writeSetupTone(home, "plain")).toThrow(/not valid JSON/);
    expect(() => readSetupToneStrict(home)).toThrow(/not valid JSON/);
    expect(readFileSync(file, "utf8")).toBe("{nope");
  });

  it("refuses a JSON array with the same error as the writer and does not write", () => {
    const home = tempDir();
    const file = localGraneConfigPath(home);
    mkdirSync(join(home, ".grane"));
    writeFileSync(file, "[1]\n");
    expect(() => writeSetupTone(home, "plain")).toThrow(/JSON object/);
    expect(() => readSetupToneStrict(home)).toThrow(/JSON object/);
    expect(readFileSync(file, "utf8")).toBe("[1]\n");
  });
});
