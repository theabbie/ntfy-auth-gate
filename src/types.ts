import type { IncomingMessage, ServerResponse } from "node:http";

export type DecisionReason = "approved" | "denied" | "timeout" | "aborted";

export interface Decision {
  approved: boolean;
  reason: DecisionReason;
}

export interface Prompt {
  title: string;
  message: string;
  tags?: string[];
  click?: string;
}

export interface GateSubject {
  method: string;
  url: string;
  ip?: string;
  userAgent?: string;
}

export interface GateOptions {
  topic: string;
  server?: string;
  token?: string;
  actionHeaders?: Record<string, string>;
  timeoutMs?: number;
  maxPending?: number;
  priority?: 1 | 2 | 3 | 4 | 5;
  describe?: (subject: GateSubject) => Prompt;
  fetch?: typeof fetch;
}

export interface ResolvedConfig {
  topic: string;
  server: string;
  token: string | undefined;
  actionHeaders: Record<string, string> | undefined;
  timeoutMs: number;
  maxPending: number;
  priority: number;
  fetch: typeof fetch;
}

export type NextFunction = (error?: unknown) => void;

export type GateMiddleware = (
  req: IncomingMessage,
  res: ServerResponse,
  next: NextFunction,
) => Promise<void>;

export type NodeHandler = (
  req: IncomingMessage,
  res: ServerResponse,
) => void | Promise<void>;

export type FetchHandler<Args extends unknown[]> = (
  request: Request,
  ...args: Args
) => Response | Promise<Response>;

export type ApproveSubject = (
  subject: GateSubject,
  signal?: AbortSignal,
) => Promise<Decision>;

export interface Gate {
  approve(prompt: Prompt, signal?: AbortSignal): Promise<Decision>;
  middleware: GateMiddleware;
  wrap(handler: NodeHandler): NodeHandler;
  guardFetch<Args extends unknown[]>(
    handler: FetchHandler<Args>,
  ): (request: Request, ...args: Args) => Promise<Response>;
  readonly pending: number;
}
