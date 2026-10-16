import { createPrivateKey } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import type { ConnectionConfig, LimitsConfig, Scalar } from "../config/schema.js";
import { configError } from "../errors.js";
import { snowflakeDialect } from "./dialect.js";
import type { DatabaseSchema, ExecutedRows, TableInfo, WarehouseConnector } from "./types.js";
import { loadOptionalModule, isWriteSql, timeoutSeconds } from "./types.js";
import { unsafeQuery } from "../errors.js";

/** Warehouse QUERY_TAG so certify / MCP work is attributable in Snowflake history. */
export const SNOWFLAKE_QUERY_TAG = "grane";

function looksLikePem(value: string): boolean {
  return /BEGIN [A-Z ]*PRIVATE KEY/.test(value);
}

/** Runtime PKCS8 from connection.private_key only — never process.env. */
function runtimePrivateKey(value: string, passphrase?: string): string {
  const normalized = looksLikePem(value) ? value.replace(/\\n/g, "\n") : value;
  const pem = looksLikePem(normalized)
    ? normalized
    : (() => {
        try {
          if (!statSync(value).isFile()) {
            throw configError("Snowflake connection.private_key is not a PEM document or a key file path.");
          }
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "ENOENT") {
            throw configError("Snowflake connection.private_key is not a PEM document or a readable key file path.");
          }
          throw err;
        }
        return readFileSync(value, "utf8");
      })();
  const key = createPrivateKey({
    key: pem,
    format: "pem",
    passphrase: passphrase || undefined,
  });
  return key.export({ format: "pem", type: "pkcs8" }).toString();
}

/**
 * snowflake-sdk createConnection options for the runtime connector.
 * Existing password users stay byte-identical to main (password field, no
 * authenticator). Optional connection.private_key / private_key_passphrase
 * enable key-pair. Never reads process.env.
 */
export function snowflakeRuntimeCreateOptions(connection: ConnectionConfig): Record<string, unknown> {
  const schemaName = connection.schema || "PUBLIC";
  const key = connection.private_key?.trim();
  if (key) {
    return {
      account: connection.account,
      username: connection.user,
      warehouse: connection.warehouse,
      database: connection.database,
      schema: schemaName,
      role: connection.role,
      application: "Grane",
      authenticator: "SNOWFLAKE_JWT",
      privateKey: runtimePrivateKey(key, connection.private_key_passphrase),
    };
  }
  return {
    account: connection.account,
    username: connection.user,
    password: connection.password,
    warehouse: connection.warehouse,
    database: connection.database,
    schema: schemaName,
    role: connection.role,
    application: "Grane",
  };
}

/** Session SQL applied before every Snowflake query. */
export function snowflakeSessionSetupSql(timeoutMs: number): {
  combined: string;
  timeoutOnly: string;
  timezoneOnly: string;
  queryTagOnly: string;
} {
  const seconds = timeoutSeconds(timeoutMs);
  return {
    combined: `ALTER SESSION SET STATEMENT_TIMEOUT_IN_SECONDS = ${seconds}, TIMEZONE = 'UTC', QUERY_TAG = '${SNOWFLAKE_QUERY_TAG}'`,
    timeoutOnly: `ALTER SESSION SET STATEMENT_TIMEOUT_IN_SECONDS = ${seconds}`,
    timezoneOnly: `ALTER SESSION SET TIMEZONE = 'UTC'`,
    queryTagOnly: `ALTER SESSION SET QUERY_TAG = '${SNOWFLAKE_QUERY_TAG}'`,
  };
}

// snowflake-sdk is CommonJS; we load it dynamically so Postgres-only installs stay light.
type SnowflakeSdk = {
  createConnection: (opts: Record<string, unknown>) => SnowflakeConnection;
  default?: { createConnection: (opts: Record<string, unknown>) => SnowflakeConnection };
};
type SnowflakeConnection = {
  connect: (cb: (err: Error | null) => void) => void;
  execute: (opts: {
    sqlText: string;
    binds?: unknown[];
    complete: (err: Error | null, stmt: { getColumns?: () => { getName: () => string }[] }, rows?: Record<string, unknown>[]) => void;
  }) => void;
  destroy: (cb: (err: Error | null) => void) => void;
};

export class SnowflakeConnector implements WarehouseConnector {
  readonly type = "snowflake" as const;
  readonly dialect = snowflakeDialect;
  private conn: SnowflakeConnection | null = null;
  private readonly connection: ConnectionConfig;
  private readonly schemaName: string;

  constructor(connection: ConnectionConfig) {
    this.connection = connection;
    this.schemaName = connection.schema || "PUBLIC";
  }

  private async getConn(): Promise<SnowflakeConnection> {
    if (this.conn) return this.conn;
    const mod = await loadOptionalModule<SnowflakeSdk>("snowflake-sdk", "Snowflake");
    const create = mod.createConnection ?? mod.default?.createConnection;
    if (!create) throw configError("snowflake-sdk did not export createConnection.");
    const account = this.connection.account;
    if (!account && !this.connection.url) {
      throw configError("Snowflake connection requires connection.account (and user/password/warehouse/database).");
    }
    const conn = create(snowflakeRuntimeCreateOptions(this.connection));
    await new Promise<void>((resolve, reject) => {
      conn.connect((err) => (err ? reject(err) : resolve()));
    });
    this.conn = conn;
    return conn;
  }

