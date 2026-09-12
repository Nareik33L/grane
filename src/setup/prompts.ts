import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

export interface Choice<T> {
  value: T;
  label: string;
  hint?: string;
}

export interface Prompter {
  select<T>(question: string, choices: Choice<T>[], opts?: { defaultValue?: T }): Promise<T>;
  input(question: string, opts?: { defaultValue?: string; allowEmpty?: boolean }): Promise<string>;
  confirm(question: string, defaultYes?: boolean): Promise<boolean>;
}

export interface PromptIo {
  log: (line: string) => void;
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
      io.log("");
      io.log(question);
      io.log("");
      for (const [index, choice] of choices.entries()) {
        io.log(`  ${index + 1}) ${choice.label}`);
        if (choice.hint) io.log(`     ${choice.hint}`);
      }
      io.log("");
      const raw = await ask(`Choice [${labelFor(fallback)}]: `);
      if (!raw) return fallback.value;
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
      throw new Error(`Not a valid choice: "${raw}". Enter a number 1–${choices.length}.`);
    },

    async input(question, opts) {
      const suffix = opts?.defaultValue ? ` [${opts.defaultValue}]` : "";
      io.log("");
      const raw = await ask(`${question}${suffix}: `);
      if (!raw) {
        if (opts?.defaultValue !== undefined) return opts.defaultValue;
        if (opts?.allowEmpty) return "";
        throw new Error("A value is required.");
      }
      return raw;
    },

    async confirm(question, defaultYes = true) {
      const hint = defaultYes ? "Y/n" : "y/N";
      io.log("");
      const raw = (await ask(`${question} [${hint}]: `)).toLowerCase();
      if (!raw) return defaultYes;
      if (raw === "y" || raw === "yes") return true;
      if (raw === "n" || raw === "no") return false;
      throw new Error(`Answer yes or no (got "${raw}").`);
    },
  };
}

/** Queue-based prompter for tests and scripted non-TTY flows. */
export function scriptedPrompter(answers: {
  select?: unknown[];
  input?: string[];
  confirm?: boolean[];
}): Prompter {
  const selectQ = [...(answers.select ?? [])];
  const inputQ = [...(answers.input ?? [])];
  const confirmQ = [...(answers.confirm ?? [])];
  return {
    async select(_question, choices, opts) {
      const next = selectQ.shift();
      if (next !== undefined) return next as never;
      if (opts?.defaultValue !== undefined) return opts.defaultValue;
      return choices[0]!.value;
    },
    async input(_question, opts) {
      const next = inputQ.shift();
      if (next !== undefined) return next;
      if (opts?.defaultValue !== undefined) return opts.defaultValue;
      if (opts?.allowEmpty) return "";
      throw new Error("scriptedPrompter: no more input answers.");
    },
    async confirm(_question, defaultYes = true) {
      const next = confirmQ.shift();
      return next ?? defaultYes;
    },
  };
}

function labelFor<T>(choice: Choice<T>): string {
  return `1=${choice.label}`;
}
