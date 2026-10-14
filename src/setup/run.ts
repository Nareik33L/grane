import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { writeInitProject } from "../cli/init-project.js";
import {
  ACTIVE_PIN_PATH,
  assertCleanWorktree,
  assertProjectYamlMatchesCommit,
  readActivePin,
  resolveActiveRef,
  writeActivePin,
} from "../authoring/git.js";
import { createDiscovery } from "../authoring/discover.js";
import { findProjectDir, loadConfig } from "../config/load.js";
import type { WarehouseType } from "../connectors/dialect.js";
import { WAREHOUSE_TYPES } from "../connectors/dialect.js";
import { DEMO_QUESTION, runDemo, type DemoIo, type DemoResult } from "../demo/run.js";
import { GraneKernel, type Catalog } from "../kernel.js";
import { formatValidateReport } from "../validate/format.js";
import {
  connectMcp,
  findWorkspaceDir,
  formatConnectOutput,
  listClients,
  resolveClient,
  resolveGraneLaunch,
  type ConnectResult,
} from "../mcp/connect/index.js";
import {
  describeConnection,
  isGraneSourceTree,
  parseOwnDatabaseUrl,
  persistOwnConnection,
  type ConnectionDraft,
} from "./connection.js";
import {
  OWN_QUESTION,
  SETUP_BANNER,
  demoAuthoringReadyLines,
  demoReadyLines,
  importInspectOnlyLines,
  importReadyLines,
  ownReadyLines,
  skipConnectHint,
} from "./copy.js";
import {
  DEMO_AUTHORING_QUESTION,
  assertNotExistingGitRepo,
  ensureDemoAuthoringGitRepo,
  writeDemoAuthoringProject,
} from "./demo-postgres.js";
import { createReadlinePrompter, type Prompter } from "./prompts.js";
import type { DemoEngine, DemoYaml, SetupIo, SetupPath } from "./types.js";
import { promptSetupAnswers } from "./wizard.js";

export type { SetupIo, SetupPath };

export interface RunSetupOptions {
  path?: SetupPath;
  yes?: boolean;
  dir?: string;
  url?: string;
  engine?: WarehouseType;
  connectionPath?: string;
  connection?: Partial<ConnectionDraft>;
  provider?: string;
  connect?: string;
  skipConnect?: boolean;
  offline?: boolean;
  /** Non-interactive `grane setup --import <dir>`: validate/inspect, never pin. */
  importDir?: string;
  /** Import path only: allow pinning after `--offline` (no live schema checks). */
  activateOffline?: boolean;
  /** Demo path: use demo Postgres instead of DuckDB. */
  postgres?: boolean;
  /** Demo Postgres: author YAML (b) instead of shipped demo YAML (a). */
  authoring?: boolean;
  json?: boolean;
  cwd?: string;
  homeDir?: string;
  workspaceDir?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  io?: SetupIo;
  prompt?: Prompter;
  stdinIsTty?: boolean;
  stdoutIsTty?: boolean;
  runDemoFn?: (options: Parameters<typeof runDemo>[0]) => Promise<DemoResult>;
  runDemoAuthoringFn?: (opts: {
    projectDir: string;
    url: string;
  }) => Promise<void> | void;
  connectMcpFn?: typeof connectMcp;
}

export interface SetupResult {
  path: SetupPath;
  projectDir: string;
  warehouse: WarehouseType | null;
  client: string | null;
  question: string;
  validated: boolean;
  live: boolean;
  connect: ConnectResult | null;
  demoEngine?: DemoEngine;
  demoYaml?: DemoYaml;
}

/** Human label for `SetupResult.warehouse`. Null (import before an engine is known) is "none". */
export function formatSetupWarehouse(warehouse: WarehouseType | null): string {
  if (warehouse === null) return "none";
  return warehouse;
}

/** JSON payload for `grane setup --json`. Null warehouse/client stay JSON `null`, never omitted. */
export function serializeSetupResult(result: SetupResult): {
  path: SetupPath;
  projectDir: string;
  warehouse: WarehouseType | null;
  client: string | null;
  question: string;
  validated: boolean;
  live: boolean;
  mcpPath: string | null;
} {
  const warehouse: WarehouseType | null = result.warehouse === null ? null : result.warehouse;
  const client: string | null = result.client === null ? null : result.client;
  const mcpPath: string | null = result.connect === null || result.connect === undefined ? null : result.connect.path;
  return {
    path: result.path,
    projectDir: result.projectDir,
    warehouse,
    client,
    question: result.question,
    validated: result.validated,
    live: result.live,
    mcpPath,
  };
}

