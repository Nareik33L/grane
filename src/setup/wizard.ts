import { WAREHOUSE_TYPES, type WarehouseType } from "../connectors/dialect.js";
import { WAREHOUSE_CERTIFICATION } from "../connectors/certification.js";
import {
  connectionFields,
  describeConnection,
  engineHint,
  parseOwnDatabaseUrl,
  type ConnectionDraft,
} from "./connection.js";
import {
  assertLocalGraneConfigWritable,
  readSetupTone,
  writeSetupTone,
  type SetupTone,
} from "./local-config.js";
import type { DemoEngine, DemoYaml, SetupIo, SetupPath, StartChoice } from "./types.js";
import { BACK, type Choice, type Prompter } from "./prompts.js";
import { TONE_CHOICES, TONE_QUESTION, wizardCopy, type WizardCopy } from "./wizard-copy.js";

export interface WizardAnswers {
  path: SetupPath;
  engine?: WarehouseType;
  connection?: ConnectionDraft;
  client: string | null;
  demoEngine?: DemoEngine;
  demoYaml?: DemoYaml;
  tone: SetupTone;
}

export interface WizardOptions {
  io: SetupIo;
  prompt: Prompter;
  env: NodeJS.ProcessEnv;
  homeDir?: string;
  skipConnect?: boolean;
  connect?: string;
  /** Interactive `--path demo|own` skips the start question. */
  forcedPath?: SetupPath;
  /** Interactive `--postgres` starts on demo Postgres (YAML question unless `--authoring`). */
  postgres?: boolean;
  /** Interactive `--authoring` (requires `--postgres`) skips the YAML question. */
  authoring?: boolean;
  resolveClientId: (name: string) => string;
  listClients: () => Array<{ id: string; label: string }>;
}

/** @deprecated Merged into PATH_CHOICES (V2-16). Kept so existing imports compile. */
export const EXISTING_YAML_QUESTION = "Do you already have a Grane YAML?";

/** @deprecated Merged into PATH_CHOICES (V2-16). */
export const EXISTING_YAML_CHOICES: Choice<"yes" | "no">[] = [
  {
    value: "no",
    label: "No — set one up",
    hint: "Demo shop or connect your own warehouse.",
  },
  {
    value: "yes",
    label: "Yes — use the YAML I already have",
    hint: "Load, validate, inspect, then activate. No AI authoring.",
  },
];

export const PATH_QUESTION = "How do you want to start?";

export const CONFIRM_QUESTION = "Does this look right?";

export type { StartChoice };

export const DEMO_ENGINE_QUESTION = "Which demo warehouse?";

export const DEMO_ENGINE_CHOICES: Choice<DemoEngine>[] = [
  {
    value: "duckdb",
    label: "Local DuckDB",
    hint: "No database, no Docker. Today's demo shop (shipped YAML).",
  },
  {
    value: "postgres",
    label: "Demo Postgres",
    hint: "Preloaded sample data (Docker on localhost:5433). Then shipped YAML or build your own.",
  },
];

export const DEMO_YAML_QUESTION = "How should Grane learn the demo shop?";

export const DEMO_YAML_CHOICES: Choice<DemoYaml>[] = [
  {
    value: "shipped",
    label: "Use the ready-made demo YAML (recommended)",
    hint: "Same planted “why did revenue fall?” story. Authoring stays off. No pin.",
  },
  {
    value: "authoring",
    label: "Build my own YAML against this demo (advanced)",
    hint: "Turns on authoring tools so you can draft metrics, then open a proposal PR. Does not pin production.",
  },
];

/**
 * Plain-English start choices (tone = plain). Technical wording lives in wizardCopy().
 * Same values and defaults in both tones.
 */
export const PATH_CHOICES: Choice<StartChoice>[] = wizardCopy("plain").pathChoices;

export { TONE_QUESTION, TONE_CHOICES };

export function pathReviewLine(path: SetupPath): string {
  if (path === "demo") return "demo shop (DuckDB)";
  if (path === "import") return "existing YAML";
  return "own data";
}

export function demoReviewLine(demoEngine?: DemoEngine, demoYaml?: DemoYaml): string {
  if (demoEngine === "postgres" && demoYaml === "authoring") {
    return "demo Postgres (author YAML)";
  }
  if (demoEngine === "postgres") return "demo Postgres (shipped YAML)";
  return pathReviewLine("demo");
}

type Step = "tone" | "start" | "demo_yaml" | "engine" | "fields" | "client" | "confirm";

