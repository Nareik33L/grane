import type { Cardinality, RelationshipConfig } from "../config/schema.js";
import { parseColumnRef, type ColumnRef } from "./refs.js";
import { configError } from "../errors.js";

/**
 * The relationship graph connects tables. Every configured relationship
 * produces two directed edges: the declared direction and its inverse.
 *
 * Traversing an edge whose cardinality (in the direction of travel) is
 * one_to_many multiplies rows of the starting table — a fan-out. Join paths
 * used to attach dimensions must be fan-out free; measure paths may cross
 * one_to_many edges only via deterministic pre-aggregation.
 *
 * When two or more query-effective semantic paths reach the same table,
 * Grane refuses rather than picking one. YAML declaration order, BFS
 * encounter order, and lexicographic order are not semantic discriminators.
 * Guessing a path silently changes the numbers.
 */

export interface Edge {
  relationship: string;
  fromTable: string;
  fromColumn: string;
  toTable: string;
  toColumn: string;
  /** Cardinality in the direction of travel (fromTable -> toTable). */
  cardinality: Cardinality;
}

export interface JoinPath {
  edges: Edge[];
  /** True if any traversed edge is one_to_many (row-multiplying). */
  fansOut: boolean;
  /**
   * True when two or more equally valid semantic paths exist. Callers must
   * refuse rather than use `edges` as a guess. Applies to both fan-out-free
   * paths and fanning (pre-aggregation) paths.
   */
  ambiguous?: boolean;
  /** Human-readable path descriptions when `ambiguous` is true. */
  alternatives?: string[];
}

function invert(cardinality: Cardinality): Cardinality {
  if (cardinality === "many_to_one") return "one_to_many";
  if (cardinality === "one_to_many") return "many_to_one";
  return "one_to_one";
}

/** Structural identity: relationship, endpoints, columns, cardinality. */
export function edgeIdentity(edge: Edge): string {
  return `${edge.relationship}:${edge.fromTable}.${edge.fromColumn}->${edge.toTable}.${edge.toColumn}:${edge.cardinality}`;
}

export function pathIdentity(path: JoinPath): string {
  return path.edges.map(edgeIdentity).join("|");
}

export function describeJoinPath(path: JoinPath): string {
  if (path.edges.length === 0) return "(same table)";
  const tables = [path.edges[0]!.fromTable, ...path.edges.map((e) => e.toTable)];
  const keys = path.edges
    .map((e) => `${e.fromTable}.${e.fromColumn} → ${e.toTable}.${e.toColumn}`)
    .join(", ");
  return `${tables.join(" → ")} (${keys})`;
}

export function ambiguousRelationshipMessage(
  from: string,
  to: string,
  alternatives: string[] | undefined,
): string {
  const listed = (alternatives ?? []).join("; ");
  return (
    `multiple relationship paths from "${from}" to "${to}"` +
    (listed ? ` (${listed})` : "") +
    `. YAML declaration order is not a semantic discriminator — guessing a path would silently change the numbers.`
  );
}

export class RelationshipGraph {
  private readonly edgesByTable = new Map<string, Edge[]>();

  constructor(relationships: Record<string, RelationshipConfig>) {
    for (const [name, rel] of Object.entries(relationships)) {
      const from = parseColumnRef(rel.from);
      const to = parseColumnRef(rel.to);
      if (!from || !to) {
        throw configError(
          `Relationship "${name}" must use table.column references (got from: "${rel.from}", to: "${rel.to}").`,
        );
      }
      this.addEdge({
        relationship: name,
        fromTable: from.table,
        fromColumn: from.column,
        toTable: to.table,
        toColumn: to.column,
        cardinality: rel.type,
      });
      this.addEdge({
        relationship: name,
        fromTable: to.table,
        fromColumn: to.column,
        toTable: from.table,
        toColumn: from.column,
        cardinality: invert(rel.type),
      });
    }
  }

  private addEdge(edge: Edge): void {
    const list = this.edgesByTable.get(edge.fromTable) ?? [];
    list.push(edge);
    this.edgesByTable.set(edge.fromTable, list);
  }

  edgesFrom(table: string): Edge[] {
    return this.edgesByTable.get(table) ?? [];
  }

