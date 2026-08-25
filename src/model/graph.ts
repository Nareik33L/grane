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
}

function invert(cardinality: Cardinality): Cardinality {
  if (cardinality === "many_to_one") return "one_to_many";
  if (cardinality === "one_to_many") return "many_to_one";
  return "one_to_one";
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
   * Find the shortest join path between two tables via BFS.
   * Fan-out-free paths are preferred; a fanning path is returned only when no
   * safe path exists (callers decide whether pre-aggregation applies).
   */
  findPath(fromTable: string, toTable: string): JoinPath | null {
    if (fromTable === toTable) return { edges: [], fansOut: false };
    const safe = this.bfs(fromTable, toTable, true);
    if (safe) return safe;
    return this.bfs(fromTable, toTable, false);
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
