import { WAREHOUSE_TYPES, type WarehouseType } from "../connectors/dialect.js";
import { WAREHOUSE_CERTIFICATION } from "../connectors/certification.js";
import {
  connectionFields,
  describeConnection,
  engineHint,
  parseOwnDatabaseUrl,
  type ConnectionDraft,
} from "./connection.js";
import type { DemoEngine, DemoYaml, SetupIo, SetupPath } from "./types.js";
import { BACK, type Choice, type Prompter } from "./prompts.js";

export interface WizardAnswers {
  path: SetupPath;
  engine?: WarehouseType;
  connection?: ConnectionDraft;
  client: string | null;
  demoEngine?: DemoEngine;
  demoYaml?: DemoYaml;
}

export interface WizardOptions {
  io: SetupIo;
  prompt: Prompter;
  env: NodeJS.ProcessEnv;
  skipConnect?: boolean;
  connect?: string;
  resolveClientId: (name: string) => string;
  listClients: () => Array<{ id: string; label: string }>;
}

export const EXISTING_YAML_QUESTION = "Do you already have a Grane YAML?";

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
    label: "Use the shipped demo YAML",
    hint: "Same planted revenue-drop story as today's demo. No authoring.",
  },
  {
    value: "authoring",
    label: "Build my own YAML against demo Postgres",
    hint: "Discovery, authoring tools, Set up Grane prompt, YAML generator, then a proposal PR. No production writes or pin.",
  },
];

/** Demo/own copy frozen by tests/fixtures/setup-wizard-main.ts (captured from main). */
export const PATH_CHOICES: Choice<"demo" | "own">[] = [
  {
    value: "demo",
    label: "Try Grane's demo shop",
    hint: "Local DuckDB. No database, no Docker. The planted revenue-drop story.",
  },
  {
    value: "own",
    label: "Connect my own data",
    hint: "Any warehouse Grane already supports. We write grane.yml, validate, then connect an agent.",
  },
];

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

/**
 * Interactive existing-YAML? → path → (engine + fields) → MCP client → confirm.
 * Every step after the first accepts `b` / `back`.
 * Answering yes on the first step skips path/engine/fields/client (V2-05).
 */
