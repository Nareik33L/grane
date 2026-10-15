/**
 * Pre-V2-16 interactive wizard copy captured from main (V2-11, 455ab00).
 * Kept as the "before" transcript. V2-16 no longer freezes prompt text;
 * `--yes` / `--import` flag output is frozen in tests/fixtures/setup-flag-output/.
 */
export const MAIN_WIZARD_PATH_COPY = {
  PATH_QUESTION: "How do you want to start?",
  PATH_CHOICES: [
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
  demoReview: "demo shop (DuckDB)",
  ownReview: "own data",
} as const;

export const MAIN_WIZARD_DEMO_TRANSCRIPT: Array<Record<string, unknown>> = [
  {
    allowBack: true,
    choices: [
      {
        hint: "Local DuckDB. No database, no Docker. The planted revenue-drop story.",
        label: "Try Grane's demo shop",
        value: "demo",
      },
      {
        hint: "Any warehouse Grane already supports. We write grane.yml, validate, then connect an agent.",
        label: "Connect my own data",
        value: "own",
      },
    ],
    defaultValue: "demo",
    kind: "select",
    question: "How do you want to start?",
  },
  { kind: "log", line: "" },
  { kind: "log", line: "Review" },
  { kind: "log", line: "  Path    demo shop (DuckDB)" },
  { kind: "log", line: "  MCP     skip" },
  {
    allowBack: true,
    defaultYes: true,
    kind: "confirm",
    question: "Proceed?",
  },
];

export const MAIN_WIZARD_OWN_TRANSCRIPT: Array<Record<string, unknown>> = [
  {
    allowBack: true,
    choices: [
      {
        hint: "Local DuckDB. No database, no Docker. The planted revenue-drop story.",
        label: "Try Grane's demo shop",
        value: "demo",
      },
      {
        hint: "Any warehouse Grane already supports. We write grane.yml, validate, then connect an agent.",
        label: "Connect my own data",
        value: "own",
      },
    ],
    defaultValue: "demo",
    kind: "select",
    question: "How do you want to start?",
  },
  {
    allowBack: true,
    choices: [
      { hint: "certified in CI (16)", label: "PostgreSQL (postgres)", value: "postgres" },
      { hint: "certified in CI (8)", label: "MySQL (mysql)", value: "mysql" },
      { hint: "self_certifiable — not CI-certified", label: "Snowflake (snowflake)", value: "snowflake" },
      { hint: "self_certifiable — not CI-certified", label: "BigQuery (bigquery)", value: "bigquery" },
      { hint: "certified in CI (1.5)", label: "DuckDB (duckdb)", value: "duckdb" },
      { hint: "certified in CI (24)", label: "ClickHouse (clickhouse)", value: "clickhouse" },
      { hint: "self_certifiable — not CI-certified", label: "Amazon Redshift (redshift)", value: "redshift" },
      { hint: "self_certifiable — not CI-certified", label: "Databricks (databricks)", value: "databricks" },
    ],
    defaultValue: "postgres",
    kind: "select",
    question: "Which warehouse?",
  },
  {
    allowBack: true,
    allowEmpty: false,
    defaultValue: undefined,
    kind: "input",
    question: "Connection URL (postgres://…)",
  },
  {
    allowBack: true,
    allowEmpty: true,
    defaultValue: "public",
    kind: "input",
    question: "Schema",
  },
  { kind: "log", line: "" },
  { kind: "log", line: "Review" },
  { kind: "log", line: "  Path    own data" },
  { kind: "log", line: "  Engine  PostgreSQL (postgres) — certified in CI (16)" },
  { kind: "log", line: "  Connect postgres  postgres://ro@localhost:5432/app" },
  { kind: "log", line: "  MCP     skip" },
  {
    allowBack: true,
    defaultYes: true,
    kind: "confirm",
    question: "Proceed?",
  },
];
