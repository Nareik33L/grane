/** Parse JSONC: line comments, block comments, and trailing commas. */
export function parseJsonc(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return {};
  return JSON.parse(stripJsonc(trimmed));
}

export function stripJsonc(input: string): string {
  let out = "";
  let i = 0;
  let inString = false;
  let escape = false;
  let inLineComment = false;
  let inBlockComment = false;

  while (i < input.length) {
    const c = input[i]!;
    const n = input[i + 1];

    if (inLineComment) {
      if (c === "\n") {
        inLineComment = false;
        out += c;
      }
      i += 1;
      continue;
    }
    if (inBlockComment) {
      if (c === "*" && n === "/") {
        inBlockComment = false;
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    if (inString) {
      out += c;
      if (escape) {
        escape = false;
      } else if (c === "\\") {
        escape = true;
      } else if (c === '"') {
        inString = false;
      }
      i += 1;
      continue;
    }
    if (c === "/" && n === "/") {
      inLineComment = true;
      i += 2;
      continue;
    }
    if (c === "/" && n === "*") {
      inBlockComment = true;
      i += 2;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      i += 1;
      continue;
    }
    out += c;
    i += 1;
  }

  return stripTrailingCommas(out);
}

function stripTrailingCommas(input: string): string {
  let out = "";
  let inString = false;
  let escape = false;
  for (let i = 0; i < input.length; i += 1) {
    const c = input[i]!;
    if (inString) {
      out += c;
      if (escape) {
        escape = false;
      } else if (c === "\\") {
        escape = true;
      } else if (c === '"') {
        inString = false;
      }
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    if (c === ",") {
      let j = i + 1;
      while (j < input.length && /\s/.test(input[j]!)) j += 1;
      const next = input[j];
      if (next === "}" || next === "]") continue;
    }
    out += c;
  }
  return out;
}