export async function promptSetupAnswers(opts: WizardOptions): Promise<WizardAnswers> {
  let path: SetupPath | undefined;
  let engine: WarehouseType | undefined;
  let connection: ConnectionDraft | undefined;
  let client: string | null | undefined;
  let demoEngine: DemoEngine | undefined;
  let demoYaml: DemoYaml | undefined;
  let fieldIndex = 0;

  type Step = "existing" | "path" | "demo_engine" | "demo_yaml" | "engine" | "fields" | "client" | "confirm";
  let step: Step = "existing";

  while (true) {
    switch (step) {
      case "existing": {
        const chosen = await opts.prompt.select<"yes" | "no">(
          EXISTING_YAML_QUESTION,
          EXISTING_YAML_CHOICES,
          { defaultValue: "no", allowBack: false },
        );
        if (chosen === BACK) {
          throw new Error("This is the first step. Choose a number, or Ctrl-C to exit.");
        }
        engine = undefined;
        connection = undefined;
        client = undefined;
        demoEngine = undefined;
        demoYaml = undefined;
        fieldIndex = 0;
        if (chosen === "yes") {
          path = "import";
          step = "confirm";
        } else {
          path = undefined;
          step = "path";
        }
        break;
      }
      case "path": {
        const chosen = await opts.prompt.select<"demo" | "own">(
          PATH_QUESTION,
          PATH_CHOICES,
          { defaultValue: "demo", allowBack: true },
        );
        if (chosen === BACK) {
          step = "existing";
          break;
        }
        path = chosen;
        engine = undefined;
        connection = undefined;
        demoEngine = undefined;
        demoYaml = undefined;
        fieldIndex = 0;
        step = path === "own" ? "engine" : "demo_engine";
        break;
      }
      case "demo_engine": {
        const chosen = await opts.prompt.select<DemoEngine>(
          DEMO_ENGINE_QUESTION,
          DEMO_ENGINE_CHOICES,
          { defaultValue: "duckdb", allowBack: true },
        );
        if (chosen === BACK) {
          step = "path";
          break;
        }
        demoEngine = chosen;
        demoYaml = undefined;
        step = chosen === "postgres" ? "demo_yaml" : "client";
        break;
      }
      case "demo_yaml": {
        const chosen = await opts.prompt.select<DemoYaml>(
          DEMO_YAML_QUESTION,
          DEMO_YAML_CHOICES,
          { defaultValue: "shipped", allowBack: true },
        );
        if (chosen === BACK) {
          step = "demo_engine";
          break;
        }
        demoYaml = chosen;
        step = "client";
        break;
      }
      case "engine": {
        const chosen = await opts.prompt.select<WarehouseType>(
          "Which warehouse?",
          WAREHOUSE_TYPES.map((type) => {
            const entry = WAREHOUSE_CERTIFICATION[type];
            return {
              value: type,
              label: `${entry.label} (${type})`,
              hint: engineHint(type),
            };
          }),
          { defaultValue: "postgres", allowBack: true },
        );
        if (chosen === BACK) {
          step = "path";
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
        const result = await opts.prompt.input(field.label, {
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
          if (field.required && !fromEnv) {
            throw new Error(`${field.label} is required (or type back).`);
          }
          if (field.defaultValue && !fromEnv) connection[field.key] = field.defaultValue;
          else if (fromEnv) connection[field.key] = fromEnv;
          else delete connection[field.key];
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
        if (opts.skipConnect) {
          client = null;
          step = "confirm";
          break;
        }
        if (opts.connect) {
          client = opts.resolveClientId(opts.connect);
          step = "confirm";
          break;
        }
        const writable = opts.listClients().filter((c) => c.id !== "generic");
        const chosen = await opts.prompt.select<string>(
          "Which agent should Grane register with?",
          [
            ...writable.map((c) => ({
              value: c.id,
              label: c.label,
              hint: c.id === "chatgpt" ? "No config file — prints HTTPS connector steps." : undefined,
            })),
            { value: "skip", label: "Skip for now", hint: "You can run grane mcp connect later." },
          ],
          { defaultValue: "cursor", allowBack: true },
        );
        if (chosen === BACK) {
          if (path === "own") {
            step = "fields";
            if (engine) fieldIndex = Math.max(0, connectionFields(engine).length - 1);
          } else if (path === "demo" && demoEngine === "postgres") {
            step = "demo_yaml";
          } else if (path === "demo") {
            step = "demo_engine";
          } else {
            step = "path";
          }
          break;
        }
        client = chosen === "skip" ? null : opts.resolveClientId(chosen);
        step = "confirm";
        break;
      }
      case "confirm": {
        opts.io.log("");
        opts.io.log("Review");
        opts.io.log(
          `  Path    ${path === "demo" ? demoReviewLine(demoEngine, demoYaml) : pathReviewLine(path ?? "own")}`,
        );
        if (path === "own" && engine && connection) {
          const cert = WAREHOUSE_CERTIFICATION[engine];
          opts.io.log(`  Engine  ${cert.label} (${engine}) — ${engineHint(engine)}`);
          opts.io.log(`  Connect ${describeConnection(connection)}`);
        }
        if (path !== "import") {
          opts.io.log(`  MCP     ${client ?? "skip"}`);
        }
        const ok = await opts.prompt.confirm("Proceed?", { defaultYes: true, allowBack: true });
        if (ok === BACK) {
          step = path === "import" ? "existing" : "client";
          break;
        }
        if (ok === false) {
          throw new Error("Setup cancelled.");
        }
        if (!path) throw new Error("Setup path is missing.");
        if (path === "own" && (!engine || !connection)) {
          throw new Error("Warehouse connection is incomplete. Go back and fill the fields.");
        }
        return {
          path,
          engine,
          connection,
          client: client ?? null,
          demoEngine: path === "demo" ? (demoEngine ?? "duckdb") : undefined,
          demoYaml:
            path === "demo" && demoEngine === "postgres" ? (demoYaml ?? "shipped") : undefined,
        };
      }
    }
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
