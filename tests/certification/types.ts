/** Shared column kinds for dialect-specific DDL. */
export type CertColumnType =
  | "integer"
  | "bigint"
  | "text"
  | "numeric"
  | "date"
  | "timestamp_naive"
  | "timestamptz"
  | "boolean";

export interface CertColumn {
  name: string;
  type: CertColumnType;
}

export interface CertTable {
  name: string;
  columns: CertColumn[];
}
