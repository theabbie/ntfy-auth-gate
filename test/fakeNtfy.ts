import http from "node:http";
import type { AddressInfo } from "node:net";

export interface PublishedAction {
  label: string;
  url: string;
  method: string;
  body: string;
  headers?: Record<string, string>;
}

export interface PublishedMessage {
  topic: string;
  title: string;
  message: string;
  priority: number;
  actions: PublishedAction[];
  authorization: string | undefined;
}

export interface FakeNtfy {
  url: string;
  published: PublishedMessage[];
  subscribeAuthorizations: (string | undefined)[];
  state: { failPublish: boolean; failSubscribe: boolean };
  waitForPublished(count: number): Promise<PublishedMessage>;
  tap(index: number, label: string): Promise<void>;
  post(url: string, body: string): Promise<void>;
  close(): Promise<void>;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

export async function startFakeNtfy(): Promise<FakeNtfy> {
  const published: PublishedMessage[] = [];
  const subscribeAuthorizations: (string | undefined)[] = [];
  const subscribers = new Map<string, Set<http.ServerResponse>>();
  const cache = new Map<string, string[]>();
  const state = { failPublish: false, failSubscribe: false };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const authorization = req.headers.authorization;

    if (req.method === "POST" && url.pathname === "/") {
      const payload = JSON.parse(await readBody(req));
      if (state.failPublish) {
        res.statusCode = 500;
        return void res.end("{}");
      }
      published.push({ ...payload, authorization });
      return void res.end("{}");
    }

    if (req.method === "GET" && url.pathname.endsWith("/json")) {
      subscribeAuthorizations.push(authorization);
      if (state.failSubscribe) {
        res.statusCode = 500;
        return void res.end("{}");
      }
      const topic = url.pathname.slice(1, -"/json".length);
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      res.write(`${JSON.stringify({ event: "open", topic })}\n`);
      for (const message of cache.get(topic) ?? []) {
        res.write(`${JSON.stringify({ event: "message", topic, message })}\n`);
      }
      const set = subscribers.get(topic) ?? new Set();
      set.add(res);
      subscribers.set(topic, set);
      res.on("close", () => set.delete(res));
      return;
    }

    if (req.method === "POST") {
      const topic = url.pathname.slice(1);
      const message = await readBody(req);
      cache.set(topic, [...(cache.get(topic) ?? []), message]);
      for (const subscriber of subscribers.get(topic) ?? []) {
        subscriber.write(`${JSON.stringify({ event: "message", topic, message })}\n`);
      }
      return void res.end("{}");
    }

    res.statusCode = 404;
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  const post = async (url: string, body: string) => {
    await fetch(url, { method: "POST", body });
  };

  return {
    url: `http://127.0.0.1:${port}`,
    published,
    subscribeAuthorizations,
    state,
    async waitForPublished(count) {
      const deadline = Date.now() + 3000;
      while (published.length < count) {
        if (Date.now() > deadline) throw new Error("timed out waiting for publish");
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      return published[count - 1] as PublishedMessage;
    },
    async tap(index, label) {
      const action = published[index]?.actions.find((candidate) => candidate.label === label);
      if (!action) throw new Error(`no action ${label}`);
      await post(action.url, action.body);
    },
    post,
    close() {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
