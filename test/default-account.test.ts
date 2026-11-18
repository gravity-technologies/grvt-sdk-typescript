import { expect, it } from "vitest";
import { Grvt, models, ConfigError } from "../src/index.js";

it("fills omitted accounts before signing without mutating caller orders", async () => {
  const captured: any[] = [];
  const client = new Grvt({
    subAccountId: "123",
    beforeSend: (call) => {
      captured.push(call.params);
      throw new Error("captured");
    },
  });
  await expect(client.getOrder({ client_order_id: "1" })).rejects.toThrow("captured");
  expect(captured.at(-1).sub_account_id).toBe("123");
  await expect(client.getOrder({ sub_account_id: "456", client_order_id: "1" })).rejects.toThrow(
    "captured",
  );
  expect(captured.at(-1).sub_account_id).toBe("456");
  const order: models.OrderInput = { time_in_force: "GOOD_TILL_TIME", legs: [] };
  await expect(client.createOrder({ order })).rejects.toThrow("captured");
  expect(captured.at(-1).order.sub_account_id).toBe("123");
  expect(order.sub_account_id).toBeUndefined();
  await expect(client.bulkOrders({ sub_account_id: "456", orders: [order] })).rejects.toThrow(
    "captured",
  );
  expect(captured.at(-1).orders[0].sub_account_id).toBe("456");
  expect(order.sub_account_id).toBeUndefined();
  expect(client.orderStream({}).selector).toBe("123");
  expect(client.orderStream({ sub_account_id: "456" }).selector).toBe("456");
  await client.close();
});
it("rejects missing accounts and invalid defaults before sending", async () => {
  const client = new Grvt();
  await expect(client.getOrder({ client_order_id: "1" })).rejects.toBeInstanceOf(ConfigError);
  for (const id of ["0", "-1", "abc", "18446744073709551616"])
    expect(() => new Grvt({ subAccountId: id })).toThrow(ConfigError);
  await client.close();
});

it.each([undefined, "123"])(
  "keeps optional transfer account omitted with default %s",
  async (subAccountId) => {
    const client = new Grvt(subAccountId === undefined ? {} : { subAccountId });
    expect(client.transferStream({ main_account_id: "main" }).selector).toBe("main");
    expect(client.transferStream({ main_account_id: "main", sub_account_id: "456" }).selector).toBe(
      "main-456",
    );
    await client.close();
  },
);
