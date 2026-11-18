import { COUNTDOWN_MAX_SECONDS, COUNTDOWN_MIN_SECONDS } from "./generated/behavior.js";
import type { Grvt } from "./generated/client.js";
import type { CallOptions } from "./runtime/runtime.js";
export interface CountdownReceipt {
  readonly subAccountId: string;
  readonly countdownSeconds: number;
  readonly acknowledged: boolean;
  readonly scope: "sub_account";
}
/** Explicitly arm/refresh the account-wide countdown once. No retry, background
 * refresh, automatic reconnect action, or implicit disarm. An acknowledgment
 * does not prove the timer remains active: another caller can replace it. */
export async function refreshCancelCountdown(
  client: Pick<Grvt, "cancelOnDisconnect">,
  subAccountId: string,
  countdownSeconds: number,
  options?: CallOptions,
): Promise<CountdownReceipt> {
  if (
    !Number.isInteger(countdownSeconds) ||
    countdownSeconds < COUNTDOWN_MIN_SECONDS ||
    countdownSeconds > COUNTDOWN_MAX_SECONDS
  )
    throw new RangeError(
      `countdownSeconds must be an integer from ${COUNTDOWN_MIN_SECONDS} to ${COUNTDOWN_MAX_SECONDS}`,
    );
  if (
    typeof subAccountId !== "string" ||
    !/^[0-9]+$/.test(subAccountId) ||
    BigInt(subAccountId) <= 0n ||
    BigInt(subAccountId) >= 1n << 64n
  )
    throw new RangeError("subAccountId must be a positive uint64");
  const account = BigInt(subAccountId).toString();
  const response = await client.cancelOnDisconnect(
    { sub_account_id: account, countdown_time: String(countdownSeconds * 1000) },
    options,
  );
  return Object.freeze({
    subAccountId: account,
    countdownSeconds,
    acknowledged: response.result.ack,
    scope: "sub_account",
  });
}
