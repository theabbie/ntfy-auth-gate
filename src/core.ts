import { randomBytes } from "node:crypto";
import { GateError } from "./errors";
import { createNtfyClient } from "./ntfy";
import type { Decision, DecisionReason, Prompt, ResolvedConfig } from "./types";

export interface Core {
  approve(prompt: Prompt, signal?: AbortSignal): Promise<Decision>;
  readonly pending: number;
}

export function createCore(config: ResolvedConfig): Core {
  const client = createNtfyClient({
    server: config.server,
    token: config.token,
    fetch: config.fetch,
  });
  let pending = 0;

  const approve = async (prompt: Prompt, signal?: AbortSignal): Promise<Decision> => {
    if (pending >= config.maxPending) {
      throw new GateError("tooManyPending", "too many pending approvals");
    }
    pending += 1;

    const controller = new AbortController();
    let stopReason: DecisionReason | undefined;
    const stop = (reason: DecisionReason) => {
      stopReason ??= reason;
      controller.abort();
    };
    const timer = setTimeout(() => stop("timeout"), config.timeoutMs);
    const onAbort = () => stop("aborted");
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });

    try {
      const responseTopic = `${config.topic}-${randomBytes(16).toString("base64url")}`;
      const responseUrl = `${config.server}/${responseTopic}`;
      const messages = await client.subscribe(responseTopic, controller.signal);
      await client.publish({
        topic: config.topic,
        prompt,
        priority: config.priority,
        actions: [
          { label: "Approve", url: responseUrl, body: "approve", headers: config.actionHeaders },
          { label: "Deny", url: responseUrl, body: "deny", headers: config.actionHeaders },
        ],
      });
      for await (const body of messages) {
        const answer = body.trim().toLowerCase();
        if (answer === "approve") return { approved: true, reason: "approved" };
        if (answer === "deny") return { approved: false, reason: "denied" };
      }
      return { approved: false, reason: stopReason ?? "aborted" };
    } catch (error) {
      if (stopReason) return { approved: false, reason: stopReason };
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      controller.abort();
      pending -= 1;
    }
  };

  return {
    approve,
    get pending() {
      return pending;
    },
  };
}
