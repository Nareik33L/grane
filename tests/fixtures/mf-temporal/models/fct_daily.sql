select * from (
  values
    (1, 'c1', date '2025-12-01', 1, 'paid'),
    (2, 'c1', date '2025-12-15', 9, 'paid'),
    (3, 'c1', date '2026-01-01', 10, 'paid'),
    (4, 'c1', date '2026-01-15', 80, 'paid'),
    (5, 'c2', date '2026-01-15', 10, 'paid'),
    (6, 'c1', date '2026-02-01', 2, 'paid'),
    (7, 'c1', date '2026-02-20', 18, 'paid'),
    (8, 'c1', date '2026-03-01', 30, 'paid'),
    (9, 'c1', date '2026-03-31', 270, 'paid'),
    (10, 'c1', date '2026-04-01', 4, 'paid'),
    (11, 'c1', date '2026-04-15', 36, 'paid'),
    (12, 'c1', date '2026-05-01', 50, 'paid'),
    (13, 'c1', date '2026-05-20', 450, 'paid'),
    (14, 'c1', date '2026-06-01', 6, 'paid'),
    (15, 'c1', date '2026-06-15', 54, 'paid'),
    (16, 'c1', date '2026-06-10', 99, 'void')
) as t(sale_id, customer_id, sold_on, amount, status)
