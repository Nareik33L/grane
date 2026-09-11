/**
 * Isolated certification namespace. Every `grane certify` run (and the
 * shared corpus adapters) create and drop their own `grane_cert_<runid>`
 * schema / database / dataset. Adopter tables are never used as the seed
 * target.
 */
export function newCertifySchemaName(): string {
  const runid = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  return `grane_cert_${runid}`;
}

export function isCertifySchemaName(name: string): boolean {
  return /^grane_cert_[a-z0-9]+_[a-z0-9]+$/i.test(name);
}
