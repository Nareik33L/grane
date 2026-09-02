import { describe, expect, it } from "vitest";
import { exploringKernel, exampleKernel } from "../fixtures.js";
import { GraneError } from "../../src/errors.js";
import { parseColumnRef } from "../../src/model/refs.js";
import { quoteIdent } from "../../src/compile/compiler.js";
import { semanticQuerySchema } from "../../src/query/model.js";

function refuse(run: () => unknown): GraneError {
  try {
    run();
    expect.unreachable();
  } catch (err) {
    expect(err).toBeInstanceOf(GraneError);
    return err as GraneError;
  }
}

describe("hostile inputs", () => {
  const kernel = exploringKernel();

  it("parameterizes filter values so SQL injection cannot escape", () => {
    const payload = "'; DROP TABLE orders; --";
    const { compiled } = kernel.compile({
      metrics: ["revenue"],
      filters: [{ field: "channel", operator: "=", value: payload }],
    });
    expect(compiled.sql).not.toContain("DROP TABLE");
    expect(compiled.sql).toContain("$");
    expect(compiled.params).toContain(payload);
  });

  it("refuses identifiers that are not table.column", () => {
    const err = refuse(() =>
      kernel.compile({
        metrics: ["revenue"],
        raw_dimensions: ['orders.net_amount; DROP TABLE orders'],
      }),
    );
    expect(err.refusal.status).toBe("invalid_query");
    expect(parseColumnRef('orders.net_amount; DROP TABLE orders')).toBeNull();
  });

  it("refuses unicode lookalike identifiers", () => {
    expect(parseColumnRef("orders.ｎet_amount")).toBeNull();
    const err = refuse(() =>
      kernel.compile({
        metrics: ["revenue"],
        raw_dimensions: ["orders.ｎet_amount"],
      }),
    );
    expect(err.refusal.status).toBe("invalid_query");
  });

  it("quotes identifiers so embedded quotes cannot break out", () => {
    expect(quoteIdent('orders"')).toBe('"orders"""');
    expect(quoteIdent("orders")).toBe('"orders"');
  });

  it("refuses unknown metrics instead of inventing them", () => {
    const err = refuse(() => kernel.compile({ metrics: ["revenue;select 1"] }));
    expect(err.refusal.status).toBe("undefined_metric");
  });

  it("refuses unknown dimensions", () => {
    const err = refuse(() => kernel.compile({ metrics: ["revenue"], dimensions: ["not_a_dimension"] }));
    expect(["undefined_dimension", "invalid_query"]).toContain(err.refusal.status);
  });

  it("refuses empty queries", () => {
    const err = refuse(() => kernel.compile({ metrics: [] }));
    expect(err.refusal.status).toBe("invalid_query");
  });

  it("caps enormous limits", () => {
    const { compiled } = kernel.compile({ metrics: ["revenue"], limit: 2_147_483_647 });
    expect(compiled.sql).toMatch(/LIMIT 10000/);
  });

  it("rejects negative limits in the query model", () => {
    const parsed = semanticQuerySchema.safeParse({ metrics: ["revenue"], limit: -1 });
    expect(parsed.success).toBe(false);
  });

  it("strips unexpected properties rather than executing them", () => {
    const parsed = semanticQuerySchema.parse({
      metrics: ["revenue"],
      sql: "SELECT password FROM users",
      nested: { expression: "1=1" },
    });
    expect(parsed).not.toHaveProperty("sql");
    expect(parsed).not.toHaveProperty("nested");
  });

  it("refuses malformed time ranges", () => {
    const err = refuse(() =>
      kernel.compile({
        metrics: ["revenue"],
        time: { from: "2026-08-01", to: "2026-07-01" },
      }),
    );
    expect(err.refusal.status).toBe("invalid_query");
  });
});

describe("information boundaries", () => {
  const kernel = exploringKernel();

  it("blocks email as a raw dimension", () => {
    const err = refuse(() =>
      kernel.compile({ metrics: ["revenue"], raw_dimensions: ["customers.email"] }),
    );
    expect(err.refusal.status).toBe("column_not_permitted");
  });

  it("blocks email as a filter", () => {
    const err = refuse(() =>
      kernel.compile({
        metrics: ["revenue"],
        filters: [{ field: "customers.email", operator: "=", value: "a@b.c" }],
      }),
    );
    expect(err.refusal.status).toBe("column_not_permitted");
  });

  it("blocks email with alternate casing", () => {
    const err = refuse(() =>
      kernel.compile({ metrics: ["revenue"], raw_dimensions: ["Customers.Email"] }),
    );
    expect(err.refusal.status).toBe("column_not_permitted");
  });

  it("blocks email as a time dimension", () => {
    const err = refuse(() =>
      kernel.compile({
        metrics: ["revenue"],
        time: { dimension: "customers.email", from: "2026-07-01", to: "2026-07-31" },
      }),
    );
    expect(err.refusal.status).toBe("column_not_permitted");
  });

  it("does not treat email as a governed dimension name", () => {
    const err = refuse(() => kernel.compile({ metrics: ["revenue"], dimensions: ["email"] }));
    expect(["undefined_dimension", "invalid_query"]).toContain(err.refusal.status);
  });
});

describe("join and grain safety", () => {
  const kernel = exploringKernel();

  it("refuses revenue by support ticket category", () => {
    const err = refuse(() =>
      kernel.compile({ metrics: ["revenue"], raw_dimensions: ["support_tickets.category"] }),
    );
    expect(err.refusal.status).toBe("unsafe_query");
    expect(err.refusal.message).toMatch(/one_to_many/);
  });

  it("refuses revenue by checkout event type", () => {
    const err = refuse(() =>
      kernel.compile({ metrics: ["revenue"], raw_dimensions: ["checkout_events.event_type"] }),
    );
    expect(err.refusal.status).toBe("unsafe_query");
  });

  it("refuses revenue by payment failure_code", () => {
    const err = refuse(() =>
      kernel.compile({ metrics: ["revenue"], raw_dimensions: ["payments.failure_code"] }),
    );
    expect(err.refusal.status).toBe("unsafe_query");
  });

  it("refuses mixing metric grains", () => {
    const err = refuse(() => kernel.compile({ metrics: ["revenue", "customers"] }));
    expect(err.refusal.status).toBe("invalid_query");
  });

  it("allows a safe many_to_one slice by plan", () => {
    const { compiled } = kernel.compile({ metrics: ["revenue"], dimensions: ["plan"] });
    expect(compiled.sql).toContain('"customers"."plan"');
    expect(compiled.trust).toBe("governed");
  });
});

describe("warehouse statement safety", () => {
  it("the compiler emits only SELECT", () => {
    const { compiled } = exampleKernel().compile({ metrics: ["revenue"] });
    expect(compiled.sql.trim().toUpperCase().startsWith("WITH") || compiled.sql.trim().startsWith("SELECT")).toBe(
      true,
    );
    expect(compiled.sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|ALTER|GRANT)\b/i);
  });
});
