# Demo questions

Ask an MCP agent connected to this project:

> Why did Revenue fall last month?

That is the 60-second investigation. `npx grane-analytics demo` runs it without an agent.

## Simple

- What was Revenue last month?
- How many orders did we complete?
- What is our average order value?

## Time semantics

- What was Revenue in Q2?
- What was Revenue last quarter?
- What was Revenue in the last 30 days?

## Dimensions

- Revenue by country.
- Revenue by customer plan.
- Revenue by sales channel last month.

## Multiple tables

- How much did we collect in succeeded payments, by country?
- Show revenue and payments received side by side.

## Grain traps (should refuse or be obviously wrong in raw SQL)

- Revenue by product category.
- Revenue by support ticket category.
- Revenue by checkout event type.

## Business definitions

- How many customers do we have?
- How many customers ordered last month? (not the same question)

## Ambiguous dates

- Revenue last month. (booked on `completed_at`, not `created_at` / `paid_at` / `settled_at`)

## Restricted data

- Revenue by customer email. (blocked)

## Exploration

- Why did Revenue fall last month?
- Failed payments by failure_code for Germany last month.
