import { WAREHOUSE_TYPES, type WarehouseType } from "../connectors/dialect.js";
import { WAREHOUSE_CERTIFICATION } from "../connectors/certification.js";
import {
  connectionFields,
  describeConnection,
  engineHint,
  parseOwnDatabaseUrl,
  type ConnectionDraft,
} from "./connection.js";
import type { SetupIo, SetupPath } from "./types.js";
import { BACK, type Prompter } from "./prompts.js";

export interface WizardAnswers {
  path: SetupPath;
  engine?: WarehouseType;
  connection?: ConnectionDraft;
  client: string | null;
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

/**
 * Interactive path → (engine + fields) → MCP client → confirm.
 * Every step after the first accepts `b` / `back`.
 */
export async function promptSetupAnswers(opts: WizardOptions): Promise<WizardAnswers> {
  let path: SetupPath | undefined;
  let engine: WarehouseType | undefined;
  let connection: ConnectionDraft | undefined;
  let client: string | null | undefined;
  let fieldIndex = 0;

  type Step = "path" | "engine" | "fields" | "client" | "confirm";
  let step: Step = "path";

  while (true) {
    switch (step) {
      case "path": {
        const chosen = await opts.prompt.select<SetupPath>(
          "How do you want to start?",
          [
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
          ],
          { defaultValue: "demo", allowBack: false },
        );
        if (chosen === BACK) {
          throw new Error("This is the first step. Choose a number, or Ctrl-C to exit.");
        }
        path = chosen;
        step = path === "own" ? "engine" : "client";
        engine = undefined;
        connection = undefined;
        fieldIndex = 0;
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
          step = path === "own" ? "fields" : "path";
          if (step === "fields" && engine) {
            fieldIndex = Math.max(0, connectionFields(engine).length - 1);
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
        opts.io.log(`  Path    ${path === "demo" ? "demo shop (DuckDB)" : "own data"}`);
        if (path === "own" && engine && connection) {
          const cert = WAREHOUSE_CERTIFICATION[engine];
          opts.io.log(`  Engine  ${cert.label} (${engine}) — ${engineHint(engine)}`);
          opts.io.log(`  Connect ${describeConnection(connection)}`);
        }
        opts.io.log(`  MCP     ${client ?? "skip"}`);
        const ok = await opts.prompt.confirm("Proceed?", { defaultYes: true, allowBack: true });
        if (ok === BACK) {
          step = "client";
          break;
        }
        if (ok === false) {
          throw new Error("Setup cancelled.");
        }
        if (!path) throw new Error("Setup path is missing.");
        if (path === "own" && (!engine || !connection)) {
          throw new Error("Warehouse connection is incomplete. Go back and fill the fields.");
        }
        return { path, engine, connection, client: client ?? null };
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