/**
 * Interactive tone → start → (engine + fields | demo YAML) → confirm.
 * Tone changes wording only. Defaults, enforcement, and writes are identical.
 * MCP is skipped unless `--connect` is set.
 * `--yes` / `--import` never call this (no tone question on flag paths).
 */
export async function promptSetupAnswers(opts: WizardOptions): Promise<WizardAnswers> {
  let path: SetupPath | undefined;
  let engine: WarehouseType | undefined;
  let connection: ConnectionDraft | undefined;
  let client: string | null | undefined;
  let demoEngine: DemoEngine | undefined;
  let demoYaml: DemoYaml | undefined;
  let fieldIndex = 0;
  let tone: SetupTone = opts.homeDir ? (readSetupTone(opts.homeDir) ?? "technical") : "technical";
  let copy: WizardCopy = wizardCopy(tone);

  applyForcedFlags(opts, (next) => {
    path = next.path;
    demoEngine = next.demoEngine;
    demoYaml = next.demoYaml;
  });

  let step: Step = "tone";

  while (true) {
    switch (step) {
      case "tone": {
        if (opts.homeDir) assertLocalGraneConfigWritable(opts.homeDir);
        const saved = opts.homeDir ? readSetupTone(opts.homeDir) : null;
        const chosen = await opts.prompt.select<SetupTone>(
          TONE_QUESTION,
          TONE_CHOICES,
          { defaultValue: saved ?? "technical", allowBack: false },
        );
        if (chosen === BACK) {
          throw new Error("This is the first step. Choose a number, or Ctrl-C to exit.");
        }
        tone = chosen;
        copy = wizardCopy(tone);
        step = stepAfterTone(opts);
        break;
      }
      case "start": {
        const chosen = await opts.prompt.select<StartChoice>(
          copy.pathQuestion,
          copy.pathChoices,
          { defaultValue: "demo", allowBack: true },
        );
        if (chosen === BACK) {
          step = "tone";
          break;
        }
        engine = undefined;
        connection = undefined;
        client = undefined;
        fieldIndex = 0;
        if (chosen === "import") {
          path = "import";
          demoEngine = undefined;
          demoYaml = undefined;
          step = "confirm";
        } else if (chosen === "own") {
          path = "own";
          demoEngine = undefined;
          demoYaml = undefined;
          step = "engine";
        } else if (chosen === "demo_postgres") {
          path = "demo";
          demoEngine = "postgres";
          demoYaml = undefined;
          step = "demo_yaml";
        } else {
          path = "demo";
          demoEngine = "duckdb";
          demoYaml = undefined;
          step = "client";
        }
        break;
      }
      case "demo_yaml": {
        const chosen = await opts.prompt.select<DemoYaml>(
          copy.demoYamlQuestion,
          copy.demoYamlChoices,
          { defaultValue: "shipped", allowBack: true },
        );
        if (chosen === BACK) {
          step = opts.postgres ? "tone" : "start";
          break;
        }
        demoYaml = chosen;
        step = "client";
        break;
      }
      case "engine": {
        const chosen = await opts.prompt.select<WarehouseType>(
          copy.engineQuestion,
          WAREHOUSE_TYPES.map((type) => {
            const entry = WAREHOUSE_CERTIFICATION[type];
            return {
              value: type,
              label: `${entry.label} (${type})`,
              hint: engineHint(type, tone),
            };
          }),
          { defaultValue: "postgres", allowBack: true },
        );
        if (chosen === BACK) {
          step = opts.forcedPath === "own" ? "tone" : "start";
          break;
        }
        engine = chosen;
        connection = { type: chosen };
        fieldIndex = 0;
        step = "fields";
        break;
      }
      case "fields": {
        if (!engine) {
          step = "engine";
          break;
        }
        const fields = connectionFields(engine);
        if (fieldIndex >= fields.length) {
          step = "client";
          break;
        }
        if (fieldIndex < 0) {
          step = "engine";
          fieldIndex = 0;
          break;
        }
        const field = fields[fieldIndex]!;
        const fromEnv = defaultFromEnv(field.key, opts.env);
        const result = await opts.prompt.input(copy.fieldLabel(field), {
          defaultValue: fromEnv ?? field.defaultValue,
          allowEmpty: !field.required,
          allowBack: true,
        });
        if (result === BACK) {
          fieldIndex -= 1;
          break;
        }
        const value = result.trim();
        connection = { ...(connection ?? { type: engine }), type: engine };
        if (!value) {
          if (fromEnv) connection[field.key] = fromEnv;
          else if (field.defaultValue) connection[field.key] = field.defaultValue;
          else if (field.required) {
            throw new Error(`${copy.fieldLabel(field)} is required (or type back).`);
          } else {
            delete connection[field.key];
          }
        } else if (field.key === "url") {
          const parsed = parseOwnDatabaseUrl(value, engine);
          connection.url = parsed.url;
          connection.type = parsed.type;
          engine = parsed.type;
        } else {
          connection[field.key] = value;
        }
        fieldIndex += 1;
        break;
      }
      case "client": {
        if (opts.connect && !opts.skipConnect) {
          client = opts.resolveClientId(opts.connect);
        } else {
          client = null;
        }
        step = "confirm";
        break;
      }
      case "confirm": {
        opts.io.log("");
        opts.io.log(copy.reviewHeading);
        opts.io.log(
          `  Path    ${path === "demo" ? demoReviewLine(demoEngine, demoYaml) : pathReviewLine(path ?? "own")}`,
        );
        if (path === "own" && engine && connection) {
          const cert = WAREHOUSE_CERTIFICATION[engine];
          opts.io.log(`  Engine  ${cert.label} (${engine}) — ${engineHint(engine, tone)}`);
          opts.io.log(`  Connect ${describeConnection(connection)}`);
        }
        if (path !== "import") {
          opts.io.log(`  MCP     ${client ?? "skip"}`);
        }
        const ok = await opts.prompt.confirm(copy.confirmQuestion, {
          defaultYes: true,
          allowBack: true,
        });
        if (ok === BACK) {
          if (path === "import") {
            step = "start";
          } else if (path === "own") {
            step = "fields";
            if (engine) fieldIndex = Math.max(0, connectionFields(engine).length - 1);
          } else if (path === "demo" && demoEngine === "postgres") {
            step = "demo_yaml";
          } else {
            step = opts.forcedPath === "demo" ? "tone" : "start";
          }
          break;
        }
        if (ok === false) {
          throw new Error("Setup cancelled.");
        }
        if (!path) throw new Error("Setup path is missing.");
        if (path === "own" && (!engine || !connection)) {
          throw new Error("Warehouse connection is incomplete. Go back and fill the fields.");
        }
        if (opts.homeDir) writeSetupTone(opts.homeDir, tone);
        return {
          path,
          engine,
          connection,
          client: client ?? null,
          demoEngine: path === "demo" ? (demoEngine ?? "duckdb") : undefined,
          demoYaml:
            path === "demo" && demoEngine === "postgres" ? (demoYaml ?? "shipped") : undefined,
          tone,
        };
      }
    }
  }
}

