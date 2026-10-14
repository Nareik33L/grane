export type SetupPath = "demo" | "own" | "import";

/** Nested under the existing demo path. DuckDB is today's behaviour. */
export type DemoEngine = "duckdb" | "postgres";
/** Nested under demo Postgres: shipped YAML (a) or authoring (b). */
export type DemoYaml = "shipped" | "authoring";

export interface SetupIo {
  log: (line: string) => void;
  error: (line: string) => void;
}
