import type { CertCapabilities, CertEngine } from "../cert-engine.js";

export const CLICKHOUSE_CERT_CAPABILITIES: CertCapabilities = {
  readOnlyTransaction: true,
  timestamptz: false,
  fkIntrospection: false,
  postgresReadonlyRole: false,
  mutateSeed: true,
  sessionTimezoneLocal: false,
  mcpCli: false,
  filterClause: false,
};

/** Stub until workstream 4 (ClickHouse CI service). `available()` is false unless GRANE_CLICKHOUSE_URL is set. */
export const clickhouseCertEngine: CertEngine = {
  type: "clickhouse",
  capabilities: CLICKHOUSE_CERT_CAPABILITIES,
  async available() {
    // Workstream 4 wires GRANE_CLICKHOUSE_URL and a real setup(); keep false here
    // so leftover env cannot enroll a stub into describe.each.
    return false;
  },
  async setup() {
    throw new Error("ClickHouse certification adapter is a stub until workstream 4");
  },
};
