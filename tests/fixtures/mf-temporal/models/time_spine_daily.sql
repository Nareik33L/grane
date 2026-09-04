{{
    config(materialized='table')
}}

select cast(date_day as date) as date_day
from generate_series(
    date '2025-12-01',
    date '2026-06-30',
    interval 1 day
) as t(date_day)