const defaultIo: SetupIo = {
  log: (line) => console.log(line),
  error: (line) => console.error(line),
};

export async function runSetup(options: RunSetupOptions = {}): Promise<SetupResult> {
  const io = options.io ?? defaultIo;
  const cwd = resolve(options.cwd ?? process.cwd());
  const env = options.env ?? process.env;
  const tty = options.stdinIsTty ?? Boolean(process.stdin.isTTY);
  const stdoutTty = options.stdoutIsTty ?? Boolean(process.stdout.isTTY);
  const yes = Boolean(options.yes);
  const skipConnect = Boolean(options.skipConnect);

  if (options.importDir) {
    if (!options.json) {
      io.log(SETUP_BANNER);
    } else {
      io.error(SETUP_BANNER);
    }
    return runImportPath({
      ...options,
      io,
      cwd,
      dir: options.importDir,
      json: options.json,
      skipConnect: true,
      client: null,
      inspectOnly: true,
      stdinTty: false,
      stdoutTty: false,
      offline: options.offline,
    });
  }

  if (!yes && !tty && !options.prompt) {
    throw new Error(
      'Not a terminal. Re-run with prompts, or use the escape hatch: grane setup --yes --path demo|own [--url …] [--engine …] [--connect cursor|--skip-connect]',
    );
  }
  if (yes && !options.path) {
    throw new Error("Non-interactive setup requires --path demo or --path own, or --import <dir>.");
  }
  if (options.authoring && !options.postgres && options.path === "demo") {
    throw new Error("Demo authoring requires demo Postgres. Pass --postgres with --authoring.");
  }

  const prompt = options.prompt ?? createReadlinePrompter(io);
  if (!options.json) {
    io.log(SETUP_BANNER);
  } else {
    io.error(SETUP_BANNER);
  }

  if (!yes) {
    const answers = await promptSetupAnswers({
      io,
      prompt,
      env,
      skipConnect,
      connect: options.connect,
      resolveClientId: (name) => resolveClient(name).id,
      listClients: () => listClients().map((c) => ({ id: c.id, label: c.label })),
    });
    if (answers.path === "demo") {
      return runDemoPath({
        ...options,
        io,
        cwd,
        env,
        client: answers.client,
        skipConnect,
        postgres: answers.demoEngine === "postgres",
        authoring: answers.demoYaml === "authoring",
      });
    }
    if (answers.path === "import") {
      return runImportPath({
        ...options,
        io,
        cwd,
        json: options.json,
        skipConnect,
        client: answers.client,
        prompt,
        stdinTty: tty,
        stdoutTty,
        offline: options.offline,
        activateOffline: options.activateOffline,
      });
    }
    return runOwnPath({
      ...options,
      io,
      cwd,
      env,
      prompt,
      yes: false,
      client: answers.client,
      skipConnect,
      draft: answers.connection,
      persist: true,
    });
  }

  const path = options.path;
  if (path !== "demo" && path !== "own") {
    throw new Error(`Unknown --path "${String(path)}". Use demo or own.`);
  }

  const client = skipConnect
    ? null
    : options.connect
      ? resolveClient(options.connect).id
      : null;

  if (path === "demo") {
    return runDemoPath({
      ...options,
      io,
      cwd,
      env,
      client,
      skipConnect,
      postgres: Boolean(options.postgres),
      authoring: Boolean(options.authoring),
    });
  }
  const resolved = resolveYesConnection(options, env);
  return runOwnPath({
    ...options,
    io,
    cwd,
    env,
    prompt,
    yes: true,
    client,
    skipConnect,
    draft: resolved.draft,
    persist: resolved.persist,
  });
}

