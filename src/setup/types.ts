export type SetupPath = "demo" | "own" | "import";

export interface SetupIo {
  log: (line: string) => void;
  error: (line: string) => void;
}
