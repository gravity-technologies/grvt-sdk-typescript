// grvt: the Grvt TypeScript SDK (draft).
//
//   import { Grvt, PrivateKeySigner, models, enums } from "grvt";
//
// Everything under src/generated is generated from sdk/contract/contract.json; src/runtime is the
// small hand-written runtime (see RUNTIME_API.md).

export * from "./runtime/index.js";
export { Grvt } from "./generated/client.js";
export * as models from "./generated/models.js";
export * as enums from "./generated/enums.js";
export * as signing from "./generated/signing.js";
export * as specs from "./generated/specs.js";
export { ErrorCode, ERRORS } from "./generated/errors.js";
export { CONTRACT_VERSION, ENVIRONMENTS } from "./generated/specs.js";

export { Decimal, Timestamp } from "./runtime/scalars.js";

export { resolveOrder, type OrderResolution } from "./recovery.js";

export { pages, PaginationCycle } from "./pagination.js";

export { OrderBook, BookError, type BookSnapshot } from "./orderbook.js";

export { backfillPages, type BackfillPage } from "./backfill.js";

export { refreshCancelCountdown, type CountdownReceipt } from "./countdown.js";
