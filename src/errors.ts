import type { Decision } from "./types";

export type GateErrorCode = "publishFailed" | "subscribeFailed" | "tooManyPending";

export class GateError extends Error {
  readonly code: GateErrorCode;

  constructor(code: GateErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "GateError";
    this.code = code;
  }
}

export interface Rejection {
  status: number;
  error: string;
}

export function rejectionFor(outcome: Decision | GateError): Rejection {
  if (outcome instanceof GateError) {
    return outcome.code === "tooManyPending"
      ? { status: 429, error: "tooManyPending" }
      : { status: 502, error: "unavailable" };
  }
  return outcome.reason === "timeout"
    ? { status: 408, error: "timeout" }
    : { status: 403, error: "denied" };
}