  private sessionSql(sql: string): Promise<void> {
    return new Promise((resolve, reject) => {
      void this.getConn().then((conn) => {
        conn.execute({
          sqlText: sql,
          complete: (err) => (err ? reject(err) : resolve()),
        });
      }, reject);
    });
  }

  private exec(sql: string, binds: unknown[] = []): Promise<{ rows: Record<string, unknown>[]; columns: string[] }> {
    if (isWriteSql(sql)) {
      throw unsafeQuery("Refusing to execute a non-SELECT statement.");
    }
    return new Promise((resolve, reject) => {
      void this.getConn().then((conn) => {
        conn.execute({
          sqlText: sql,
          binds,
          complete: (err, stmt, rows) => {
            if (err) return reject(err);
            const columns = stmt.getColumns?.().map((c) => c.getName()) ?? Object.keys(rows?.[0] ?? {});
            resolve({ rows: (rows ?? []) as Record<string, unknown>[], columns });
          },
        });
      }, reject);
    });
  }

  async query(sql: string, params: Scalar[], limits: LimitsConfig): Promise<ExecutedRows> {
    const setup = snowflakeSessionSetupSql(limits.timeout_ms);
    try {
      await this.sessionSql(setup.combined);
    } catch {
      try {
        await this.sessionSql(setup.timeoutOnly);
      } catch {
        // Best-effort: some roles cannot ALTER SESSION. The query still runs.
      }
      try {
        await this.sessionSql(setup.timezoneOnly);
      } catch {
        // TIMEZONE pin is best-effort when the role cannot ALTER SESSION.
      }
      try {
        await this.sessionSql(setup.queryTagOnly);
      } catch {
        // QUERY_TAG is best-effort when the role cannot ALTER SESSION.
      }
    }
    const { rows, columns } = await this.exec(sql, params);
    return { columns, rows: rows.slice(0, limits.max_rows) };
  }

  async introspect(): Promise<DatabaseSchema> {
    const schemaName = this.schemaName.toUpperCase();
    const { rows } = await this.exec(
      `SELECT table_name AS TABLE_NAME, column_name AS COLUMN_NAME, data_type AS DATA_TYPE, is_nullable AS IS_NULLABLE
       FROM information_schema.columns
       WHERE table_schema = ?
       ORDER BY table_name, ordinal_position`,
      [schemaName],
    );
    const tablesByName = new Map<string, TableInfo>();
    for (const row of rows) {
      const tableName = String(row["TABLE_NAME"] ?? row["table_name"]);
      let table = tablesByName.get(tableName);
      if (!table) {
        table = { schema: schemaName, name: tableName, columns: [] };
        tablesByName.set(tableName, table);
      }
      table.columns.push({
        name: String(row["COLUMN_NAME"] ?? row["column_name"]),
        dataType: String(row["DATA_TYPE"] ?? row["data_type"]),
        nullable: String(row["IS_NULLABLE"] ?? row["is_nullable"]).toUpperCase() === "YES",
      });
    }
    let foreignKeys: DatabaseSchema["foreignKeys"] = [];
    try {
      const fk = await this.exec(
        `SELECT fk.constraint_name AS CONSTRAINT_NAME, fk.table_name AS TABLE_NAME, fkc.column_name AS COLUMN_NAME,
                pk.table_name AS REF_TABLE, pkc.column_name AS REF_COLUMN
         FROM information_schema.table_constraints fk
         JOIN information_schema.referential_constraints rc ON fk.constraint_name = rc.constraint_name
         JOIN information_schema.table_constraints pk ON rc.unique_constraint_name = pk.constraint_name
         JOIN information_schema.key_column_usage fkc ON fk.constraint_name = fkc.constraint_name
         JOIN information_schema.key_column_usage pkc
           ON pk.constraint_name = pkc.constraint_name AND fkc.ordinal_position = pkc.ordinal_position
         WHERE fk.constraint_type = 'FOREIGN KEY' AND fk.table_schema = ?`,
        [schemaName],
      );
      foreignKeys = fk.rows.map((row) => ({
        constraintName: String(row["CONSTRAINT_NAME"] ?? row["constraint_name"]),
        table: String(row["TABLE_NAME"] ?? row["table_name"]),
        column: String(row["COLUMN_NAME"] ?? row["column_name"]),
        refTable: String(row["REF_TABLE"] ?? row["ref_table"]),
        refColumn: String(row["REF_COLUMN"] ?? row["ref_column"]),
      }));
    } catch {
      foreignKeys = [];
    }
    return { schemaName, tables: [...tablesByName.values()], foreignKeys };
  }

  async close(): Promise<void> {
    if (!this.conn) return;
    const conn = this.conn;
    this.conn = null;
    await new Promise<void>((resolve, reject) => {
      conn.destroy((err) => (err ? reject(err) : resolve()));
    });
  }
}
