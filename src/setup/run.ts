import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { writeInitProject } from "../cli/init-project.js";
import { loadConfig } from "../config/load.js";
import { DEMO_QUESTION, runDemo, type DemoIo, type DemoResult } from "../demo/run.js";
import { GraneKernel } from "../kernel.js";
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
  isGraneSourceTree,
  maskDatabaseUrl,
  parseOwnDatabaseUrl,
  persistOwnConnection,
  type SetupWarehouse,
} from "./connection.js";
import { OWN_QUESTION, SETUP_BANNER, demoReadyLines, ownReadyLines, skipConnectHint } from "./copy.js";
import { createReadlinePrompter, type Prompter } from "./prompts.js";

export type SetupPath = "demo" | "own";

export interface SetupIo extends DemoIo {}

export interface RunSetupOptions {
  path?: SetupPath;
  yes?: boolean;
  dir?: string;
  url?: string;
  provider?: string;
  connect?: string;
  skipConnect?: boolean;
  offline?: boolean;
  json?: boolean;
  cwd?: string;
  homeDir?: string;
  workspaceDir?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  io?: SetupIo;
  prompt?: Prompter;
  stdinIsTty?: boolean;
  runDemoFn?: (options: Parameters<typeof runDemo>[0]) => Promise<DemoResult>;
  connectMcpFn?: typeof connectMcp;
}

export interface SetupResult {
  path: SetupPath;
  projectDir: string;
  warehouse: "duckdb" | SetupWarehouse;
  client: string | null;
  question: string;
  validated: boolean;
  live: boolean;
  connect: ConnectResult | null;
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
  const yes = Boolean(options.yes);
  const skipConnect = Boolean(options.skipConnect);

  if (!yes && !tty && !options.prompt) {
    throw new Error(
      'Not a terminal. Re-run with prompts, or use the escape hatch: grane setup --yes --path demo|own [--url …] [--connect cursor|--skip-connect]',
    );
  }
  if (yes && !options.path) {
    throw new Error('Non-interactive setup requires --path demo or --path own.');
  }

  const prompt = options.prompt ?? createReadlinePrompter(io);
  if (!options.json) {
    io.log(SETUP_BANNER);
  } else {
    io.error(SETUP_BANNER);
  }

  const path = options.path ?? (await prompt.select<SetupPath>(
    "How do you want to start?",
    [
      {
        value: "demo",
        label: "Try Grane's demo shop",
        hint: "Local DuckDB. No database, no Docker. The planted revenue-drop story.",
      },
      {
        value: "own",
        label: "Connect my own Postgres",
        hint: "Read-only URL. We write grane.yml, validate, then connect an agent.",
      },
    ],
    { defaultValue: "demo" },
  ));

  if (path !== "demo" && path !== "own") {
    throw new Error(`Unknown --path "${String(path)}". Use demo or own.`);
  }

  const client = skipConnect
    ? null
    : await resolveSetupClient(options, prompt, yes);

  if (path === "demo") {
    return runDemoPath({ ...options, io, cwd, env, client, skipConnect });
  }
  return runOwnPath({ ...options, io, cwd, env, prompt, yes, client, skipConnect });
}

async function resolveSetupClient(
  options: RunSetupOptions,
  prompt: Prompter,
  yes: boolean,
): Promise<string | null> {
  if (options.connect) {
    return resolveClient(options.connect).id;
  }
  if (yes) return null;
  const writable = listClients().filter((c) => c.id !== "generic");
  const chosen = await prompt.select<string>(
    "Which agent should Grane register with?",
    [
      ...writable.map((c) => ({
        value: c.id,
        label: c.label,
        hint: c.id === "chatgpt" ? "No config file — prints HTTPS connector steps." : undefined,
      })),
      { value: "skip", label: "Skip for now", hint: "You can run grane mcp connect later." },
    ],
    { defaultValue: "cursor" },
  );
  if (chosen === "skip") return null;
  return resolveClient(chosen).id;
}