  /**
   * Find a join path between two tables.
   *
   * Fan-out-free paths are preferred. If two or more safe paths exist, the
   * result is marked `ambiguous` — callers must not guess. A fanning path is
   * returned only when no safe path exists. If two or more fanning paths
   * exist, the result is also `ambiguous`: pre-aggregation still needs one
   * authoritative route, and YAML/BFS order is not one.
   */
  findPath(fromTable: string, toTable: string): JoinPath | null {
    if (fromTable === toTable) return { edges: [], fansOut: false };
    const safe = this.collectSimplePaths(fromTable, toTable, { allowFanOut: false, limit: 8, maxDepth: 8 });
    if (safe.length > 1) return this.markAmbiguous(safe);
    if (safe.length === 1) return safe[0]!;

    const reachable = this.collectSimplePaths(fromTable, toTable, { allowFanOut: true, limit: 8, maxDepth: 16 });
    const deepSafe = reachable.filter((path) => !path.fansOut);
    if (deepSafe.length > 1) return this.markAmbiguous(deepSafe);
    if (deepSafe.length === 1) return deepSafe[0]!;
    const fanning = reachable.filter((path) => path.fansOut);
    if (fanning.length > 1) return this.markAmbiguous(fanning);
    if (fanning.length === 1) return fanning[0]!;
    return this.bfs(fromTable, toTable, false);
  }

  /**
   * Enumerate simple fan-out-free paths, stopping after `limit` matches or
   * `maxDepth` hops. Used to detect ambiguity without walking the full graph.
   */
  collectSafePaths(fromTable: string, toTable: string, limit = 8, maxDepth = 8): JoinPath[] {
    return this.collectSimplePaths(fromTable, toTable, { allowFanOut: false, limit, maxDepth });
  }

  private markAmbiguous(paths: JoinPath[]): JoinPath {
    const first = paths[0]!;
    return {
      edges: first.edges,
      fansOut: first.fansOut,
      ambiguous: true,
      alternatives: paths.map(describeJoinPath),
    };
  }

  /**
   * Cycle-free paths. `allowFanOut` includes one_to_many hops (needed for
   * pre-aggregated measure routes). Path identity is the edge sequence, not
   * merely the endpoints.
   */
  private collectSimplePaths(
    fromTable: string,
    toTable: string,
    opts: { allowFanOut: boolean; limit: number; maxDepth: number },
  ): JoinPath[] {
    if (fromTable === toTable) return [{ edges: [], fansOut: false }];
    const found: JoinPath[] = [];
    const visit = (table: string, edges: Edge[], visited: Set<string>): void => {
      if (found.length >= opts.limit) return;
      if (edges.length >= opts.maxDepth) return;
      for (const edge of this.edgesFrom(table)) {
        if (!opts.allowFanOut && edge.cardinality === "one_to_many") continue;
        if (visited.has(edge.toTable)) continue;
        const next = [...edges, edge];
        if (edge.toTable === toTable) {
          found.push({
            edges: next,
            fansOut: next.some((e) => e.cardinality === "one_to_many"),
          });
          if (found.length >= opts.limit) return;
          continue;
        }
        visited.add(edge.toTable);
        visit(edge.toTable, next, visited);
        visited.delete(edge.toTable);
        if (found.length >= opts.limit) return;
      }
    };
    visit(fromTable, [], new Set([fromTable]));
    return found;
  }

  private bfs(fromTable: string, toTable: string, safeOnly: boolean): JoinPath | null {
    const visited = new Set<string>([fromTable]);
    const queue: { table: string; edges: Edge[] }[] = [{ table: fromTable, edges: [] }];
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const edge of this.edgesFrom(current.table)) {
        if (safeOnly && edge.cardinality === "one_to_many") continue;
        if (visited.has(edge.toTable)) continue;
        const edges = [...current.edges, edge];
        if (edge.toTable === toTable) {
          return { edges, fansOut: edges.some((e) => e.cardinality === "one_to_many") };
        }
        visited.add(edge.toTable);
        queue.push({ table: edge.toTable, edges });
      }
    }
    return null;
  }
}

export type { ColumnRef };
