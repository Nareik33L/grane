#!/usr/bin/env python3
"""Build the example DuckDB warehouse and Parquet files for warehouse upload.

The stranger path is `npx grane-analytics demo` (Node). This script is for
Parquet / MotherDuck / Databricks exports from the same seed SQL.
"""

from __future__ import annotations

from pathlib import Path

import duckdb

ROOT = Path(__file__).resolve().parents[1]
SQL_PATH = ROOT / "seed" / "duckdb.sql"
DB_PATH = ROOT / "analytics-duckdb" / "warehouse.duckdb"
PARQUET_DIR = ROOT / "analytics-duckdb" / "parquet"
TABLES = ("customers", "products", "orders", "order_items", "payments", "refunds")


def main() -> None:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    PARQUET_DIR.mkdir(parents=True, exist_ok=True)
    if DB_PATH.exists():
        DB_PATH.unlink()

    con = duckdb.connect(str(DB_PATH))
    con.execute(SQL_PATH.read_text())

    print(f"Wrote {DB_PATH}")
    for table in TABLES:
        count = con.execute(f"SELECT count(*) FROM {table}").fetchone()[0]
        parquet = PARQUET_DIR / f"{table}.parquet"
        con.execute(f"COPY {table} TO '{parquet}' (FORMAT PARQUET, COMPRESSION ZSTD)")
        print(f"  {table:12} {count:5} rows  ->  {parquet.name}")
    con.close()


if __name__ == "__main__":
    main()
