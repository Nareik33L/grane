/**
 * Pathological DuckDB warehouse for the Gauntlet.
 *
 * Seeded from tests/gauntlet/data.ts (the mathematical fixtures) plus extra
 * trap tables: empty relations, duplicate keys, a blocked schema, inventory.
 * DDL is generated here; gold answers are not.
 */

import type { ConnectionConfig, LimitsConfig, Scalar } from "../../src/config/schema.js";
import { duckdbDialect } from "../../src/connectors/dialect.js";
import type { DatabaseSchema, ExecutedRows, TableInfo, WarehouseConnector } from "../../src/connectors/types.js";
import { unsafeQuery } from "../../src/errors.js";
import {
  ACCOUNT_MEMBERS,
  ACCOUNTS,
  ATTRIBUTION_EVENTS,
  BILLING_ADDRESSES,
  CAMPAIGNS,
  CHAIN_A,
  CHAIN_B,
  CHAIN_C,
  CHAIN_D,
  CHAIN_E,
  CHAIN_F,
  CHECKOUT_EVENTS,
  COUNTRIES,
  CUSTOMERS,
  CYCLE_A,
  CYCLE_B,
  CYCLE_C,
  DAILY_ACCOUNT_SNAPSHOTS,
  EMPLOYEES,
  EXCHANGE_RATES,
  EXPERIMENT_ASSIGNMENTS,
  EXPERIMENTS,
  INVOICE_LINES,
  INVOICES,
  ORDER_ITEMS,
  ORDERS,
  PAYMENT_ATTEMPTS,
  PAYMENTS,
  PLANS,
  PRODUCT_CATEGORIES,
  PRODUCT_CATEGORY_MAP,
  PRODUCTS,
  REFUNDS,
  SALES_REGIONS,
  SESSIONS,
  SHIPPING_ADDRESSES,
  SUBSCRIPTION_EVENTS,
  SUBSCRIPTIONS,
  SUPPORT_TICKETS,
  TICKET_TAGS,
} from "./data.js";

type DuckDbReader = {
  columnNames?: () => string[];
  getRowObjectsJS?: () => Record<string, unknown>[];
  getRowObjects?: () => Record<string, unknown>[];
};

type DuckDbConnection = {
  runAndReadAll: (sql: string, values?: unknown[]) => Promise<DuckDbReader>;
  closeSync?: () => void;
  disconnectSync?: () => void;
};

type DuckDbInstance = {
  connect: () => Promise<DuckDbConnection>;
};

type DuckDbMod = {
  DuckDBInstance: {
    create: (path?: string, opts?: Record<string, string>) => Promise<DuckDbInstance>;
  };
};

const WRITE_HEAD =
  /^\s*(insert|update|delete|drop|alter|create|truncate|grant|revoke|copy|vacuum|merge|call|do|execute)\b/i;

function sqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "NULL";
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  const text = String(value);
  if (/^\d{4}-\d{2}-\d{2}T/.test(text)) {
    return `TIMESTAMPTZ '${text.replace("T", " ").replace("Z", "+00")}'`;
  }
  return `'${text.replaceAll("'", "''")}'`;
}

function insertSql(table: string, rows: Array<Record<string, unknown>>): string {
  if (rows.length === 0) return `SELECT 1 WHERE FALSE`;
  const cols = Object.keys(rows[0]!);
  const values = rows
    .map((row) => `(${cols.map((col) => sqlLiteral(row[col])).join(", ")})`)
    .join(",\n  ");
  return `INSERT INTO ${table} (${cols.join(", ")}) VALUES\n  ${values}`;
}

