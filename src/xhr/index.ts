/**
 * An XMLHttpRequest transport. Works in browsers and React Native, and reports
 * upload progress, which fetch cannot.
 *
 * ```ts
 * import { createBridge } from '@atannex/bridge';
 * import { xhrTransport } from '@atannex/bridge/xhr';
 *
 * const bridge = createBridge<AppBridge>({ baseURL, transport: xhrTransport() });
 * await bridge.call('profile.avatar.upload', { avatar }, { onUploadProgress: (p) => setProgress(p) });
 * ```
 *
 * @packageDocumentation
 */
import type { Transport, TransportResponse } from '../transport/types.js';

export type { Transport, TransportRequest, TransportResponse, UploadProgress } from '../transport/types.js';

export interface XhrTransportOptions {
  /** Supply a constructor when `XMLHttpRequest` is not a global. */
  XMLHttpRequest?: typeof XMLHttpRequest;
}

/** Parses `getAllResponseHeaders()` output into a `Headers`. */
export function parseResponseHeaders(raw: string): Headers {
  const headers = new Headers();
  for (const line of raw.split(/\r?\n/)) {
    const index = line.indexOf(':');
    if (index <= 0) continue;
    const name = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim();
    try {
      headers.append(name, value);
    } catch {
      // Forbidden or malformed header names are skipped, as fetch would.
    }
  }
  return headers;
}

export function xhrTransport(options: XhrTransportOptions = {}): Transport {
  return (request) =>
    new Promise<TransportResponse>((resolve, reject) => {
      const Xhr = options.XMLHttpRequest ?? globalThis.XMLHttpRequest;
      if (typeof Xhr !== 'function') {
        reject(new TypeError('XMLHttpRequest is not available in this environment.'));
        return;
      }
      if (request.signal.aborted) {
        reject(request.signal.reason);
        return;
      }

      const xhr = new Xhr();
      xhr.open(request.method, request.url, true);
      xhr.responseType = 'text';
      xhr.withCredentials = request.credentials === 'include';
      for (const [name, value] of Object.entries(request.headers)) {
        xhr.setRequestHeader(name, value);
      }

      const onAbort = (): void => xhr.abort();
      request.signal.addEventListener('abort', onAbort, { once: true });
      const cleanup = (): void => request.signal.removeEventListener('abort', onAbort);

      const progress = request.onUploadProgress;
      // Some React Native versions have no `upload` object.
      const upload = xhr.upload as XMLHttpRequestUpload | undefined;
      if (progress !== undefined && upload !== undefined) {
        upload.onprogress = (event) => {
          progress({ loaded: event.loaded, total: event.lengthComputable ? event.total : undefined });
        };
      }

      xhr.onload = () => {
        cleanup();
        const body = typeof xhr.responseText === 'string' ? xhr.responseText : '';
        resolve({
          status: xhr.status,
          headers: parseResponseHeaders(xhr.getAllResponseHeaders()),
          // XHR always follows redirects; the client compares this final URL's
          // origin with the one it asked for and rejects a mismatch.
          url: typeof xhr.responseURL === 'string' ? xhr.responseURL : undefined,
          text: () => Promise.resolve(body),
        });
      };
      xhr.onerror = () => {
        cleanup();
        reject(new TypeError('Network request failed'));
      };
      xhr.ontimeout = xhr.onerror;
      xhr.onabort = () => {
        cleanup();
        reject(request.signal.reason ?? new Error('Aborted'));
      };

      xhr.send(request.body ?? null);
    });
}