function resolveYesConnection(
  options: RunSetupOptions,
  env: NodeJS.ProcessEnv,
): { draft: ConnectionDraft; persist: boolean } {
  if (options.engine && !WAREHOUSE_TYPES.includes(options.engine)) {
    throw new Error(`Unknown --engine "${options.engine}". Supported: ${WAREHOUSE_TYPES.join(", ")}.`);
  }
  if (options.url) {
    const parsed = parseOwnDatabaseUrl(options.url, options.engine);
    return { draft: { type: parsed.type, url: parsed.url, ...pickSchema(options) }, persist: true };
  }
  if (options.engine === "duckdb" && (options.connectionPath || options.connection?.path)) {
    return {
      draft: {
        type: "duckdb",
        path: options.connectionPath ?? options.connection?.path,
        schema: options.connection?.schema ?? "main",
        token: options.connection?.token,
      },
      persist: true,
    };
  }
  if (options.engine && options.connection && Object.keys(options.connection).length > 0) {
    return { draft: { ...options.connection, type: options.engine }, persist: true };
  }
  const fromEnv = env.DATABASE_URL?.trim();
  if (fromEnv) {
    const parsed = parseOwnDatabaseUrl(fromEnv, options.engine);
    return { draft: { type: parsed.type, url: parsed.url }, persist: false };
  }
  throw new Error(
    "Own-database setup needs a connection. Pass --url postgres://… (or mysql:// / clickhouse://), " +
      "--engine duckdb --connection-path …, or set DATABASE_URL.",
  );
}

function pickSchema(options: RunSetupOptions): Partial<ConnectionDraft> {
  if (options.connection?.schema) return { schema: options.connection.schema };
  if (options.connection?.database) return { database: options.connection.database };
  return {};
}

async function runDemoPath(opts: {
  io: SetupIo;
  cwd: string;
  env: NodeJS.ProcessEnv;
  dir?: string;
  json?: boolean;
  client: string | null;
  skipConnect: boolean;
  postgres?: boolean;
  authoring?: boolean;
  homeDir?: string;
  workspaceDir?: string;
  platform?: NodeJS.Platform;
  runDemoFn?: RunSetupOptions["runDemoFn"];
  runDemoAuthoringFn?: RunSetupOptions["runDemoAuthoringFn"];
  connectMcpFn?: RunSetupOptions["connectMcpFn"];
}): Promise<SetupResult> {
  if (opts.authoring && !opts.postgres) {
    throw new Error("Demo authoring requires demo Postgres. Pass --postgres with --authoring.");
  }
  if (opts.postgres && opts.authoring) {
    return runDemoAuthoringPath(opts);
  }
  const demoFn = opts.runDemoFn ?? runDemo;
  opts.io.log("");
  opts.io.log(
    opts.postgres
      ? "Using demo Postgres and running the investigation…"
      : "Building the demo shop and running the investigation…",
  );
  const demo = await demoFn({
    dir: opts.dir,
    cwd: opts.cwd,
    io: opts.io,
    nextSteps: false,
    json: false,
    postgres: Boolean(opts.postgres),
  });

  const connected = connectIfRequested(opts, demo.projectDir);
  printReady(opts.io, opts.json, demoReadyLines({
    projectDir: demo.projectDir,
    clientLabel: connected.label,
  }));

  return {
    path: "demo",
    projectDir: demo.projectDir,
    warehouse: opts.postgres ? "postgres" : "duckdb",
    client: opts.client,
    question: DEMO_QUESTION,
    validated: true,
    live: true,
    connect: connected.result,
    demoEngine: opts.postgres ? "postgres" : "duckdb",
    demoYaml: opts.postgres ? "shipped" : undefined,
  };
}