const DDL: string[] = [
  `CREATE TABLE countries (id INTEGER, code VARCHAR, name VARCHAR)`,
  `CREATE TABLE customers (
     id INTEGER, name VARCHAR, email VARCHAR, phone VARCHAR, password_hash VARCHAR,
     ip_address VARCHAR, date_of_birth DATE, country VARCHAR, country_id INTEGER,
     customer_type VARCHAR, created_at TIMESTAMPTZ, deleted_at TIMESTAMPTZ
   )`,
  `CREATE TABLE accounts (id INTEGER, name VARCHAR, country VARCHAR)`,
  `CREATE TABLE account_members (account_id INTEGER, customer_id INTEGER, role VARCHAR)`,
  `CREATE TABLE orders (
     id INTEGER, customer_id INTEGER, status VARCHAR, channel VARCHAR,
     net_amount DECIMAL(18,4), currency VARCHAR, discount_code VARCHAR, device_type VARCHAR,
     created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ, paid_at TIMESTAMPTZ,
     settled_at TIMESTAMPTZ, completed_at TIMESTAMPTZ, cancelled_at TIMESTAMPTZ, refunded_at TIMESTAMPTZ
   )`,
  `CREATE TABLE billing_addresses (id INTEGER, order_id INTEGER, country VARCHAR, country_id INTEGER)`,
  `CREATE TABLE shipping_addresses (id INTEGER, order_id INTEGER, country VARCHAR, country_id INTEGER)`,
  `CREATE TABLE products (id INTEGER, name VARCHAR, category VARCHAR, inventory_level INTEGER)`,
  `CREATE TABLE product_categories (id INTEGER, name VARCHAR)`,
  `CREATE TABLE product_category_map (product_id INTEGER, category_id INTEGER)`,
  `CREATE TABLE order_items (id INTEGER, order_id INTEGER, product_id INTEGER, quantity INTEGER, amount DECIMAL(18,4))`,
  `CREATE TABLE payments (id INTEGER, order_id INTEGER, amount DECIMAL(18,4), status VARCHAR, card_fingerprint VARCHAR, country VARCHAR)`,
  `CREATE TABLE payment_attempts (id INTEGER, payment_id INTEGER, attempt INTEGER, status VARCHAR)`,
  `CREATE TABLE refunds (id INTEGER, order_id INTEGER, amount DECIMAL(18,4), refunded_at TIMESTAMPTZ)`,
  `CREATE TABLE support_tickets (id INTEGER, customer_id INTEGER, category VARCHAR, created_at TIMESTAMPTZ)`,
  `CREATE TABLE ticket_tags (ticket_id INTEGER, tag VARCHAR)`,
  `CREATE TABLE sessions (id INTEGER, customer_id INTEGER, browser VARCHAR, started_at TIMESTAMPTZ)`,
  `CREATE TABLE checkout_events (id INTEGER, session_id INTEGER, order_id INTEGER, error VARCHAR, event_at TIMESTAMPTZ)`,
  `CREATE TABLE experiments (id INTEGER, name VARCHAR)`,
  `CREATE TABLE experiment_assignments (experiment_id INTEGER, customer_id INTEGER, variant VARCHAR)`,
  `CREATE TABLE campaigns (id INTEGER, name VARCHAR)`,
  `CREATE TABLE attribution_events (id INTEGER, order_id INTEGER, campaign_id INTEGER, position INTEGER)`,
  `CREATE TABLE employees (id INTEGER, name VARCHAR, department VARCHAR, salary INTEGER)`,
  `CREATE TABLE plans (id INTEGER, name VARCHAR, monthly_amount DECIMAL(18,4))`,
  `CREATE TABLE subscriptions (id INTEGER, customer_id INTEGER, plan_id INTEGER, status VARCHAR, started_at TIMESTAMPTZ)`,
  `CREATE TABLE subscription_events (id INTEGER, subscription_id INTEGER, kind VARCHAR, event_at TIMESTAMPTZ)`,
  `CREATE TABLE invoices (id INTEGER, account_id INTEGER, total DECIMAL(18,4), issued_at TIMESTAMPTZ)`,
  `CREATE TABLE invoice_lines (id INTEGER, invoice_id INTEGER, amount DECIMAL(18,4))`,
  `CREATE TABLE exchange_rates (date DATE, from_currency VARCHAR, to_currency VARCHAR, rate DECIMAL(18,6))`,
  `CREATE TABLE daily_account_snapshots (account_id INTEGER, snapshot_date DATE, balance DECIMAL(18,4))`,
  `CREATE TABLE sales_regions (country VARCHAR, region VARCHAR)`,
  `CREATE TABLE chain_a (id INTEGER, label VARCHAR)`,
  `CREATE TABLE chain_b (id INTEGER, a_id INTEGER, label VARCHAR)`,
  `CREATE TABLE chain_c (id INTEGER, b_id INTEGER, label VARCHAR)`,
  `CREATE TABLE chain_d (id INTEGER, c_id INTEGER, label VARCHAR)`,
  `CREATE TABLE chain_e (id INTEGER, d_id INTEGER, label VARCHAR)`,
  `CREATE TABLE chain_f (id INTEGER, e_id INTEGER, value INTEGER)`,
  `CREATE TABLE cycle_a (id INTEGER, b_id INTEGER)`,
  `CREATE TABLE cycle_b (id INTEGER, c_id INTEGER)`,
  `CREATE TABLE cycle_c (id INTEGER, a_id INTEGER)`,
  `CREATE TABLE empty_events (id INTEGER, payload VARCHAR)`,
  `CREATE TABLE dup_customers (id INTEGER, name VARCHAR)`,
  `CREATE TABLE inventory_levels (product_id INTEGER, as_of DATE, units INTEGER)`,
  `CREATE SCHEMA secrets`,
  `CREATE TABLE secrets.api_keys (id INTEGER, token VARCHAR)`,
];

