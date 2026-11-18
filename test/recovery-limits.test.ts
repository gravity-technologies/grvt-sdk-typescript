import { expect, it, vi } from "vitest";
import { refreshCancelCountdown } from "../src/countdown.js";
import { OrderStateUnknown } from "../src/runtime/errors.js";
import type { Grvt } from "../src/generated/client.js";

it("arms explicitly and stops on failure without retrying or disarming", async () => {
  const cancelOnDisconnect = vi
    .fn<Grvt["cancelOnDisconnect"]>()
    .mockResolvedValue({ result: { ack: true } });
  const client = { cancelOnDisconnect };
  expect(await refreshCancelCountdown(client, "001", 120)).toEqual({
    subAccountId: "1",
    countdownSeconds: 120,
    acknowledged: true,
    scope: "sub_account",
  });
  expect(cancelOnDisconnect).toHaveBeenCalledExactlyOnceWith(
    { sub_account_id: "1", countdown_time: "120000" },
    undefined,
  );
  for (const seconds of [0, 301, 1.5])
    await expect(refreshCancelCountdown(client, "1", seconds)).rejects.toThrow("1 to 300");
  expect(cancelOnDisconnect).toHaveBeenCalledTimes(1);
  const failure = new OrderStateUnknown("cancel_on_disconnect", "timeout", undefined);
  cancelOnDisconnect.mockRejectedValue(failure);
  await expect(refreshCancelCountdown(client, "1", 120)).rejects.toBe(failure);
  expect(cancelOnDisconnect).toHaveBeenCalledTimes(2);
});