async function runDemoAuthoringPath(opts: {
  io: SetupIo;
  cwd: string;
  env: NodeJS.ProcessEnv;
  dir?: string;
  json?: boolean;
  client: string | null;
  skipConnect: boolean;
  homeDir?: string;
  workspaceDir?: string;
  platform?: NodeJS.Platform;
  runDemoAuthoringFn?: RunSetupOptions["runDemoAuthoringFn"];
  connectMcpFn?: RunSetupOptions["connectMcpFn"];
}): Promise<SetupResult> {
  const projectDir = resolve(opts.dir ?? defaultOwnProjectDir(opts.cwd));
  if (isGraneSourceTree(projectDir)) {
    throw new Error(
      `Refusing to write a new project into the Grane source tree (${projectDir}). ` +
        `Pass --dir ./my-analytics (or another empty folder).`,
    );
  }
  opts.io.log("");
  opts.io.log("Preparing demo Postgres authoring (discovery → proposal PR). No pin, no production YAML writes.");
  assertNotExistingGitRepo(projectDir);
  const written = writeDemoAuthoringProject(projectDir);
  ensureDemoAuthoringGitRepo(projectDir, opts.io);
  if (opts.runDemoAuthoringFn) {
    await opts.runDemoAuthoringFn({ projectDir, url: written.url });
  }
  if (existsSync(join(projectDir, ACTIVE_PIN_PATH)) || readActivePin(projectDir)) {
    throw new Error(`Demo authoring must not write ${ACTIVE_PIN_PATH}.`);
  }

  const connected = connectIfRequested(opts, projectDir);
  printReady(
    opts.io,
    opts.json,
    demoAuthoringReadyLines({
      projectDir,
      clientLabel: connected.label,
    }),
  );

  return {
    path: "demo",
    projectDir,
    warehouse: "postgres",
    client: opts.client,
    question: DEMO_AUTHORING_QUESTION,
    validated: true,
    live: true,
    connect: connected.result,
    demoEngine: "postgres",
    demoYaml: "authoring",
  };
}

async function runOwnPath(opts: {
  io: SetupIo;
  cwd: string;
  env: NodeJS.ProcessEnv;
  prompt: Prompter;
  yes: boolean;
  dir?: string;
  provider?: string;
  offline?: boolean;
  json?: boolean;
  client: string | null;
  skipConnect: boolean;
  draft?: ConnectionDraft;
  persist: boolean;
  homeDir?: string;
  workspaceDir?: string;
  platform?: NodeJS.Platform;
  connectMcpFn?: RunSetupOptions["connectMcpFn"];
}): Promise<SetupResult> {
  const projectDir = resolve(opts.dir ?? defaultOwnProjectDir(opts.cwd));
  if (isGraneSourceTree(projectDir)) {
    throw new Error(
      `Refusing to write a new project into the Grane source tree (${projectDir}). ` +
        `Pass --dir ./my-analytics (or another empty folder).`,
    );
  }

  const init = writeInitProject(projectDir, { provider: opts.provider });
  for (const name of init.written) opts.io.log(`write ${name}`);
  for (const name of init.skipped) opts.io.log(`skip  ${name} (already exists)`);
  if (init.written.length === 0 && init.skipped.length > 0) {
    opts.io.log(`Using existing project at ${projectDir}`);
  }

  const draft = opts.draft;
  if (draft && opts.persist) {
    persistOwnConnection(projectDir, draft);
    if (draft.url) opts.env.DATABASE_URL = draft.url;
    opts.io.log(`connection  ${describeConnection(draft)}`);
  } else if (draft) {
    if (draft.url) opts.env.DATABASE_URL = draft.url;
    opts.io.log(`connection  ${draft.type}  \${DATABASE_URL}`);
  } else {
    throw new Error("Own-database setup needs a connection.");
  }

  const live = !opts.offline;
  const validated = await validateOwnProject(opts.io, projectDir, live, opts.prompt, opts.yes);

  const connected = connectIfRequested(opts, projectDir);
  printReady(opts.io, opts.json, ownReadyLines({
    projectDir,
    clientLabel: connected.label,
    live: live && validated,
  }));

  return {
    path: "own",
    projectDir,
    warehouse: draft.type,
    client: opts.client,
    question: OWN_QUESTION,
    validated,
    live: live && validated,
    connect: connected.result,
  };
}

function defaultOwnProjectDir(cwd: string): string {
  if (isGraneSourceTree(cwd)) return join(cwd, "my-analytics");
  return cwd;
}

/**
 * Existing YAML: loadConfig → validateModel (same messages as `grane validate`)
 * → kernel catalog → pin HEAD via writeActivePin. Never edits the user's YAML.
 */
