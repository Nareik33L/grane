/**
 * Path-agnostic static analysis of SQL, used to grade all three execution
 * paths with the same ruler.
 *
 * Nothing here consults the Grane semantic model or Grane's join planner: the
 * cardinality facts below are read off the example shop schema by hand, so
 * Grane's generated SQL is judged by the same independent rules as the
 * handwritten path A / path B fixtures.
 */

/**
 * One-to-many edges of the example shop, as parent -> child. Joining a child
 * table while aggregating at the parent grain multiplies parent rows.
 *
 *   customers 1--N orders
 *   orders    1--N payments      (1-2 succeeded rows per completed order)
 *   orders    1--N refunds
 *   orders    1--N order_items
 *   products  1--N order_items
 */
const ONE_TO_MANY: { parent: string; child: string }[] = [
  { parent: "customers", child: "orders" },
  { parent: "orders", child: "payments" },
  { parent: "orders", child: "refunds" },
  { parent: "orders", child: "order_items" },
  { parent: "products", child: "order_items" },
];

const TABLES = new Set([
  "customers",
  "orders",
  "order_items",
  "payments",
  "refunds",
  "products",
]);

/**
 * Tables that cannot be joined from `base` without fanning out its grain:
 * every relationship path from `base` to them traverses at least one
 * parent -> child hop.
 */
export function fanOutTablesFrom(base: string): Set<string> {
  const safe = new Set<string>([base]);
  // Walk only many-to-one (child -> parent) hops; anything still unreached
  // can only be joined by descending a one-to-many edge.
  const queue = [base];
  while (queue.length > 0) {
    const table = queue.shift()!;
    for (const edge of ONE_TO_MANY) {
      if (edge.child === table && !safe.has(edge.parent)) {
        safe.add(edge.parent);
        queue.push(edge.parent);
      }
    }
  }
  return new Set([...TABLES].filter((t) => !safe.has(t)));
}

/** Substitute `$n` placeholders with SQL literals so params are gradeable. */
export function inlineParams(sql: string, params: readonly unknown[]): string {
  if (params.length === 0) return sql;
  return sql.replace(/\$(\d+)/g, (whole, index: string) => {
    const value = params[Number(index) - 1];
    if (value === undefined) return whole;
    if (value === null) return "NULL";
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    return `'${String(value).replaceAll("'", "''")}'`;
  });
}

/**
 * Blank out everything nested inside parentheses, so the remaining text is
 * only the outermost query: its FROM, its JOINs, its WHERE. Sub-selects and
 * CTE bodies (where pre-aggregation happens) disappear.
 */
function outerLevelOnly(sql: string): string {
  const out: string[] = [];
  let depth = 0;
  for (const ch of sql) {
    if (ch === "(") {
      depth += 1;
      out.push(" ");
      continue;
    }
    if (ch === ")") {
      depth = Math.max(0, depth - 1);
      out.push(" ");
      continue;
    }
    out.push(depth === 0 ? ch : ch === "\n" ? "\n" : " ");
  }
  return out.join("");
}

function normalize(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replaceAll('"', "")
    .replaceAll("`", "")
    .toLowerCase();
}

export interface SqlAnalysis {
  /** SQL with parameters inlined, for human-readable reporting. */
  effectiveSql: string;
  /** Base table of the outermost query, if any. */
  baseTable: string | null;
  /** Tables joined by the outermost query (CTE and derived-table names included). */
  outerJoins: string[];
  /** Outer joins that fan out the base grain. Empty means grain-safe. */
  fanOutJoins: string[];
  /** Status literals compared against a `status` column anywhere in the query. */
  statusLiterals: Set<string>;
  /** Time columns constrained by a range predicate. */
  boundsOn: Set<string>;
  /** Time columns fed to a date-truncating function. */
  truncatesOn: Set<string>;
}

const TIME_COLUMNS = ["completed_at", "created_at", "paid_at"];

export function analyzeSql(sql: string, params: readonly unknown[] = []): SqlAnalysis {
  const effectiveSql = inlineParams(sql, params);
  const normalized = normalize(effectiveSql);
  const outer = outerLevelOnly(normalized);

  const fromMatch = /\bfrom\s+([a-z_][a-z0-9_]*)/.exec(outer);
  const baseTable = fromMatch ? fromMatch[1]! : null;

  const outerJoins: string[] = [];
  for (const match of outer.matchAll(/\bjoin\s+([a-z_][a-z0-9_]*)/g)) {
    outerJoins.push(match[1]!);
  }

  const fanOut = baseTable && TABLES.has(baseTable) ? fanOutTablesFrom(baseTable) : new Set<string>();
  const fanOutJoins = [...new Set(outerJoins.filter((t) => fanOut.has(t)))];

  const boundsOn = new Set<string>();
  const truncatesOn = new Set<string>();
  for (const column of TIME_COLUMNS) {
    if (new RegExp(`\\b${column}\\b\\s*(>=|<=|>|<|between)`).test(normalized)) boundsOn.add(column);
    if (new RegExp(`(date_trunc|date_format|to_char|strftime)\\s*\\([^)]*\\b${column}\\b`).test(normalized)) {
      truncatesOn.add(column);
    }
  }

  const statusLiterals = new Set<string>();
  for (const predicate of normalized.matchAll(/\bstatus\b\s*(?:=|<>|!=|not\s+in|in)\s*\(?([^)\n]*)/g)) {
    for (const literal of predicate[1]!.matchAll(/'([^']*)'/g)) {
      statusLiterals.add(literal[1]!);
    }
  }

  return {
    effectiveSql,
    baseTable,
    outerJoins,
    fanOutJoins,
    statusLiterals,
    boundsOn,
    truncatesOn,
  };
}
