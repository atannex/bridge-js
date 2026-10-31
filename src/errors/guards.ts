import {
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
} from './errors.js';

export const isBridgeError = (error: unknown): error is BridgeError => error instanceof BridgeError;
export const isNetworkError = (error: unknown): error is BridgeNetworkError => error instanceof BridgeNetworkError;
export const isTimeoutError = (error: unknown): error is BridgeTimeoutError => error instanceof BridgeTimeoutError;
export const isAbortError = (error: unknown): error is BridgeAbortError => error instanceof BridgeAbortError;
export const isAuthenticationError = (error: unknown): error is BridgeAuthenticationError =>
  error instanceof BridgeAuthenticationError;
export const isAuthorizationError = (error: unknown): error is BridgeAuthorizationError =>
  error instanceof BridgeAuthorizationError;
export const isNotFoundError = (error: unknown): error is BridgeNotFoundError => error instanceof BridgeNotFoundError;
export const isValidationError = (error: unknown): error is BridgeValidationError =>
  error instanceof BridgeValidationError;
export const isConflictError = (error: unknown): error is BridgeConflictError => error instanceof BridgeConflictError;
export const isRateLimitError = (error: unknown): error is BridgeRateLimitError =>
  error instanceof BridgeRateLimitError;
export const isServerError = (error: unknown): error is BridgeServerError => error instanceof BridgeServerError;
export const isProtocolError = (error: unknown): error is BridgeProtocolError => error instanceof BridgeProtocolError;
