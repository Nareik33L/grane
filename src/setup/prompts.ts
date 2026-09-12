import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

export const BACK = Symbol.for("grane.setup.back");
export type PromptResult<T> = T | typeof BACK;

export interface Choice<T> {
  value: T;
  label: string;
  hint?: string;
}

export interface SelectOpts<T> {
  defaultValue?: T;
  /** When true, `b` / `back` returns BACK (not offered on the first step). */
  allowBack?: boolean;
}

export interface InputOpts {
  defaultValue?: string;
  allowEmpty?: boolean;
  allowBack?: boolean;
}

export interface ConfirmOpts {
  defaultYes?: boolean;
  allowBack?: boolean;
}

export interface Prompter {
  select<T>(question: string, choices: Choice<T>[], opts?: SelectOpts<T>): Promise<PromptResult<T>>;
  input(question: string, opts?: InputOpts): Promise<PromptResult<string>>;
  confirm(question: string, opts?: ConfirmOpts | boolean): Promise<PromptResult<boolean>>;
}

export interface PromptIo {
  log: (line: string) => void;
}

export function isBackToken(raw: string): boolean {
  const t = raw.trim().toLowerCase();
  return t === "back" || t === "b";
}

export function createReadlinePrompter(io: PromptIo): Prompter {
  async function ask(question: string): Promise<string> {
    const rl = createInterface({ input: stdin, output: stdout });
    try {
      return (await rl.question(question)).trim();
    } finally {
      rl.close();
    }
  }

  return {
    async select(question, choices, opts) {
      if (choices.length === 0) throw new Error("No choices to select.");
      const fallback =
        opts?.defaultValue !== undefined
          ? choices.find((c) => c.value === opts.defaultValue) ?? choices[0]!
          : choices[0]!;
      const allowBack = Boolean(opts?.allowBack);
      io.log("");
      io.log(question);
      io.log("");
      for (const [index, choice] of choices.entries()) {
        io.log(`  ${index + 1}) ${choice.label}`);
        if (choice.hint) io.log(`     ${choice.hint}`);
      }
      if (allowBack) {
        io.log("  b) Back — previous step");
      }
      io.log("");
      const raw = await ask(`Choice [${labelFor(fallback)}${allowBack ? " / back" : ""}]: `);
      if (!raw) return fallback.value;
      if (allowBack && isBackToken(raw)) return BACK;
      if (!allowBack && isBackToken(raw)) {
        throw new Error("This is the first step. Choose a number, or Ctrl-C to exit.");
      }
      const asNumber = Number(raw);
      if (Number.isInteger(asNumber) && asNumber >= 1 && asNumber <= choices.length) {
        return choices[asNumber - 1]!.value;
      }
      const matched = choices.find(
        (c) =>
          String(c.value).toLowerCase() === raw.toLowerCase() ||
          c.label.toLowerCase() === raw.toLowerCase() ||
          c.label.toLowerCase().startsWith(raw.toLowerCase()),
      );
      if (matched) return matched.value;
      throw new Error(`Not a valid choice: "${raw}". Enter a number 1–${choices.length}${allowBack ? ", or back" : ""}.`);
    },

    async input(question, opts) {
      const allowBack = Boolean(opts?.allowBack);
      const extra = [
        opts?.defaultValue ? `[${opts.defaultValue}]` : null,
        allowBack ? "or back" : null,
      ].filter(Boolean);
      const suffix = extra.length > 0 ? ` (${extra.join(" ")})` : "";
      io.log("");
      const raw = await ask(`${question}${suffix}: `);
      if (allowBack && isBackToken(raw)) return BACK;
      if (!raw) {
        if (opts?.defaultValue !== undefined) return opts.defaultValue;
        if (opts?.allowEmpty) return "";
        throw new Error(allowBack ? "A value is required (or type back)." : "A value is required.");
      }
      return raw;
    },

    async confirm(question, opts = true) {
      const resolved: ConfirmOpts = typeof opts === "boolean" ? { defaultYes: opts } : opts;
      const defaultYes = resolved.defaultYes !== false;
      const allowBack = Boolean(resolved.allowBack);
      const hint = `${defaultYes ? "Y/n" : "y/N"}${allowBack ? " / back" : ""}`;
      io.log("");
      const raw = (await ask(`${question} [${hint}]: `)).toLowerCase();
      if (allowBack && isBackToken(raw)) return BACK;
      if (!raw) return defaultYes;
      if (raw === "y" || raw === "yes") return true;
      if (raw === "n" || raw === "no") return false;
      throw new Error(`Answer yes or no${allowBack ? ", or back" : ""} (got "${raw}").`);
    },
  };
}

/** Queue-based prompter for tests and scripted non-TTY flows. */
export function scriptedPrompter(answers: {
  select?: unknown[];
  input?: string[];
  confirm?: Array<boolean | typeof BACK>;
}): Prompter {
  const selectQ = [...(answers.select ?? [])];
  const inputQ = [...(answers.input ?? [])];
  const confirmQ = [...(answers.confirm ?? [])];
  return {
    async select(_question, choices, opts) {
      const next = selectQ.shift();
      if (next === BACK || next === "back" || next === "b") return BACK;
      if (next !== undefined) return next as never;
      if (opts?.defaultValue !== undefined) return opts.defaultValue;
      return choices[0]!.value;
    },
    async input(_question, opts) {
      const next = inputQ.shift();
      if (next === "back" || next === "b") return BACK;
      if (next !== undefined) return next;
      if (opts?.defaultValue !== undefined) return opts.defaultValue;
      if (opts?.allowEmpty) return "";
      throw new Error("scriptedPrompter: no more input answers.");
    },
    async confirm(_question, opts = true) {
      const defaultYes = typeof opts === "boolean" ? opts : opts.defaultYes !== false;
      const next = confirmQ.shift();
      if (next === BACK) return BACK;
      return next ?? defaultYes;
    },
  };
}

function labelFor<T>(choice: Choice<T>): string {
  return `1=${choice.label}`;
}