async function runImportPath(opts: {
  io: SetupIo;
  cwd: string;
  dir?: string;
  json?: boolean;
  offline?: boolean;
  activateOffline?: boolean;
  inspectOnly?: boolean;
  skipConnect: boolean;
  client: string | null;
  prompt?: Prompter;
  stdinTty?: boolean;
  stdoutTty?: boolean;
  homeDir?: string;
  workspaceDir?: string;
  platform?: NodeJS.Platform;
  connectMcpFn?: RunSetupOptions["connectMcpFn"];
}): Promise<SetupResult> {
  const startDir = resolve(opts.dir ?? opts.cwd);
  const projectDir = findProjectDir(startDir);
  if (!opts.inspectOnly) {
    try {
      const preview = resolveActiveRef(projectDir);
      assertCleanWorktree(projectDir);
      assertProjectYamlMatchesCommit(projectDir, preview.commit);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!message.includes("No git repository")) throw err;
    }
  }
  const loaded = loadConfig(projectDir);
  const kernel = new GraneKernel(loaded.config, {
    projectDir,
    providerWarnings: loaded.warnings,
  });
  const live = !opts.offline;
  try {
    const schema = live
      ? await (async () => {
          const snapshot = await createDiscovery({
            config: loaded.config,
            connector: kernel.getConnector(),
            projectDir,
            sessionId: null,
            agent: "setup-import",
            sampling: false,
          }).introspectSchema();
          kernel.setSchema(snapshot);
          return snapshot;
        })()
      : undefined;
    const report = kernel.validate(schema);
    for (const line of formatValidateReport(report, {
      providers: kernel.serverInfo().semantic_providers,
      providerWarnings: kernel.providerWarnings,
      schemaLive: live,
    })) {
      opts.io.log(line);
    }
    const warehouse: WarehouseType | null = loaded.config.connection.type;
    if (!report.ok) {
      if (opts.inspectOnly) {
        return {
          path: "import",
          projectDir,
          warehouse,
          client: null,
          question: OWN_QUESTION,
          validated: false,
          live: false,
          connect: null,
        };
      }
      throw new Error("Validate failed.");
    }

    const catalog: Catalog = live
      ? await kernel.catalog()
      : {
          ...kernel.governedCatalog(),
          exploration: {
            enabled: false,
            mode: kernel.config.exploration.mode,
            schemas: [],
            included: kernel.config.exploration.include,
            excluded: kernel.config.exploration.exclude,
            columns: [],
          },
        };
    opts.io.log("");
    opts.io.log("Catalog");
    opts.io.log(`  Metrics     ${catalog.metrics.length}`);
    opts.io.log(`  Dimensions  ${catalog.dimensions.length}`);
    opts.io.log(`  Entities    ${catalog.entities.length}`);
    if (catalog.exploration.enabled) {
      opts.io.log(`  Explorable  ${catalog.exploration.columns.length} columns`);
    }
    for (const metric of catalog.metrics) {
      opts.io.log(`  - ${metric.name} (${metric.status})`);
    }

    if (opts.inspectOnly) {
      printReady(
        opts.io,
        opts.json,
        importInspectOnlyLines({
          projectDir,
          warehouseLabel: formatSetupWarehouse(warehouse),
        }),
      );
      return {
        path: "import",
        projectDir,
        warehouse,
        client: null,
        question: OWN_QUESTION,
        validated: true,
        live,
        connect: null,
      };
    }

    assertCleanWorktree(projectDir);
    const active = resolveActiveRef(projectDir);
    assertProjectYamlMatchesCommit(projectDir, active.commit);
    if (opts.offline && !opts.activateOffline) {
      throw new Error(
        `Refusing to activate: --offline skipped live schema checks. Re-run without --offline, or pass --activate-offline to pin ${active.branch}@${active.commit} anyway.`,
      );
    }
    if (!opts.stdinTty || !opts.stdoutTty) {
      throw new Error(
        `Activation requires a TTY. Refusing to write ${ACTIVE_PIN_PATH} for ${active.branch}@${active.commit}.`,
      );
    }
    if (!opts.prompt) {
      throw new Error(`Activation requires a TTY. Refusing to write ${ACTIVE_PIN_PATH} for ${active.branch}@${active.commit}.`);
    }
    const activate = await opts.prompt.confirm(`Activate pin ${active.branch}@${active.commit}?`, {
      defaultYes: false,
      allowBack: false,
    });
    if (activate !== true) {
      throw new Error("Activation declined. Pin was not written.");
    }
    const existing = readActivePin(projectDir);
    const previous =
      existing && existing.commit !== active.commit ? existing.commit : (existing?.previous_commit ?? null);
    const pin = writeActivePin(projectDir, {
      ref: active.branch,
      commit: active.commit,
      approved_by: "setup-import",
      approved_at: new Date().toISOString(),
      previous_commit: previous,
    });
    opts.io.log(`activate    ${ACTIVE_PIN_PATH}  ${pin.ref} @ ${pin.commit.slice(0, 7)}`);

    const connected = connectIfRequested(opts, projectDir);
    printReady(
      opts.io,
      opts.json,
      importReadyLines({
        projectDir,
        pinRef: pin.ref,
        pinCommit: pin.commit,
        warehouseLabel: formatSetupWarehouse(warehouse),
      }),
    );

    return {
      path: "import",
      projectDir,
      warehouse,
      client: opts.client,
      question: OWN_QUESTION,
      validated: true,
      live,
      connect: connected.result,
    };
  } finally {
    await kernel.close();
  }
}

