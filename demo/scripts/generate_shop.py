#!/usr/bin/env python3
"""Generate the canonical Grane shop seed (Postgres + DuckDB).

Dates are expressed relative to CURRENT_DATE so "last month" always contains
the Germany / CARD_AUTH_FAILED revenue drop, however long after generation
the demo is run.

Last month vs the month before (completed revenue, GBP):

    UK         -3.0%
    US         +2.0%
    Germany   -39.0%
    overall   -14.3%   (£184,230 vs £215,000)

German CARD_AUTH_FAILED payment attempts: +240% over the same window.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SEED = ROOT / "seed"

COUNTRIES = ["UK", "US", "Germany", "France", "Spain", "Netherlands"]
PLANS = ["starter", "growth", "enterprise"]
CHANNELS = ["web", "mobile", "partner"]
CATEGORIES = ["electronics", "home", "outdoors", "toys", "office"]
TICKET_CATEGORIES = ["billing", "shipping", "product", "account"]
DISCOUNTS = [None, None, None, "SUMMER50", "WELCOME10"]
FAILURES = ["CARD_AUTH_FAILED", "INSUFFICIENT_FUNDS", "CARD_EXPIRED"]

# Completed revenue targets for the two months the demo compares.
PRIOR_REVENUE = {
    "UK": 72_000,
    "US": 48_000,
    "Germany": 62_000,
    "France": 18_000,
    "Spain": 9_000,
    "Netherlands": 6_000,
}  # 215_000
LAST_REVENUE = {
    "UK": 69_840,  # -3%
    "US": 48_960,  # +2%
    "Germany": 37_820,  # -39%
    "France": 15_000,
    "Spain": 7_610,
    "Netherlands": 5_000,
}  # 184_230

# Failed CARD_AUTH_FAILED payment rows for German customers.
PRIOR_DE_AUTH_FAIL = 20
LAST_DE_AUTH_FAIL = 78  # +241% vs 20 prior extras (+ filler)


class Rng:
    """Tiny LCG so generation does not depend on Python's hash seed."""

    def __init__(self, seed: int = 42):
        self.state = seed & 0xFFFFFFFF

    def next(self) -> int:
        self.state = (1664525 * self.state + 1013904223) & 0xFFFFFFFF
        return self.state

    def random(self) -> float:
        return self.next() / 0x100000000

    def randint(self, lo: int, hi: int) -> int:
        return lo + self.next() % (hi - lo + 1)

    def choice(self, items: list):
        return items[self.next() % len(items)]

    def money(self, lo: int, hi: int) -> str:
        pounds = self.randint(lo, hi)
        pence = self.randint(0, 99)
        return f"{pounds}.{pence:02d}"


def sql_str(value: str | None) -> str:
    if value is None:
        return "NULL"
    return "'" + value.replace("'", "''") + "'"


def month_ts(months_ago: int, day: int, hour: int = 12) -> str:
    """Timestamp inside a calendar month `months_ago` before the current month.

    Dialect-neutral: Postgres and DuckDB both accept INTERVAL 'N months'.
    """
    day = max(1, min(day, 28))
    hour = max(0, min(hour, 23))
    return (
        f"(date_trunc('month', CURRENT_DATE) - INTERVAL '{months_ago} months'"
        f" + INTERVAL '{day - 1} days' + INTERVAL '{hour} hours')"
    )


def days_ago(days: int) -> str:
    return f"(CURRENT_DATE - INTERVAL '{days} days')"


