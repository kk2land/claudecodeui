/**
 * Server-local shared contracts. Pure plugin contracts come from `shared/contracts.ts`; only
 * runtime-facing helper shapes are declared here so server modules never duplicate the public API.
 */
export type * from "../../shared/contracts.js";
export type * as Contracts from "../../shared/contracts.js";

/** Validated internal error raised by service boundaries; `code` is stable for API responses. */
export class WorkerFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "WorkerFailure";
  }
}

/** Evidence written by the guardian just before it exits. */
export type GuardianEvidence = {
  reason: "exit" | "timeout" | "cancelled" | "disconnect" | "error";
  exitCode: number | null;
  signal: string | null;
  startedAt: string | null;
  finishedAt: string;
  groupExited: boolean;
  error: string | null;
};

/** Result of one native protocol parse. Invalid protocol always yields `success:false`. */
export type NativeExecution = {
  success: boolean;
  nativeSessionId: string | null;
  nativeSessionFile: string | null;
  finalText: string | null;
  usage: import("../../shared/contracts.js").WorkerUsage | null;
  error: string | null;
};

/** Everything needed to launch one guardian-wrapped native invocation. */
export type NativeLaunch = {
  argv: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  prompt: string;
  /** Known before the run starts (Pi session file) or null when the runner assigns identity. */
  expectedSessionId: string | null;
  sessionFile: string | null;
};

export type StreamName = "events" | "stderr";
