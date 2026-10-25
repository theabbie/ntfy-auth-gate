import { GateError } from "./errors";
import type { Prompt } from "./types";

const reconnectDelayMs = 1000;

interface NtfyEvent {
  event: string;
  message?: string;
}

export interface NtfyAction {
  label: string;
  url: string;
  body: string;
  headers?: Record<string, string> | undefined;
}

export interface PublishInput {
  topic: string;
  prompt: Prompt;
  priority: number;
  actions: NtfyAction[];
}

export interface NtfyClient {
  publish(input: PublishInput): Promise<void>;
  subscribe(topic: string, signal: AbortSignal): Promise<AsyncGenerator<string, void>>;
}

export interface NtfyClientOptions {
  server: string;
  token: string | undefined;
  fetch: typeof fetch;
}

function parseEvent(line: string): NtfyEvent | undefined {
  try {
    const parsed: unknown = JSON.parse(line);
    if (parsed && typeof parsed === "object" && typeof (parsed as NtfyEvent).event === "string") {
      return parsed as NtfyEvent;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

async function* readEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<NtfyEvent, void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const event = parseEvent(buffer.slice(0, newline).trim());
        buffer = buffer.slice(newline + 1);
        if (event) yield event;
        newline = buffer.indexOf("\n");
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

async function* noEvents(): AsyncGenerator<NtfyEvent, void> {}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

export function createNtfyClient({ server, token, fetch: fetchImpl }: NtfyClientOptions): NtfyClient {
  const authHeaders = (): Record<string, string> =>
    token ? { authorization: `Bearer ${token}` } : {};

  const connect = async (topic: string, signal: AbortSignal) => {
    const response = await fetchImpl(`${server}/${topic}/json?since=all`, {
      headers: authHeaders(),
      signal,
    });
    if (!response.ok || !response.body) {
      throw new GateError("subscribeFailed", `ntfy subscribe failed with status ${response.status}`);
    }
    return readEvents(response.body);
  };

  const awaitOpen = async (events: AsyncGenerator<NtfyEvent, void>): Promise<string[]> => {
    const early: string[] = [];
    for (;;) {
      const { done, value } = await events.next();
      if (done) throw new GateError("subscribeFailed", "ntfy stream closed before opening");
      if (value.event === "open") return early;
      if (value.event === "message" && value.message !== undefined) early.push(value.message);
    }
  };

  return {
    async publish({ topic, prompt, priority, actions }) {
      const payload = {
        topic,
        title: prompt.title,
        message: prompt.message,
        priority,
        tags: prompt.tags,
        click: prompt.click,
        actions: actions.map((action) => ({
          action: "http",
          label: action.label,
          url: action.url,
          method: "POST",
          body: action.body,
          headers: action.headers,
          clear: true,
        })),
      };
      let response: Response;
      try {
        response = await fetchImpl(server, {
          method: "POST",
          headers: { ...authHeaders(), "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
      } catch (error) {
        throw new GateError("publishFailed", "ntfy publish request failed", error);
      }
      if (!response.ok) {
        throw new GateError("publishFailed", `ntfy publish failed with status ${response.status}`);
      }
    },

    async subscribe(topic, signal) {
      let first: AsyncGenerator<NtfyEvent, void>;
      let early: string[];
      try {
        first = await connect(topic, signal);
        early = await awaitOpen(first);
      } catch (error) {
        if (error instanceof GateError) throw error;
        throw new GateError("subscribeFailed", "ntfy subscribe request failed", error);
      }

      async function* messages(): AsyncGenerator<string, void> {
        yield* early;
        let current = first;
        for (;;) {
          try {
            for await (const event of current) {
              if (event.event === "message" && event.message !== undefined) yield event.message;
            }
          } catch {
            if (signal.aborted) return;
          }
          if (signal.aborted) return;
          await sleep(reconnectDelayMs, signal);
          if (signal.aborted) return;
          current = await connect(topic, signal).catch(() => noEvents());
        }
      }

      return messages();
    },
  };
}
