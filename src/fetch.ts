import { GateError, rejectionFor } from "./errors";
import type { Rejection } from "./errors";
import type { ApproveSubject, FetchHandler, GateSubject } from "./types";

function subjectFromFetchRequest(request: Request): GateSubject {
  const { pathname, search } = new URL(request.url);
  const subject: GateSubject = { method: request.method, url: `${pathname}${search}` };
  const userAgent = request.headers.get("user-agent");
  if (userAgent) subject.userAgent = userAgent;
  return subject;
}

function respond(rejection: Rejection): Response {
  return new Response(JSON.stringify({ error: rejection.error }), {
    status: rejection.status,
    headers: { "content-type": "application/json" },
  });
}

export function guardFetchHandler<Args extends unknown[]>(
  approveSubject: ApproveSubject,
  handler: FetchHandler<Args>,
): (request: Request, ...args: Args) => Promise<Response> {
  return async (request, ...args) => {
    try {
      const decision = await approveSubject(subjectFromFetchRequest(request), request.signal);
      if (decision.approved) return await handler(request, ...args);
      if (decision.reason === "aborted") return new Response(null, { status: 499 });
      return respond(rejectionFor(decision));
    } catch (error) {
      if (error instanceof GateError) return respond(rejectionFor(error));
      throw error;
    }
  };
}