function stepAfterTone(opts: WizardOptions): Step {
  if (opts.forcedPath === "own") return "engine";
  if (opts.postgres) return opts.authoring ? "client" : "demo_yaml";
  if (opts.forcedPath === "demo") return "client";
  return "start";
}

function applyForcedFlags(
  opts: WizardOptions,
  assign: (next: {
    path?: SetupPath;
    demoEngine?: DemoEngine;
    demoYaml?: DemoYaml;
  }) => void,
): void {
  if (opts.forcedPath === "own") {
    assign({ path: "own" });
    return;
  }
  if (opts.postgres) {
    assign({
      path: "demo",
      demoEngine: "postgres",
      demoYaml: opts.authoring ? "authoring" : undefined,
    });
    return;
  }
  if (opts.forcedPath === "demo") {
    assign({ path: "demo", demoEngine: "duckdb" });
  }
}

function defaultFromEnv(key: string, env: NodeJS.ProcessEnv): string | undefined {
  const map: Record<string, string[]> = {
    url: ["DATABASE_URL", "MYSQL_URL", "CLICKHOUSE_URL", "GRANE_DEMO_DATABASE_URL"],
    path: ["DUCKDB_PATH"],
    token: ["MOTHERDUCK_TOKEN", "DATABRICKS_TOKEN"],
    user: ["SNOWFLAKE_USER"],
    password: ["SNOWFLAKE_PASSWORD"],
    host: ["DATABRICKS_SERVER_HOSTNAME"],
    http_path: ["DATABRICKS_HTTP_PATH"],
    credentials: ["GOOGLE_APPLICATION_CREDENTIALS"],
  };
  for (const name of map[key] ?? []) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}
