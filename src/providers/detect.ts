import { basename, extname, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { asArray, isDir, isFile, isRecord, readText, str, walkFiles, walkYamlFiles } from "./helpers.js";

export type ConnectorKind = "dbt" | "cube" | "lookml" | "ossie" | "fragment" | "malloy";

export const CONNECTOR_KINDS: ConnectorKind[] = ["dbt", "cube", "lookml", "ossie", "fragment", "malloy"];

function yamlDoc(path: string): unknown {
  try {
    return parseYaml(readText(path));
  } catch {
    return undefined;
  }
}

function looksOssie(doc: unknown): boolean {
  if (!isRecord(doc)) return false;
  const models = asArray(doc.semantic_model ?? doc.semantic_models);
  const single = isRecord(doc.semantic_model) ? [doc.semantic_model] : models;
  return single.some((model) => isRecord(model) && Array.isArray(model.datasets));
}

function looksDbtYaml(doc: unknown): boolean {
  if (!isRecord(doc)) return false;
  if (asArray(doc.semantic_models).length > 0) return true;
  return asArray(doc.models).some(
    (model) => isRecord(model) && model.semantic_model !== undefined,
  );
}

function looksCube(doc: unknown): boolean {
  return isRecord(doc) && asArray(doc.cubes).length > 0;
}

function isNamedMap(value: unknown): boolean {
  return isRecord(value) && Object.keys(value).length > 0;
}

function looksFragment(doc: unknown): boolean {
  if (!isRecord(doc)) return false;
  return (
    isNamedMap(doc.metrics) ||
    isNamedMap(doc.entities) ||
    isNamedMap(doc.dimensions) ||
    isNamedMap(doc.relationships)
  );
}

/**
 * Sniff a file or directory for semantic modelling systems Grane can read.
 * A path may match more than one kind (e.g. a monorepo); auto-load merges them.
 */
export function detectConnectorKinds(root: string): ConnectorKind[] {
  const kinds = new Set<ConnectorKind>();
  if (isFile(root)) {
    const name = basename(root).toLowerCase();
    const ext = extname(root).toLowerCase();
    if (name === "semantic_manifest.json" || name === "dbt_project.yml" || name === "dbt_project.yaml") {
      kinds.add("dbt");
    }
    if (name.includes("ossie") || name === "osi_document.json" || name.endsWith(".ossie.yaml") || name.endsWith(".ossie.yml")) {
      kinds.add("ossie");
    }
    if (ext === ".lkml" || ext === ".lookml") kinds.add("lookml");
    if (ext === ".malloy") kinds.add("malloy");
    if (/\.ya?ml$/i.test(name) || name.endsWith(".json")) {
      try {
        const doc = name.endsWith(".json") ? JSON.parse(readText(root)) : yamlDoc(root);
        if (looksOssie(doc)) kinds.add("ossie");
        if (looksDbtYaml(doc)) kinds.add("dbt");
        if (looksCube(doc)) kinds.add("cube");
        if (looksFragment(doc) && !looksDbtYaml(doc) && !looksCube(doc) && !looksOssie(doc)) {
          kinds.add("fragment");
        }
      } catch {
        // Sniffing must not fail load; the chosen parser reports real errors.
      }
    }
    return [...kinds];
  }
  if (!isDir(root)) return [];

  if (isFile(join(root, "dbt_project.yml")) || isFile(join(root, "dbt_project.yaml"))) kinds.add("dbt");
  if (isFile(join(root, "target", "semantic_manifest.json"))) kinds.add("dbt");
  if (isFile(join(root, "cube.js")) || isFile(join(root, "cube.py"))) kinds.add("cube");

  for (const file of walkYamlFiles(root)) {
    const doc = yamlDoc(file);
    if (looksOssie(doc)) kinds.add("ossie");
    if (looksDbtYaml(doc)) kinds.add("dbt");
    if (looksCube(doc)) kinds.add("cube");
    if (looksFragment(doc) && !looksDbtYaml(doc) && !looksCube(doc) && !looksOssie(doc)) {
      kinds.add("fragment");
    }
  }
  for (const file of walkFiles(root, (name) => /\.(lkml|lookml)$/i.test(name))) {
    void file;
    kinds.add("lookml");
    break;
  }
  for (const file of walkFiles(root, (name) => /\.malloy$/i.test(name))) {
    void file;
    kinds.add("malloy");
    break;
  }
  for (const file of walkFiles(root, (name) => /ossie|osi_document/i.test(name))) {
    void file;
    kinds.add("ossie");
    break;
  }
  return [...kinds];
}
