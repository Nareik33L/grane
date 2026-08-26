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
 * When two or more fan-out-free paths reach the same table, Grane refuses
 * rather than BFS-picking one. Guessing a path silently changes the numbers.
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
   * True when two or more fan-out-free paths exist. Callers must refuse
   * rather than use `edges` as a guess.
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

export function describeJoinPath(path: JoinPath): string {
  if (path.edges.length === 0) return "(same table)";
  const tables = [path.edges[0]!.fromTable, ...path.edges.map((e) => e.toTable)];
  return tables.join(" → ");
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
   * returned only when no safe path exists (callers decide whether
   * pre-aggregation applies).
   */
  findPath(fromTable: string, toTable: string): JoinPath | null {
    if (fromTable === toTable) return { edges: [], fansOut: false };
    const safe = this.collectSafePaths(fromTable, toTable, 8, 8);
    if (safe.length > 1) {
      return {
        edges: safe[0]!.edges,
        fansOut: false,
        ambiguous: true,
        alternatives: safe.map(describeJoinPath),
      };
    }
    if (safe.length === 1) return safe[0]!;
    return this.bfs(fromTable, toTable, false);
  }

  /**
   * Enumerate simple fan-out-free paths, stopping after `limit` matches or
   * `maxDepth` hops. Used to detect ambiguity without walking the full graph.
   */
  collectSafePaths(fromTable: string, toTable: string, limit = 8, maxDepth = 8): JoinPath[] {
    if (fromTable === toTable) return [{ edges: [], fansOut: false }];
    const found: JoinPath[] = [];
    const visit = (table: string, edges: Edge[], visited: Set<string>): void => {
      if (found.length >= limit) return;
      if (edges.length >= maxDepth) return;
      for (const edge of this.edgesFrom(table)) {
        if (edge.cardinality === "one_to_many") continue;
        if (visited.has(edge.toTable)) continue;
        const next = [...edges, edge];
        if (edge.toTable === toTable) {
          found.push({ edges: next, fansOut: false });
          if (found.length >= limit) return;
          continue;
        }
        visited.add(edge.toTable);
        visit(edge.toTable, next, visited);
        visited.delete(edge.toTable);
        if (found.length >= limit) return;
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
