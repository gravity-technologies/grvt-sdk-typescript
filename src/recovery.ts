import type { Grvt } from "./generated/client.js";
import { ErrorCode } from "./generated/errors.js";
import type { Order } from "./generated/models.js";
import { ApiError } from "./runtime/errors.js";
import type { CallOptions } from "./runtime/runtime.js";

export type OrderResolution = { status: "found"; order: Order } | { status: "still_unknown" };

/**
 * Look up an uncertain order by client ID. Never places or resends an order.
 * Not found can mean the order is not visible yet. If IDs were reused, a match
 * may belong to another request. Neither outcome permits an automatic resend.
 */
export async function resolveOrder(
  client: Pick<Grvt, "getOrder">,
  request: { sub_account_id: string; client_order_id: string },
  options?: CallOptions,
): Promise<OrderResolution> {
  for (const value of [request.sub_account_id, request.client_order_id]) {
    if (
      typeof value !== "string" ||
      !/^[0-9]+$/.test(value) ||
      BigInt(value) <= 0n ||
      BigInt(value) >= 1n << 64n
    ) {
      throw new RangeError("sub_account_id and client_order_id must be positive uint64 values");
    }
  }
  request = {
    sub_account_id: BigInt(request.sub_account_id).toString(),
    client_order_id: BigInt(request.client_order_id).toString(),
  };
  try {
    const order = (await client.getOrder(request, options)).result;
    if (
      order?.sub_account_id === request.sub_account_id &&
      order.metadata?.client_order_id === request.client_order_id
    ) {
      return { status: "found", order };
    }
    return { status: "still_unknown" };
  } catch (error) {
    if (error instanceof ApiError && error.code === ErrorCode.NOT_FOUND)
      return { status: "still_unknown" };
    throw error;
  }
}
