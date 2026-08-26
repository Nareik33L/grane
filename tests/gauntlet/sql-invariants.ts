/**
 * Independent SQL safety checks. These do not consult Grane's planner.
 */

import { BLOCKED_COLUMNS } from "./data.js";

const WRITE_HEAD =
  /^\s*(with\s+[\s\S]*\b)?(insert|update|delete|drop|alter|create|truncate|grant|revoke|copy|vacuum|merge|call|do|execute)\b/i;

const WRITE_ANYWHERE =
  /\b(insert\s+into|update\s+\w+\s+set|delete\s+from|drop\s+(table|schema|view)|alter\s+table|truncate\s+|grant\s+|revoke\s+|create\s+(table|schema|view|index))\b/i;

export function isWriteSql(sql: string): boolean {
  return WRITE_HEAD.test(sql.trim()) || WRITE_ANYWHERE.test(sql);
}

export function sqlContainsBlockedColumn(sql: string, extra: string[] = []): string[] {
  const hits: string[] = [];
  const blob = sql.toLowerCase();
  for (const col of [...BLOCKED_COLUMNS, ...extra]) {
    const [table, column] = col.split(".");
    if (!table || !column) continue;
    const ident = `"${table}"."${column}"`.toLowerCase();
    const dotted = `${table}.${column}`.toLowerCase();
    if (blob.includes(ident) || blob.includes(dotted)) hits.push(col);
  }
  return hits;
}

export function sqlContainsLiteral(sql: string, fragment: string): boolean {
  return sql.toLowerCase().includes(fragment.toLowerCase());
}

const INJECTION_MARKERS = [
  "drop table",
  "drop schema",
  ";--",
  " or 1=1",
  " or '1'='1",
  "union select",
  "information_schema",
  "pg_catalog",
  "pg_sleep",
  "xp_cmdshell",
];

export function injectionEscaped(sql: string, hostileValue: string): boolean {
  const lowered = sql.toLowerCase();
  for (const marker of INJECTION_MARKERS) {
    if (lowered.includes(marker) && !parameterisedOnly(sql, marker)) return false;
  }
  if (/;/.test(sql) && /;\s*(drop|delete|insert|update|alter)\b/i.test(sql)) return false;
  if (hostileValue.length > 0 && sql.includes(hostileValue) && /['"]/.test(hostileValue)) {
    // Hostile quotes appearing as SQL syntax rather than a bound parameter.
    if (!sql.includes("$") && sql.includes(hostileValue)) return false;
  }
  return true;
}

function parameterisedOnly(_sql: string, _marker: string): boolean {
  return false;
}

export function errorLeaksSecrets(message: string): string[] {
  const leaks: string[] = [];
  const patterns: Array<[RegExp, string]> = [
    [/sk_live_[a-z0-9_]+/i, "secret token"],
    [/hash_alice|hash_bob|hash_cara|hash_dana|hash_eve/i, "password hash value"],
    [/alice@secret\.example|bob@secret\.example/i, "email value"],
    [/postgres:\/\/\S+:\S+@/i, "connection string"],
    [/\bDATABASE_URL\b/, "DATABASE_URL"],
  ];
  for (const [re, label] of patterns) {
    if (re.test(message)) leaks.push(label);
  }
  return leaks;
}

export { BLOCKED_COLUMNS };
