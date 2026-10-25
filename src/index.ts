import { createCore } from "./core";
import { defaultDescribe } from "./describe";
import { guardFetchHandler } from "./fetch";
import { createMiddleware, wrapHandler } from "./http";
import type { ApproveSubject, Gate, GateOptions, ResolvedConfig } from "./types";

const defaultServer = "https://ntfy.sh";
const defaultTimeoutMs = 60_000;
const defaultMaxPending = 3;
const defaultPriority = 4;
const maxTopicLength = 40;

function resolveConfig(options: GateOptions): ResolvedConfig {
  const { topic } = options;
  if (typeof topic !== "string" || !/^[A-Za-z0-9_-]+$/.test(topic) || topic.length > maxTopicLength) {
    throw new TypeError(
      `topic must be 1 to ${maxTopicLength} characters of letters, digits, dash or underscore`,
    );
  }
  const server = new URL(options.server ?? defaultServer).toString().replace(/\/+$/, "");
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
  const maxPending = options.maxPending ?? defaultMaxPending;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("timeoutMs must be a positive number");
  }
  if (!Number.isInteger(maxPending) || maxPending < 1) {
    throw new TypeError("maxPending must be a positive integer");
  }
  return {
    topic,
    server,
    token: options.token,
    actionHeaders: options.actionHeaders,
    timeoutMs,
    maxPending,
    priority: options.priority ?? defaultPriority,
    fetch: options.fetch ?? globalThis.fetch,
  };
}

export function createGate(options: GateOptions): Gate {
  const core = createCore(resolveConfig(options));
  const describe = options.describe ?? defaultDescribe;
  const approveSubject: ApproveSubject = (subject, signal) =>
    core.approve(describe(subject), signal);
  const middleware = createMiddleware(approveSubject);

  return {
    approve: core.approve,
    middleware,
    wrap: (handler) => wrapHandler(middleware, handler),
    guardFetch: (handler) => guardFetchHandler(approveSubject, handler),
    get pending() {
      return core.pending;
    },
  };
}

export { GateError } from "./errors";
export type { GateErrorCode } from "./errors";
export { defaultDescribe } from "./describe";
export type {
  Decision,
  DecisionReason,
  FetchHandler,
  Gate,
  GateMiddleware,
  GateOptions,
  GateSubject,
  NextFunction,
  NodeHandler,
  Prompt,
} from "./types";