@dataclass
class Shop:
    rng: Rng = field(default_factory=Rng)
    customers: list[dict] = field(default_factory=list)
    products: list[dict] = field(default_factory=list)
    orders: list[dict] = field(default_factory=list)
    items: list[dict] = field(default_factory=list)
    payments: list[dict] = field(default_factory=list)
    refunds: list[dict] = field(default_factory=list)
    subscriptions: list[dict] = field(default_factory=list)
    checkout_events: list[dict] = field(default_factory=list)
    tickets: list[dict] = field(default_factory=list)

    def build(self) -> None:
        self._customers()
        self._products()
        self._history_orders()
        self._crafted_month(months_ago=2, revenue=PRIOR_REVENUE, de_auth_fail=PRIOR_DE_AUTH_FAIL)
        self._crafted_month(months_ago=1, revenue=LAST_REVENUE, de_auth_fail=LAST_DE_AUTH_FAIL)
        self._current_month_partial()
        self._subscriptions()
        self._tickets()

    def _customers(self) -> None:
        for i in range(1, 241):
            country = COUNTRIES[(i - 1) % 6]
            self.customers.append(
                {
                    "id": i,
                    "name": f"Customer {i}",
                    "email": f"customer{i}@example.com",
                    "country": country,
                    "customer_type": "business" if i % 5 == 0 else "consumer",
                    "plan": PLANS[(i - 1) % 3],
                    "created_at": days_ago(80 + (i % 400)),
                }
            )

    def _products(self) -> None:
        for i in range(1, 41):
            self.products.append(
                {
                    "id": i,
                    "name": f"Product {i}",
                    "category": CATEGORIES[(i - 1) % 5],
                    "price": f"{10 + i * 3}.{(i * 17) % 100:02d}",
                }
            )

    def _by_country(self, country: str) -> list[int]:
        return [c["id"] for c in self.customers if c["country"] == country]

    def _add_order(
        self,
        *,
        customer_id: int,
        status: str,
        channel: str,
        net_amount: str,
        months_ago: int,
        day: int,
        failure_code: str | None = None,
        discount: str | None = None,
        extra_failed: str | None = None,
        split_payments: bool = False,
        refund: bool = False,
    ) -> int:
        oid = len(self.orders) + 1
        created = month_ts(months_ago, max(1, day - 1), 10)
        paid = month_ts(months_ago, day, 11)
        settled = month_ts(months_ago, day, 14)
        completed = month_ts(months_ago, day, 16) if status == "completed" else "NULL"
        refunded = month_ts(months_ago, min(day + 5, 28), 12) if refund else "NULL"
        self.orders.append(
            {
                "id": oid,
                "customer_id": customer_id,
                "status": status,
                "channel": channel,
                "net_amount": net_amount,
                "created_at": created,
                "paid_at": paid if status == "completed" else "NULL",
                "settled_at": settled if status == "completed" else "NULL",
                "completed_at": completed,
                "refunded_at": refunded,
                "payment_failure_code": failure_code,
                "discount_code": discount,
            }
        )
        n_items = self.rng.randint(1, 3)
        for _ in range(n_items):
            self.items.append(
                {
                    "id": len(self.items) + 1,
                    "order_id": oid,
                    "product_id": self.rng.randint(1, 40),
                    "quantity": self.rng.randint(1, 3),
                    "unit_price": self.rng.money(8, 80),
                }
            )
        for event in ("viewed", "started", "completed" if status == "completed" else "abandoned"):
            self.checkout_events.append(
                {
                    "id": len(self.checkout_events) + 1,
                    "order_id": oid,
                    "event_type": event,
                    "created_at": created,
                }
            )
        if self.rng.random() < 0.4:
            self.checkout_events.append(
                {
                    "id": len(self.checkout_events) + 1,
                    "order_id": oid,
                    "event_type": "retry",
                    "created_at": paid,
                }
            )
        amount = net_amount
        if status == "completed":
            if split_payments:
                a = round(float(amount) * 0.6, 2)
                b = round(float(amount) - a, 2)
                self._payment(oid, f"{a:.2f}", "succeeded", None, paid, settled)
                self._payment(oid, f"{b:.2f}", "succeeded", None, settled, settled)
            else:
                self._payment(oid, amount, "succeeded", None, paid, settled)
            if extra_failed:
                self._payment(
                    oid,
                    self.rng.money(20, 80),
                    "failed",
                    extra_failed,
                    created,
                    "NULL",
                )
            if refund:
                self.refunds.append(
                    {
                        "id": len(self.refunds) + 1,
                        "order_id": oid,
                        "amount": self.rng.money(10, 40),
                        "created_at": refunded,
                    }
                )
        else:
            self._payment(
                oid,
                amount,
                "failed",
                failure_code or "CARD_AUTH_FAILED",
                created,
                "NULL",
            )
        return oid

    def _payment(
        self,
        order_id: int,
        amount: str,
        status: str,
        failure_code: str | None,
        paid_at: str,
        settled_at: str,
    ) -> None:
        self.payments.append(
            {
                "id": len(self.payments) + 1,
                "order_id": order_id,
                "amount": amount,
                "status": status,
                "failure_code": failure_code,
                "paid_at": paid_at,
                "settled_at": settled_at,
            }
        )

    def _split_amount(self, total: int, n: int) -> list[str]:
        if n <= 0:
            return []
        base = total // n
        rem = total - base * n
        out = []
        for i in range(n):
            pounds = base + (1 if i < rem else 0)
            pence = (i * 17) % 100
            # Keep the sum of pounds exact; pence add a little noise then we
            # correct the last row to hit the target to the penny.
            out.append(pounds * 100 + pence)
        drift = total * 100 - sum(out)
        out[-1] += drift
        return [f"{v // 100}.{v % 100:02d}" for v in out]

    def _crafted_month(
        self,
        *,
        months_ago: int,
        revenue: dict[str, int],
        de_auth_fail: int,
    ) -> None:
        for country, total in revenue.items():
            ids = self._by_country(country)
            n = max(12, total // 450)
            amounts = self._split_amount(total, n)
            for i, amount in enumerate(amounts):
                self._add_order(
                    customer_id=ids[i % len(ids)],
                    status="completed",
                    channel=CHANNELS[i % 3],
                    net_amount=amount,
                    months_ago=months_ago,
                    day=1 + (i % 27),
                    discount=DISCOUNTS[i % len(DISCOUNTS)],
                    split_payments=(i % 5 == 0),
                    refund=(i % 9 == 0),
                    extra_failed="INSUFFICIENT_FUNDS" if i % 11 == 0 else None,
                )
            # Cancelled / pending filler so status filters matter.
            for i in range(6):
                self._add_order(
                    customer_id=ids[i % len(ids)],
                    status="cancelled" if i % 2 == 0 else "pending",
                    channel=CHANNELS[i % 3],
                    net_amount=self.rng.money(40, 200),
                    months_ago=months_ago,
                    day=2 + i * 3,
                    failure_code=FAILURES[i % 3] if i % 2 == 0 else None,
                )
        # Extra German card-auth failures (the demo lead).
        de_ids = self._by_country("Germany")
        for i in range(de_auth_fail):
            self._add_order(
                customer_id=de_ids[i % len(de_ids)],
                status="cancelled",
                channel="web",
                net_amount=self.rng.money(30, 180),
                months_ago=months_ago,
                day=1 + (i % 27),
                failure_code="CARD_AUTH_FAILED",
            )

    def _history_orders(self) -> None:
        # Months 3–11 ago plus a thin trail, so Q2 / 6m / last_year have rows.
        for months_ago in range(3, 12):
            for country in COUNTRIES:
                ids = self._by_country(country)
                n = 18 + (months_ago % 5)
                for i in range(n):
                    completed = self.rng.random() < 0.8
                    self._add_order(
                        customer_id=ids[(i * 3 + months_ago) % len(ids)],
                        status="completed" if completed else ("cancelled" if self.rng.random() < 0.6 else "pending"),
                        channel=CHANNELS[i % 3],
                        net_amount=self.rng.money(25, 420),
                        months_ago=months_ago,
                        day=1 + (i * 2) % 27,
                        failure_code=None if completed else self.rng.choice(FAILURES),
                        discount=DISCOUNTS[i % len(DISCOUNTS)],
                        split_payments=completed and i % 4 == 0,
                        refund=completed and i % 10 == 0,
                    )

    def _current_month_partial(self) -> None:
        for country in COUNTRIES:
            ids = self._by_country(country)
            for i in range(8):
                self._add_order(
                    customer_id=ids[i % len(ids)],
                    status="completed",
                    channel=CHANNELS[i % 3],
                    net_amount=self.rng.money(40, 300),
                    months_ago=0,
                    day=1 + i,
                    discount=DISCOUNTS[i % len(DISCOUNTS)],
                )

    def _subscriptions(self) -> None:
        for c in self.customers:
            if c["id"] % 3 == 0:
                continue
            active = c["id"] % 7 != 0
            self.subscriptions.append(
                {
                    "id": len(self.subscriptions) + 1,
                    "customer_id": c["id"],
                    "plan": c["plan"],
                    "status": "active" if active else "cancelled",
                    "started_at": c["created_at"],
                    "cancelled_at": days_ago(40 + c["id"] % 30) if not active else "NULL",
                    "mrr": {"starter": "29.00", "growth": "79.00", "enterprise": "249.00"}[c["plan"]],
                }
            )

    def _tickets(self) -> None:
        # Multiple tickets per some customers — grain trap vs order-level revenue.
        for c in self.customers:
            n = 1 + (c["id"] % 4)  # 1–4 tickets
            for k in range(n):
                self.tickets.append(
                    {
                        "id": len(self.tickets) + 1,
                        "customer_id": c["id"],
                        "category": TICKET_CATEGORIES[(c["id"] + k) % 4],
                        "status": "open" if k == 0 and c["id"] % 6 == 0 else "closed",
                        "created_at": days_ago(10 + (c["id"] + k) % 200),
                    }
                )


def emit_postgres(shop: Shop) -> str:
    lines = [
        "-- Canonical Grane demo shop. Generated by demo/scripts/generate_shop.py.",
        "-- Dates are relative to CURRENT_DATE so last_month always holds the story.",
        "",
        "INSERT INTO customers (id, name, email, country, customer_type, plan, created_at) VALUES",
    ]
    lines.append(_values(shop.customers, [
        "id", "name", "email", "country", "customer_type", "plan", "created_at",
    ], raw={"created_at"}))
    lines.append("SELECT setval('customers_id_seq', (SELECT max(id) FROM customers));")
    lines.append("")
    lines.append("INSERT INTO products (id, name, category, price) VALUES")
    lines.append(_values(shop.products, ["id", "name", "category", "price"], raw={"price"}))
    lines.append("SELECT setval('products_id_seq', (SELECT max(id) FROM products));")
    lines.append("")
    lines.append(
        "INSERT INTO orders (id, customer_id, status, channel, net_amount, created_at, paid_at, settled_at, completed_at, refunded_at, payment_failure_code, discount_code) VALUES"
    )
    lines.append(_values(shop.orders, [
        "id", "customer_id", "status", "channel", "net_amount",
        "created_at", "paid_at", "settled_at", "completed_at", "refunded_at",
        "payment_failure_code", "discount_code",
    ], raw={"net_amount", "created_at", "paid_at", "settled_at", "completed_at", "refunded_at"}))
    lines.append("SELECT setval('orders_id_seq', (SELECT max(id) FROM orders));")
    lines.append("")
    lines.append("INSERT INTO order_items (id, order_id, product_id, quantity, unit_price) VALUES")
    lines.append(_values(shop.items, ["id", "order_id", "product_id", "quantity", "unit_price"], raw={"unit_price"}))
    lines.append("SELECT setval('order_items_id_seq', (SELECT max(id) FROM order_items));")
    lines.append("")
    lines.append("INSERT INTO payments (id, order_id, amount, status, failure_code, paid_at, settled_at) VALUES")
    lines.append(_values(shop.payments, [
        "id", "order_id", "amount", "status", "failure_code", "paid_at", "settled_at",
    ], raw={"amount", "paid_at", "settled_at"}))
    lines.append("SELECT setval('payments_id_seq', (SELECT max(id) FROM payments));")
    lines.append("")
    lines.append("INSERT INTO refunds (id, order_id, amount, created_at) VALUES")
    lines.append(_values(shop.refunds, ["id", "order_id", "amount", "created_at"], raw={"amount", "created_at"}))
    lines.append("SELECT setval('refunds_id_seq', (SELECT max(id) FROM refunds));")
    lines.append("")
    lines.append("INSERT INTO subscriptions (id, customer_id, plan, status, started_at, cancelled_at, mrr) VALUES")
    lines.append(_values(shop.subscriptions, [
        "id", "customer_id", "plan", "status", "started_at", "cancelled_at", "mrr",
    ], raw={"started_at", "cancelled_at", "mrr"}))
    lines.append("SELECT setval('subscriptions_id_seq', (SELECT max(id) FROM subscriptions));")
    lines.append("")
    lines.append("INSERT INTO checkout_events (id, order_id, event_type, created_at) VALUES")
    lines.append(_values(shop.checkout_events, ["id", "order_id", "event_type", "created_at"], raw={"created_at"}))
    lines.append("SELECT setval('checkout_events_id_seq', (SELECT max(id) FROM checkout_events));")
    lines.append("")
    lines.append("INSERT INTO support_tickets (id, customer_id, category, status, created_at) VALUES")
    lines.append(_values(shop.tickets, ["id", "customer_id", "category", "status", "created_at"], raw={"created_at"}))
    lines.append("SELECT setval('support_tickets_id_seq', (SELECT max(id) FROM support_tickets));")
    lines.append("")
    lines.append("GRANT SELECT ON ALL TABLES IN SCHEMA public TO grane_readonly;")
    lines.append("")
    return "\n".join(lines)


def emit_duckdb(shop: Shop) -> str:
    schema = (SEED / "duckdb_schema.sql").read_text()
    parts = [
        schema.rstrip(),
        "",
        "INSERT INTO customers (id, name, email, country, customer_type, plan, created_at) VALUES",
        _values(shop.customers, [
            "id", "name", "email", "country", "customer_type", "plan", "created_at",
        ], raw={"created_at"}),
        "INSERT INTO products (id, name, category, price) VALUES",
        _values(shop.products, ["id", "name", "category", "price"], raw={"price"}),
        "INSERT INTO orders (id, customer_id, status, channel, net_amount, created_at, paid_at, settled_at, completed_at, refunded_at, payment_failure_code, discount_code) VALUES",
        _values(shop.orders, [
            "id", "customer_id", "status", "channel", "net_amount",
            "created_at", "paid_at", "settled_at", "completed_at", "refunded_at",
            "payment_failure_code", "discount_code",
        ], raw={"net_amount", "created_at", "paid_at", "settled_at", "completed_at", "refunded_at"}),
        "INSERT INTO order_items (id, order_id, product_id, quantity, unit_price) VALUES",
        _values(shop.items, ["id", "order_id", "product_id", "quantity", "unit_price"], raw={"unit_price"}),
        "INSERT INTO payments (id, order_id, amount, status, failure_code, paid_at, settled_at) VALUES",
        _values(shop.payments, [
            "id", "order_id", "amount", "status", "failure_code", "paid_at", "settled_at",
        ], raw={"amount", "paid_at", "settled_at"}),
        "INSERT INTO refunds (id, order_id, amount, created_at) VALUES",
        _values(shop.refunds, ["id", "order_id", "amount", "created_at"], raw={"amount", "created_at"}),
        "INSERT INTO subscriptions (id, customer_id, plan, status, started_at, cancelled_at, mrr) VALUES",
        _values(shop.subscriptions, [
            "id", "customer_id", "plan", "status", "started_at", "cancelled_at", "mrr",
        ], raw={"started_at", "cancelled_at", "mrr"}),
        "INSERT INTO checkout_events (id, order_id, event_type, created_at) VALUES",
        _values(shop.checkout_events, ["id", "order_id", "event_type", "created_at"], raw={"created_at"}),
        "INSERT INTO support_tickets (id, customer_id, category, status, created_at) VALUES",
        _values(shop.tickets, ["id", "customer_id", "category", "status", "created_at"], raw={"created_at"}),
        "",
    ]
    return "\n".join(parts)


def _values(rows: list[dict], cols: list[str], raw: set[str]) -> str:
    out = []
    for row in rows:
        cells = []
        for col in cols:
            value = row[col]
            if value is None or value == "NULL":
                cells.append("NULL")
            elif col in raw or col in {"id", "customer_id", "order_id", "product_id", "quantity"}:
                cells.append(str(value))
            else:
                cells.append(sql_str(str(value)))
        out.append("  (" + ", ".join(cells) + ")")
    return ",\n".join(out) + ";\n"


def main() -> None:
    SEED.mkdir(parents=True, exist_ok=True)
    shop = Shop()
    shop.build()
    print(
        "rows",
        {k: len(getattr(shop, k)) for k in [
            "customers", "products", "orders", "items", "payments",
            "refunds", "subscriptions", "checkout_events", "tickets",
        ]},
    )
    (SEED / "02_data.sql").write_text(emit_postgres(shop))
    (SEED / "duckdb.sql").write_text(emit_duckdb(shop))
    print(f"wrote {SEED / '02_data.sql'}")
    print(f"wrote {SEED / 'duckdb.sql'}")


if __name__ == "__main__":
    main()