function dml(): string[] {
  return [
    insertSql("countries", [...COUNTRIES]),
    insertSql("customers", CUSTOMERS as unknown as Array<Record<string, unknown>>),
    insertSql("accounts", [...ACCOUNTS]),
    insertSql("account_members", [...ACCOUNT_MEMBERS]),
    insertSql("orders", ORDERS as unknown as Array<Record<string, unknown>>),
    insertSql("billing_addresses", [...BILLING_ADDRESSES]),
    insertSql("shipping_addresses", [...SHIPPING_ADDRESSES]),
    insertSql("products", [...PRODUCTS]),
    insertSql("product_categories", [...PRODUCT_CATEGORIES]),
    insertSql("product_category_map", [...PRODUCT_CATEGORY_MAP]),
    insertSql("order_items", [...ORDER_ITEMS]),
    insertSql("payments", [...PAYMENTS]),
    insertSql("payment_attempts", [...PAYMENT_ATTEMPTS]),
    insertSql("refunds", [...REFUNDS]),
    insertSql("support_tickets", [...SUPPORT_TICKETS]),
    insertSql("ticket_tags", [...TICKET_TAGS]),
    insertSql("sessions", [...SESSIONS]),
    insertSql("checkout_events", [...CHECKOUT_EVENTS]),
    insertSql("experiments", [...EXPERIMENTS]),
    insertSql("experiment_assignments", [...EXPERIMENT_ASSIGNMENTS]),
    insertSql("campaigns", [...CAMPAIGNS]),
    insertSql("attribution_events", [...ATTRIBUTION_EVENTS]),
    insertSql("employees", [...EMPLOYEES]),
    insertSql("plans", [...PLANS]),
    insertSql("subscriptions", [...SUBSCRIPTIONS]),
    insertSql("subscription_events", [...SUBSCRIPTION_EVENTS]),
    insertSql("invoices", [...INVOICES]),
    insertSql("invoice_lines", [...INVOICE_LINES]),
    insertSql("exchange_rates", [...EXCHANGE_RATES]),
    insertSql("daily_account_snapshots", [...DAILY_ACCOUNT_SNAPSHOTS]),
    insertSql("sales_regions", [...SALES_REGIONS]),
    insertSql("chain_a", [...CHAIN_A]),
    insertSql("chain_b", [...CHAIN_B]),
    insertSql("chain_c", [...CHAIN_C]),
    insertSql("chain_d", [...CHAIN_D]),
    insertSql("chain_e", [...CHAIN_E]),
    insertSql("chain_f", [...CHAIN_F]),
    insertSql("cycle_a", [...CYCLE_A]),
    insertSql("cycle_b", [...CYCLE_B]),
    insertSql("cycle_c", [...CYCLE_C]),
    `INSERT INTO dup_customers (id, name) VALUES (1, 'Alice'), (1, 'Alice clone')`,
    `INSERT INTO inventory_levels (product_id, as_of, units) VALUES
       (1, DATE '2024-03-01', 50), (1, DATE '2024-03-15', 40), (2, DATE '2024-03-15', 10)`,
    `INSERT INTO secrets.api_keys (id, token) VALUES (1, 'sk_live_should_never_leak')`,
  ];
}

