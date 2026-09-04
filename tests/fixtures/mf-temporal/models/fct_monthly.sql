select * from (
  values
    (1, 'c1', date '2025-12-01', 10, 10),
    (2, 'c1', date '2026-01-01', 110, 100),
    (3, 'c1', date '2026-02-01', 130, 20),
    (4, 'c1', date '2026-03-01', 430, 300),
    (5, 'c1', date '2026-04-01', 470, 40),
    (6, 'c1', date '2026-05-01', 970, 500),
    (7, 'c1', date '2026-06-01', 1030, 60)
) as t(snapshot_id, customer_id, month_start, ending_balance, new_amount)
