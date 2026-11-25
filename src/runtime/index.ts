// Everything generated code and users need from the hand-written runtime (see RUNTIME_API.md).

export { ACCOUNT_HEADER, COOKIE_NAME, parseCookie, Session } from "./auth.js";
export {
  type ClientOrderIdProvider,
  type Clock,
  FixedClock,
  type NonceProvider,
  RandomNonce,
  SystemClock,
  TimeCounterClientOrderId,
} from "./clock.js";
export type { Environment } from "./env.js";
export {
  ApiError,
  type ClientOrderIds,
  ClosedError,
  ConfigError,
  DecimalError,
  DecodeError,
  type ErrorInfo,
  ErrorTable,
  FrameTooLarge,
  GrvtError,
  isRetryable,
  OrderOutOfBounds,
  type OrderOutOfBoundsDetail,
  OrderStateUnknown,
  RATE_LIMIT_CODE,
  RateLimitError,
  SigningError,
  StreamOverflow,
  TransportError,
} from "./errors.js";
export type { BeforeSend, Call, Event, EventKind, GapRange, OnEvent, SocketName } from "./hooks.js";
export { FetchTransport, type HttpResponse, type HttpTransport } from "./http.js";
export { redact, setLogLevel } from "./log.js";
export { Backoff, jsonrpcFrame, RequestTable, Sequencer } from "./protocol.js";
export {
  type CallOptions,
  type ClientOptions,
  type Encoding,
  MetadataCache,
  type OrderTransport,
  type Req,
  Runtime,
  type SignFn,
  type Tables,
} from "./runtime.js";
export {
  checkOrder,
  orderIssues,
  legInstruments,
  type OrderCheckRule,
  type OrderChecks,
  type OrderIssue,
} from "./signing/checks.js";
export {
  bytesToHex,
  checkSignature,
  checksumAddress,
  keccak256,
  recoverAddress,
} from "./signing/crypto.js";
export {
  type Domain,
  domainSeparator,
  grvtDomain,
  type Message,
  type MessageValue,
  type StructType,
  type TypeDefs,
} from "./signing/eip712.js";
export { PrivateKeySigner, type Signature, type Signer } from "./signing/signer.js";
export { type CurrencyMeta, type InstrumentMeta, scaleDecimal } from "./signing/wire.js";
export type { Gateway, RpcSpec, SelectorField, StreamSpec } from "./spec.js";
export {
  defaultWebSocketFactory,
  Subscription,
  type WebSocketFactory,
  type WebSocketLike,
  WsSocket,
} from "./ws.js";
