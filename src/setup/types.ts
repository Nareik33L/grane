export type SetupPath = "demo" | "own";

export interface SetupIo {
  log: (line: string) => void;
  error: (line: string) => void;
}
