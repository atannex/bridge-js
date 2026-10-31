/**
 * `@atannex/bridge` — a typed client for Laravel apps running `atannex/bridge`.
 *
 * @packageDocumentation
 */
export { createBridge } from './client/create-bridge.js';
export type { Bridge, BridgeConfig, CallArgs, CallOptions, DownloadOptions } from './client/create-bridge.js';
export { DEFAULT_RETRY, mayRepeat } from './client/retry.js';
export type { ResolvedRetryPolicy, RetryPolicy } from './client/retry.js';

export type {
  BridgeFile,
  BridgeResponse,
  ChannelType,
  Contract,
  CursorPagination,
  DownloadLink,
  EventChannel,
  EventName,
  EventPayload,
  EventShape,
  HasOptionalInput,
  IdempotencyLevel,
  InputOf,
  LengthAwarePagination,
  OperationAuth,
  OperationInfo,
  OperationName,
  OperationShape,
  OperationsManifest,
  OutputOf,
  Paginated,
  Pagination,
  ReactNativeFile,
  ResponseMeta,
  SimplePagination,
  UntypedContract,
} from './contracts/types.js';

export {
  BridgeAbortError,
  BridgeAuthenticationError,
  BridgeAuthorizationError,
  BridgeConflictError,
  BridgeError,
  BridgeNetworkError,
  BridgeNotFoundError,
  BridgeProtocolError,
  BridgeRateLimitError,
  BridgeServerError,
  BridgeTimeoutError,
  BridgeValidationError,
} from './errors/errors.js';
export type { BridgeErrorInit } from './errors/errors.js';
export * from './errors/guards.js';

export { bearerToken } from './authentication/bearer-token.js';
export type {
  BearerTokenAuth,
  BearerTokenOptions,
  TokenCredentials,
  TokenLoginResult,
  TwoFactorInput,
} from './authentication/bearer-token.js';
export { sanctumSession } from './authentication/sanctum-session.js';
export type {
  SanctumSessionAuth,
  SanctumSessionOptions,
  SessionCredentials,
  SessionLoginResult,
} from './authentication/sanctum-session.js';
export { memoryCookieJar } from './authentication/cookie-jar.js';
export type { CookieJar } from './authentication/cookie-jar.js';
export { memoryStorage } from './authentication/types.js';
export type { AuthAdapter, AuthHost, HostRequest, HostResponse, TokenStorage } from './authentication/types.js';

export type {
  ErrorInterceptor,
  InterceptorContext,
  InterceptorList,
  RequestInterceptor,
  ResponseInterceptor,
} from './interceptors/interceptors.js';

export { fetchTransport } from './transport/fetch.js';
export type {
  DownloadProgress,
  Transport,
  TransportRequest,
  TransportResponse,
  UploadProgress,
} from './transport/types.js';

export { isBridgeFile, isReactNativeFile } from './serialization/body.js';
export { ERROR_CODES, PROTOCOL_VERSION } from './protocol/constants.js';
export type { ProtocolErrorCode } from './protocol/constants.js';
