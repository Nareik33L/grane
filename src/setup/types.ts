export type SetupPath = "demo" | "own" | "import";

/** Nested under the existing demo path. DuckDB is today's behaviour. */
export type DemoEngine = "duckdb" | "postgres";
/** Nested under demo Postgres: shipped YAML (a) or authoring (b). */
export type DemoYaml = "shipped" | "authoring";

/** Interactive start-question values. `demo_postgres` maps to path demo + postgres. */
export type StartChoice = "demo" | "demo_postgres" | "own" | "import";

export interface SetupIo {
  log: (line: string) => void;
  error: (line: string) => void;
}
