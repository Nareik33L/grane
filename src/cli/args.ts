import type { QueryFilter } from "../query/model.js";

/**
 * `--filter` accepts `field=value`, `field!=value` and `field<>value`. The
 * field is everything before the first operator, so a `=`, `!` or `<>` inside
 * the value is kept verbatim (`status=a=b` → field `status`, value `a=b`).
 * Only operators the kernel already compiles are recognised.
 */
export function parseFilterSpec(expr: string): QueryFilter {
  const match = /^([^=!<>]+)(!=|<>|=)(.*)$/s.exec(expr);
  if (!match) {
    throw new Error(`Invalid --filter "${expr}"; use field=value, field!=value or field<>value.`);
  }
  const [, field, op, value] = match as unknown as [string, string, string, string];
  return { field, operator: op === "=" ? "=" : "!=", value };
}