async function runDemoPath(opts: {
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
  runDemoFn?: RunSetupOptions["runDemoFn"];
  connectMcpFn?: RunSetupOptions["connectMcpFn"];
}): Promise<SetupResult> {
  const demoFn = opts.runDemoFn ?? runDemo;
  opts.io.log("");
  opts.io.log("Building the demo shop and running the investigation…");
  const demo = await demoFn({
    dir: opts.dir,
    cwd: opts.cwd,
    io: opts.io,
    nextSteps: false,
    json: false,
  });

  const connected = connectIfRequested(opts, demo.projectDir);
  printReady(opts.io, opts.json, demoReadyLines({
    projectDir: demo.projectDir,
    clientLabel: connected.label,
  }));

  return {
    path: "demo",
    projectDir: demo.projectDir,
    warehouse: "duckdb",
    client: opts.client,
    question: DEMO_QUESTION,
    validated: true,
    live: true,
    connect: connected.result,
  };
}

async function runOwnPath(opts: {
  io: SetupIo;
  cwd: string;
  env: NodeJS.ProcessEnv;
  prompt: Prompter;
  yes: boolean;
  dir?: string;
  url?: string;
  provider?: string;
  offline?: boolean;
  json?: boolean;
  client: string | null;
  skipConnect: boolean;
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

  const resolvedUrl = await resolveOwnUrl(opts);
  if (resolvedUrl.parsed && resolvedUrl.persist) {
    persistOwnConnection(projectDir, resolvedUrl.parsed);
    opts.env.DATABASE_URL = resolvedUrl.parsed.url;
    opts.io.log(`connection  ${resolvedUrl.parsed.type}  ${maskDatabaseUrl(resolvedUrl.parsed.url)}`);
  } else if (resolvedUrl.parsed) {
    opts.env.DATABASE_URL = resolvedUrl.parsed.url;
    opts.io.log(`connection  ${resolvedUrl.parsed.type}  \${DATABASE_URL}`);
  } else {
    opts.io.log("connection  postgres  ${DATABASE_URL}");
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
    warehouse: resolvedUrl.parsed?.type ?? "postgres",
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

async function resolveOwnUrl(opts: {
  url?: string;
  env: NodeJS.ProcessEnv;
  prompt: Prompter;
  yes: boolean;
  io: SetupIo;
}): Promise<{ parsed: ReturnType<typeof parseOwnDatabaseUrl> | null; persist: boolean }> {
  if (opts.url) return { parsed: parseOwnDatabaseUrl(opts.url), persist: true };
  const fromEnv = opts.env.DATABASE_URL?.trim();
  if (opts.yes) {
    if (fromEnv) return { parsed: parseOwnDatabaseUrl(fromEnv), persist: false };
    throw new Error(
      "Own-database setup needs a URL. Pass --url postgres://… or set DATABASE_URL.",
    );
  }
  opts.io.log("");
  opts.io.log("Use a read-only Postgres user. Superuser and migration roles are the wrong control.");
  opts.io.log("mysql:// and clickhouse:// also write connection.type. Other engines: edit grane.yml.");
  const entered = await opts.prompt.input("Postgres URL", {
    defaultValue: fromEnv ? maskDatabaseUrl(fromEnv) : undefined,
    allowEmpty: Boolean(fromEnv),
  });
  if (!entered || entered === (fromEnv ? maskDatabaseUrl(fromEnv) : "")) {
    if (fromEnv) return { parsed: parseOwnDatabaseUrl(fromEnv), persist: false };
    throw new Error("A Postgres URL is required (or set DATABASE_URL).");
  }
  return { parsed: parseOwnDatabaseUrl(entered), persist: true };
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
    const keepGoing = await prompt.confirm("Config is written. Continue to MCP connect anyway?", true);
    if (!keepGoing) {
      throw new Error("Setup stopped. Fix the URL and re-run grane setup.");
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