export class GauntletWarehouse implements WarehouseConnector {
  readonly type = "duckdb" as const;
  readonly dialect = duckdbDialect;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly instance: DuckDbInstance,
    private conn: DuckDbConnection | null,
  ) {}

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run as Promise<T>;
  }

  async exec(sql: string): Promise<void> {
    await this.enqueue(async () => {
      if (!this.conn) throw new Error("gauntlet warehouse is closed");
      await this.conn.runAndReadAll(sql);
    });
  }

  async runGold(sql: string): Promise<Record<string, unknown>[]> {
    const result = await this.query(sql, [], { max_rows: 100000, default_rows: 100000, timeout_ms: 30000 });
    return result.rows;
  }

  async query(sql: string, params: Scalar[], limits: LimitsConfig): Promise<ExecutedRows> {
    if (WRITE_HEAD.test(sql)) {
      throw unsafeQuery("Refusing to execute a non-SELECT statement.");
    }
    return this.enqueue(async () => {
      if (!this.conn) throw new Error("gauntlet warehouse is closed");
      const reader = await this.conn.runAndReadAll(sql, params.length > 0 ? params : undefined);
      const rows = (reader.getRowObjectsJS?.() ?? reader.getRowObjects?.() ?? []).slice(
        0,
        limits.max_rows,
      );
      const columns = reader.columnNames?.() ?? Object.keys(rows[0] ?? {});
      return { columns, rows };
    });
  }

  async introspect(): Promise<DatabaseSchema> {
    const main = await this.introspectSchema("main");
    return main;
  }

  async introspectSchema(schemaName: string): Promise<DatabaseSchema> {
    const result = await this.query(
      `SELECT table_name, column_name, data_type, is_nullable
       FROM information_schema.columns
       WHERE table_schema = $1
       ORDER BY table_name, ordinal_position`,
      [schemaName],
      { max_rows: 100000, default_rows: 100000, timeout_ms: 30000 },
    );
    const tablesByName = new Map<string, TableInfo>();
    for (const row of result.rows) {
      const tableName = String(row["table_name"]);
      let table = tablesByName.get(tableName);
      if (!table) {
        table = { schema: schemaName, name: tableName, columns: [] };
        tablesByName.set(tableName, table);
      }
      table.columns.push({
        name: String(row["column_name"]),
        dataType: String(row["data_type"]),
        nullable: String(row["is_nullable"]).toUpperCase() === "YES",
      });
    }
    return { schemaName, tables: [...tablesByName.values()], foreignKeys: [] };
  }

  async close(): Promise<void> {
    const conn = this.conn;
    this.conn = null;
    conn?.closeSync?.();
    conn?.disconnectSync?.();
  }
}

export async function duckdbAvailable(): Promise<boolean> {
  try {
    await import("@duckdb/node-api");
    return true;
  } catch {
    return false;
  }
}

export async function createGauntletWarehouse(): Promise<GauntletWarehouse> {
  const mod = (await import("@duckdb/node-api")) as DuckDbMod;
  const instance = await mod.DuckDBInstance.create(":memory:");
  const conn = await instance.connect();
  const warehouse = new GauntletWarehouse(instance, conn);
  for (const statement of DDL) {
    await warehouse.exec(statement);
  }
  for (const statement of dml()) {
    await warehouse.exec(statement);
  }
  return warehouse;
}

export const GAUNTLET_CONNECTION: ConnectionConfig = {
  type: "duckdb",
  path: ":memory:",
  schema: "main",
};