async function validateOwnProject(
  io: SetupIo,
  projectDir: string,
  live: boolean,
  prompt: Prompter,
  yes: boolean,
): Promise<boolean> {
  const loaded = loadConfig(projectDir);
  const kernel = new GraneKernel(loaded.config, {
    projectDir: loaded.projectDir,
    providerWarnings: loaded.warnings,
  });
  try {
    const schema = live ? await kernel.introspectSchema() : undefined;
    const report = kernel.validate(schema);
    const valid = report.metrics.filter((m) => m.ok).length;
    io.log(
      `validate    ${valid}/${report.metrics.length} metrics` +
        (live && schema
          ? `  |  ${schema.tables.length} tables, ${schema.tables.reduce((n, t) => n + t.columns.length, 0)} columns`
          : "  |  offline"),
    );
    if (!report.ok) {
      for (const issue of report.issues.filter((i) => i.severity === "error")) {
        io.error(`ERROR ${issue.subject}: ${issue.message}`);
      }
      throw new Error("Validate failed. Fix the errors above and re-run grane setup.");
    }
    return true;
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("Validate failed")) throw err;
    const message = err instanceof Error ? err.message : String(err);
    io.error(`Could not reach the database: ${message}`);
    if (yes) {
      throw new Error(
        "Live connection failed. Fix the URL or re-run with --offline to write config only.",
      );
    }
    const keepGoing = await prompt.confirm("Config is written. Continue to MCP connect anyway?", {
      defaultYes: true,
      allowBack: false,
    });
    if (keepGoing === false) {
      throw new Error("Setup stopped. Fix the connection and re-run grane setup.");
    }
    return false;
  } finally {
    await kernel.close();
  }
}

function connectIfRequested(
  opts: {
    io: SetupIo;
    client: string | null;
    skipConnect: boolean;
    cwd?: string;
    homeDir?: string;
    workspaceDir?: string;
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
    connectMcpFn?: RunSetupOptions["connectMcpFn"];
  },
  projectDir: string,
): { result: ConnectResult | null; label: string | null } {
  if (opts.skipConnect || !opts.client) {
    opts.io.log("");
    for (const line of skipConnectHint(projectDir)) opts.io.log(line);
    return { result: null, label: null };
  }
  const connectFn = opts.connectMcpFn ?? connectMcp;
  const result = connectFn({
    client: resolveClient(opts.client).id,
    projectDir,
    workspaceDir: opts.workspaceDir ?? findWorkspaceDir(opts.cwd ?? process.cwd(), projectDir),
    homeDir: opts.homeDir ?? homedir(),
    platform: opts.platform ?? process.platform,
    launch: resolveGraneLaunch(),
    includeEnv: true,
    env: opts.env ?? process.env,
    serverName: "grane",
    port: 8080,
    scope: "project",
    dryRun: false,
  });
  opts.io.log("");
  opts.io.log(formatConnectOutput(result));
  return { result, label: result.label };
}

function printReady(io: SetupIo, json: boolean | undefined, lines: string[]): void {
  const text = ["", ...lines].join("\n");
  if (json) io.error(text);
  else io.log(text);
}

export { DEMO_QUESTION, OWN_QUESTION };
export type { DemoIo };
