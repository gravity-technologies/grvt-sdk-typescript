// A redirect must stop before credentials or a write can reach its target: following it would send a second
// request, which can carry the session cookie elsewhere or replay a signed write.

import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { FetchTransport } from "../src/index.js";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((done) => s.close(done))));
});

async function serve(
  handler: (req: IncomingMessage, body: string) => [number, Record<string, string>],
) {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const [status, headers] = handler(req, body);
      res.writeHead(status, headers).end();
    });
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe.each([301, 302, 303, 307, 308])("HTTP %i", (status) => {
  it.each([false, true])(
    "the default transport never follows it (cross origin: %s)",
    async (crossOrigin) => {
      const reached: string[] = [];
      const target = await serve((req) => {
        reached.push(`${req.method} ${req.url}`);
        return [200, {}];
      });
      const origin = await serve((req, body) => {
        if (req.url === "/target") {
          reached.push(`${req.method} ${req.url} ${body}`);
          return [200, {}];
        }
        return [status, { location: crossOrigin ? `${target}/target` : "/target" }];
      });
      const http = new FetchTransport();
      const post = await http.post(
        `${origin}/full/v1/create_order`,
        '{"signed":true}',
        { cookie: "gravity=s" },
        5000,
      );
      const get = await http.get(`${origin}/full/v1/ticker`, 5000);
      // The SDK sees the redirect itself: a status outside 4xx, so a write's outcome is unknown and a read fails.
      expect([post.status, get.status]).toEqual([status, status]);
      expect(reached).toEqual([]);
    },
  );
});
