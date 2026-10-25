import type { IncomingMessage, ServerResponse } from "node:http";
import { GateError, rejectionFor } from "./errors";
import type { Rejection } from "./errors";
import type {
  ApproveSubject,
  Decision,
  GateMiddleware,
  GateSubject,
  NodeHandler,
} from "./types";

export function subjectFromRequest(req: IncomingMessage): GateSubject {
  const { originalUrl, ip } = req as IncomingMessage & { originalUrl?: string; ip?: string };
  const userAgent = req.headers["user-agent"];
  const subject: GateSubject = {
    method: req.method ?? "GET",
    url: originalUrl ?? req.url ?? "/",
  };
  const address = ip ?? req.socket.remoteAddress;
  if (address) subject.ip = address;
  if (userAgent) subject.userAgent = Array.isArray(userAgent) ? userAgent.join(", ") : userAgent;
  return subject;
}

function sendRejection(res: ServerResponse, rejection: Rejection): void {
  if (res.headersSent || res.writableEnded) return;
  res.statusCode = rejection.status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ error: rejection.error }));
}

export function createMiddleware(approveSubject: ApproveSubject): GateMiddleware {
  return async (req, res, next) => {
    const controller = new AbortController();
    const onClose = () => {
      if (!res.writableEnded) controller.abort();
    };
    res.once("close", onClose);

    let decision: Decision;
    try {
      decision = await approveSubject(subjectFromRequest(req), controller.signal);
    } catch (error) {
      res.off("close", onClose);
      if (error instanceof GateError) return sendRejection(res, rejectionFor(error));
      return next(error);
    }
    res.off("close", onClose);

    if (decision.approved) return next();
    if (decision.reason === "aborted") return;
    sendRejection(res, rejectionFor(decision));
  };
}

export function wrapHandler(middleware: GateMiddleware, handler: NodeHandler): NodeHandler {
  return (req, res) =>
    middleware(req, res, (error) => {
      if (error) return sendRejection(res, { status: 500, error: "internal" });
      return void handler(req, res);
    });
}
