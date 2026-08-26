#!/usr/bin/env python3
"""Build a DuckDB warehouse from the canonical demo seed."""

from __future__ import annotations

from pathlib import Path

import duckdb

ROOT = Path(__file__).resolve().parents[1]
SQL_PATH = ROOT.parent / "demo" / "seed" / "duckdb.sql"
DB_PATH = ROOT / "analytics-duckdb" / "warehouse.duckdb"


def main() -> None:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    if DB_PATH.exists():
        DB_PATH.unlink()
    con = duckdb.connect(str(DB_PATH))
    con.execute(SQL_PATH.read_text())
    print(f"Wrote {DB_PATH}")
    for table in (
        "customers",
        "products",
        "orders",
        "order_items",
        "payments",
        "refunds",
        "subscriptions",
        "checkout_events",
        "support_tickets",
    ):
        count = con.execute(f"SELECT count(*) FROM {table}").fetchone()[0]
        print(f"  {table:16} {count:5} rows")
    con.close()


if __name__ == "__main__":
    main()
