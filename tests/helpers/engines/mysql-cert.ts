import type { CertCapabilities, CertEngine } from "../cert-engine.js";

export const MYSQL_CERT_CAPABILITIES: CertCapabilities = {
  readOnlyTransaction: true,
  timestamptz: false,
  fkIntrospection: true,
  postgresReadonlyRole: false,
  mutateSeed: true,
  sessionTimezoneLocal: false,
  mcpCli: false,
};

/** Stub until workstream 3 (MySQL 8 CI service). `available()` is false unless GRANE_MYSQL_URL is set. */
export const mysqlCertEngine: CertEngine = {
  type: "mysql",
  capabilities: MYSQL_CERT_CAPABILITIES,
  async available() {
    // Workstream 3 wires GRANE_MYSQL_URL and a real setup(); keep false here so
    // leftover env cannot enroll a stub into describe.each.
    return false;
  },
  async setup() {
    throw new Error("MySQL certification adapter is a stub until workstream 3");
  },
};
