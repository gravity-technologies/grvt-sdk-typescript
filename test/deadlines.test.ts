import { afterEach, expect, it, vi } from "vitest";
import { Backoff, ConfigError, Grvt, OrderStateUnknown, TransportError } from "../src/index.js";
import type { HttpResponse } from "../src/runtime/http.js";
import type { RpcSpec } from "../src/runtime/spec.js";
import { FakeGateway, FakeHttp, FULL, waitUntil } from "./fakes.js";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const write: RpcSpec = {
  id: "test",
  method: "v1/create_order",
  gateway: "td",
  path: "/full/v1/create_order",
  auth: false,
  write: true,
  orderEntry: true,
  required: [],
  clientOrderId: "order",
};
const read: RpcSpec = {
  ...write,
  method: "v1/instrument",
  path: "/full/v1/instrument",
  write: false,
  clientOrderId: false,
};
const request = () => ({ order: { sub_account_id: "1", metadata: { client_order_id: "42" } } });
const clients: Grvt[] = [];
function client(options: ConstructorParameters<typeof Grvt>[0] = {}) {
  const c = new Grvt({ ...FULL, ...options });
  clients.push(c);
  return c;
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(clients.splice(0).map((c) => c.close()));
});

class DelayedHttp extends FakeHttp {
  loginDelay = 0;
  blockWrites = false;
  sent = false;
  aborted = false;
  override async post(
    url: string,
    body: string,
    headers: Record<string, string>,
    _timeout?: number,
    signal?: AbortSignal,
  ): Promise<HttpResponse> {
    if (url.endsWith("login")) await sleep(this.loginDelay);
    const reply = super.post(url, body, headers);
    if (this.blockWrites && url.endsWith("create_order")) {
      this.sent = true;
      await new Promise<void>((_, reject) =>
        signal?.addEventListener(
          "abort",
          () => {
            this.aborted = true;
            reject(new TransportError("cancelled", undefined, true, signal.reason));
          },
          { once: true },
        ),
      );
    }
    return reply;
  }
}

it("bounds signing and rejects an expired synchronous hook before any dispatch", async () => {
  const http = new FakeHttp();
  const c = client({ http, callTimeoutMs: 10 });
  await expect(
    c.runtime.call(write, request(), undefined, async (_rt, params) => {
      await sleep(40);
      return params;
    }),
  ).rejects.toMatchObject({ name: "TimeoutError" });
  await sleep(50);
  expect(http.calls).toHaveLength(0);
  const blocked = client({
    http,
    callTimeoutMs: 5,
    beforeSend: () => {
      const end = performance.now() + 15;
      while (performance.now() < end) {
        /* a noncooperative hook */
      }
    },
  });
  await expect(blocked.runtime.call(write, request())).rejects.toMatchObject({
    name: "TimeoutError",
  });
  expect(http.calls).toHaveLength(0);
});

it("detaches a cancelled metadata waiter without failing the surviving caller", async () => {
  const http = new FakeHttp();
  const c = client({ http });
  let loads = 0;
  const sign = async (rt: typeof c.runtime, params: any) => {
    await rt.metadata.mainAccount(async () => {
      loads++;
      await sleep(40);
      return "account";
    });
    return params;
  };
  const first = c.runtime.call(write, request(), { timeoutMs: 10 }, sign);
  const second = c.runtime.call(write, request(), { timeoutMs: 200 }, sign);
  await expect(first).rejects.toMatchObject({ name: "TimeoutError" });
  await second;
  expect(loads).toBe(1);
  expect(http.calls).toHaveLength(1);
});

it("bounds authentication waits without cancelling the shared login", async () => {
  const http = new DelayedHttp();
  http.loginDelay = 40;
  const c = client({ http, apiKey: "k" });
  const first = c.runtime.call({ ...read, auth: true }, {}, { timeoutMs: 10 });
  const second = c.runtime.call({ ...read, auth: true }, {}, { timeoutMs: 200 });
  await expect(first).rejects.toMatchObject({ name: "TimeoutError" });
  await second;
  expect(http.logins).toBe(1);
  expect(http.calls).toHaveLength(2);
});

it("uses one budget across retry backoff", async () => {
  const http = new FakeHttp();
  http.on(read.path, { status: 503, body: '{"code":1002,"message":"busy"}' });
  vi.spyOn(Backoff.prototype, "nextDelayMs").mockReturnValue(100);
  const c = client({ http });
  await expect(c.runtime.call(read, {}, { timeoutMs: 10 })).rejects.toMatchObject({
    name: "TimeoutError",
  });
  expect(http.callsTo(read.path)).toHaveLength(1);
});

it.each([false, true])(
  "retains IDs and the native cause after dispatched HTTP cancellation (caller=%s)",
  async (cancel) => {
    const http = new DelayedHttp();
    http.blockWrites = true;
    const c = client({ http });
    const controller = new AbortController();
    const result = c.runtime
      .call(write, request(), { timeoutMs: 50, signal: controller.signal })
      .catch((error) => error);
    await waitUntil("dispatched", () => http.sent);
    if (cancel) controller.abort(new DOMException("caller cancelled", "AbortError"));
    const error: any = await result;
    expect(error).toBeInstanceOf(OrderStateUnknown);
    expect(error.clientOrderIds).toEqual(["42"]);
    expect(error.cause).toBeInstanceOf(TransportError);
    expect(error.cause.cause.name).toBe(cancel ? "AbortError" : "TimeoutError");
    expect(http.aborted).toBe(true);
    expect(http.callsTo(write.path)).toHaveLength(1);
  },
);

it("cancels a dispatched WebSocket wait and removes its pending entry", async () => {
  const gw = new FakeGateway();
  gw.ignoreRpcs.add(write.method);
  const c = client({
    env: gw.env(),
    webSocket: gw.factory,
    http: new FakeHttp(),
    orderTransport: "ws",
  });
  await c.runtime.call(read, {});
  const result = c.runtime.call(write, request(), { timeoutMs: 50 }).catch((error) => error);
  await waitUntil("dispatched", () => gw.rpcs(write.method).length === 1);
  const error: any = await result;
  expect(error).toBeInstanceOf(OrderStateUnknown);
  expect(error.clientOrderIds).toEqual(["42"]);
  expect((c.runtime.td as any).requests.size).toBe(0);
});

it.each([0, -1, Infinity, NaN])(
  "rejects invalid total and HTTP attempt budgets: %s",
  async (timeout) => {
    expect(() => client({ callTimeoutMs: timeout })).toThrow(ConfigError);
    expect(() => client({ httpAttemptTimeoutMs: timeout })).toThrow(ConfigError);
    const c = client();
    await expect(c.runtime.call(write, request(), { timeoutMs: timeout })).rejects.toThrow(
      ConfigError,
    );
  },
);

it("preserves native cancellation before dispatch and prevents late preparation dispatch", async () => {
  const http = new FakeHttp();
  const c = client({ http });
  const controller = new AbortController();
  const reason = new DOMException("caller cancelled", "AbortError");
  controller.abort(reason);
  await expect(c.runtime.call(write, request(), { signal: controller.signal })).rejects.toBe(
    reason,
  );
  expect(http.calls).toHaveLength(0);
});
