import { Timestamp } from "../src/runtime/scalars.js";
import type { Order } from "../src/generated/models.js";
import { expect, it, vi } from "vitest";
import type { Grvt } from "../src/generated/client.js";
import { resolveOrder } from "../src/recovery.js";
import { ApiError } from "../src/runtime/errors.js";

const orderFor = (account: string): Order => ({
  sub_account_id: account,
  time_in_force: "GOOD_TILL_TIME",
  legs: [],
  metadata: { client_order_id: "2" },
  signature: {
    signer: "0x0",
    r: "0x0",
    s: "0x0",
    v: 27,
    nonce: 1,
    expiration: new Timestamp(0n),
    chain_id: "326",
  },
});

it("keeps a missing or mismatched order unknown and only calls the lookup", async () => {
  const request = { sub_account_id: "1", client_order_id: "2" };
  const getOrder = vi
    .fn<Grvt["getOrder"]>()
    .mockRejectedValue(new ApiError(1004, "not visible", 404, "order", false));
  expect(await resolveOrder({ getOrder }, request)).toEqual({ status: "still_unknown" });
  expect(getOrder).toHaveBeenCalledExactlyOnceWith(request, undefined);
  getOrder.mockResolvedValue({ result: orderFor("99") });
  expect(await resolveOrder({ getOrder }, request)).toEqual({ status: "still_unknown" });
});

it("returns an observed match and propagates other errors", async () => {
  const request = { sub_account_id: "1", client_order_id: "2" };
  const order = orderFor("1");
  const getOrder = vi.fn<Grvt["getOrder"]>().mockResolvedValue({ result: order });
  expect(await resolveOrder({ getOrder }, request)).toEqual({ status: "found", order });
  getOrder.mockRejectedValue(new ApiError(1001, "forbidden", 403, "order", false));
  await expect(resolveOrder({ getOrder }, request)).rejects.toThrow("forbidden");
  await expect(resolveOrder({ getOrder }, { ...request, client_order_id: "0" })).rejects.toThrow(
    "positive uint64",
  );
  expect(getOrder).toHaveBeenCalledTimes(2);
});
