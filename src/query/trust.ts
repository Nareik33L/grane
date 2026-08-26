import type { TrustLevel } from "./model.js";

/** One-line lead shown first on every query/explain/validate result. */
export const TRUST_HEADLINES: Record<TrustLevel, string> = {
  governed: "trust: governed — every field is an approved definition.",
  mixed: "trust: mixed — approved metrics plus raw fields; a lead, not approved truth.",
  exploratory: "trust: exploratory — warehouse data only; not governed analytics.",
};

export function trustHeadline(trust: TrustLevel): string {
  return TRUST_HEADLINES[trust];
}

/** JSON object with `trust` and `headline` first so agents see them before rows. */
export function payloadWithTrustFirst<T extends { trust: TrustLevel }>(
  payload: T,
): T & { headline: string } {
  const { trust, ...rest } = payload;
  return { trust, headline: trustHeadline(trust), ...rest } as T & { headline: string };
}

/** MCP tool text: headline, then JSON. */
export function mcpTrustText(payload: { trust: TrustLevel; [key: string]: unknown }): string {
  const ordered = payloadWithTrustFirst(payload);
  return `${ordered.headline}\n\n${JSON.stringify(ordered, null, 2)}`;
}
