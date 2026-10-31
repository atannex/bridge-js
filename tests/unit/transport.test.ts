import { File as NodeFile } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { BridgeAbortError, BridgeNetworkError, BridgeTimeoutError, createBridge, isBridgeFile } from '@atannex/bridge';
import { parseResponseHeaders, xhrTransport } from '@atannex/bridge/xhr';
import { extractFiles, encodeInput } from '../../src/serialization/body.js';
import { linkSignal } from '../../src/utilities/signal.js';
import { joinUrl, originOf } from '../../src/utilities/url.js';
import { randomId } from '../../src/utilities/id.js';
import { operations, type AppBridge } from '../fixtures/contract.js';
import { fakeFetch, hang, networkDown, ok } from '../fixtures/fake-fetch.js';

describe('timeouts and cancellation', () => {
  it('times out after the configured timeout', async () => {
    const { fetch } = fakeFetch(hang);
    const bridge = createBridge<AppBridge>({ baseURL: 'https://api.test', fetch, timeout: 20 });
    const error = await bridge.call('cart.remove', { product_id: 1 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BridgeTimeoutError);
    expect((error as BridgeTimeoutError).code).toBe('TIMEOUT');
  });

  it('lets a call override the timeout', async () => {
    const { fetch } = fakeFetch(hang);
    const bridge = createBridge<AppBridge>({ baseURL: 'https://api.test', fetch, timeout: 60_000 });
    await expect(bridge.call('cart.remove', { product_id: 1 }, { timeout: 10 })).rejects.toBeInstanceOf(
      BridgeTimeoutError,
    );
  });

  it('cancels with the caller signal and does not retry', async () => {
    const { fetch, requests } = fakeFetch(hang);
    const bridge = createBridge<AppBridge>({ baseURL: 'https://api.test', fetch, operations });
    const controller = new AbortController();
    const pending = bridge.call('cart.show', {}, { signal: controller.signal });
    setTimeout(() => controller.abort(), 5);
    await expect(pending).rejects.toBeInstanceOf(BridgeAbortError);
    expect(requests).toHaveLength(1);
  });

  it('fails fast with an already-aborted signal', async () => {
    const { fetch } = fakeFetch(ok(null));
    const bridge = createBridge<AppBridge>({ baseURL: 'https://api.test', fetch });
    await expect(bridge.call('cart.show', {}, { signal: AbortSignal.abort() })).rejects.toBeInstanceOf(
      BridgeAbortError,
    );
  });

  it('classifies a failed fetch as a network error with the cause attached', async () => {
    const { fetch } = fakeFetch(networkDown);
    const error = (await createBridge({ baseURL: 'https://api.test', fetch })
      .call('cart.show')
      .catch((e: unknown) => e)) as BridgeNetworkError;
    expect(error).toBeInstanceOf(BridgeNetworkError);
    expect(error.cause).toBeInstanceOf(TypeError);
  });

  it('linkSignal reports which source aborted and cleans up', async () => {
    const parent = new AbortController();
    const linked = linkSignal(parent.signal, 1000);
    parent.abort();
    expect(linked.signal.aborted).toBe(true);
    expect(linked.timedOut()).toBe(false);
    linked.dispose();

    const timed = linkSignal(undefined, 5);
    await new Promise((r) => setTimeout(r, 20));
    expect(timed.signal.aborted).toBe(true);
    expect(timed.timedOut()).toBe(true);

    const never = linkSignal(undefined, Infinity);
    expect(never.signal.aborted).toBe(false);
    never.dispose();
  });
});

describe('multipart encoding', () => {
  it('uses JSON when there are no files', () => {
    expect(encodeInput({ a: 1 })).toEqual({ kind: 'json', body: '{"input":{"a":1}}' });
    expect(encodeInput(undefined)).toEqual({ kind: 'json', body: '{"input":{}}' });
  });

  it('pulls files out by dot path; array slots become null', () => {
    const avatar = new Blob(['a']);
    const doc = { uri: 'file:///tmp/x.pdf', name: 'x.pdf', type: 'application/pdf' };
    const { json, files } = extractFiles({
      title: 't',
      avatar,
      attachments: [doc, 'keep', new Blob(['b'])],
      nested: { file: avatar },
    });
    expect(json).toEqual({ title: 't', attachments: [null, 'keep', null], nested: {} });
    expect(files.map((f) => f.path)).toEqual(['avatar', 'attachments.0', 'attachments.2', 'nested.file']);
  });

  it('builds the multipart body the protocol describes', async () => {
    const { fetch, requests } = fakeFetch(
      ok({ size: 3, mime: 'image/png', download: { url: 'u', name: 'n', expires_at: 'e' } }),
    );
    const bridge = createBridge<AppBridge>({ baseURL: 'https://api.test', fetch });
    // Node 18 has no global File; node:buffer's is the same class on newer Node.
    const avatar = new NodeFile([new Uint8Array([1, 2, 3])], 'me.png', { type: 'image/png' }) as unknown as File;
    await bridge.call('profile.avatar.upload', { avatar });

    const request = requests[0]!;
    expect(request.headers['content-type']).toBeUndefined(); // fetch sets the multipart boundary itself
    const form = request.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get('input')).toBe('{}');
    const part = form.get('files[avatar]') as File;
    expect(part.name).toBe('me.png');
    expect(part.type).toBe('image/png');
    expect(part.size).toBe(3);
  });

  it('recognises files', () => {
    expect(isBridgeFile(new Blob([]))).toBe(true);
    expect(isBridgeFile({ uri: 'file://a', name: 'a', type: 'image/png' })).toBe(true);
    expect(isBridgeFile({ uri: 'file://a', name: 'a' })).toBe(false);
    expect(isBridgeFile('file://a')).toBe(false);
  });
});

describe('utilities', () => {
  it('joins URLs and reads origins', () => {
    expect(joinUrl('https://a.test/', '/x/y')).toBe('https://a.test/x/y');
    expect(joinUrl('https://a.test/base', 'x')).toBe('https://a.test/base/x');
    expect(joinUrl('https://a.test', 'https://b.test/z')).toBe('https://b.test/z');
    expect(originOf('HTTPS://A.test:8443/path?q')).toBe('https://a.test:8443');
    expect(originOf('/relative')).toBeUndefined();
  });

  it('makes protocol-valid ids, even without crypto', () => {
    expect(randomId()).toMatch(/^[A-Za-z0-9._:-]{8,128}$/);
    const original = globalThis.crypto;
    Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true });
    try {
      expect(randomId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    } finally {
      Object.defineProperty(globalThis, 'crypto', { value: original, configurable: true });
    }
  });
});

/** Enough of XMLHttpRequest to drive the transport. */
class FakeXhr {
  static last: FakeXhr | undefined;
  static respond: (xhr: FakeXhr) => void = (xhr) =>
    xhr.finish(200, '{"data":null,"meta":{"request_id":"r-12345678","version":"1"}}');
  method = '';
  url = '';
  headers: Record<string, string> = {};
  body: unknown;
  withCredentials = false;
  responseType = '';
  status = 0;
  responseText = '';
  upload: { onprogress: ((e: { loaded: number; total: number; lengthComputable: boolean }) => void) | null } = {
    onprogress: null,
  };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  onabort: (() => void) | null = null;
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(name: string, value: string) {
    this.headers[name] = value;
  }
  getAllResponseHeaders() {
    return 'content-type: application/json\r\nx-request-id: r-12345678\r\n';
  }
  send(body: unknown) {
    this.body = body;
    FakeXhr.last = this;
    queueMicrotask(() => FakeXhr.respond(this));
  }
  abort() {
    this.onabort?.();
  }
  finish(status: number, text: string) {
    this.status = status;
    this.responseText = text;
    this.onload?.();
  }
}

describe('xhrTransport', () => {
  const transport = xhrTransport({ XMLHttpRequest: FakeXhr as unknown as typeof XMLHttpRequest });

  it('sends through XMLHttpRequest and reports upload progress', async () => {
    const progress: number[] = [];
    FakeXhr.respond = (xhr) => {
      xhr.upload.onprogress?.({ loaded: 5, total: 10, lengthComputable: true });
      xhr.finish(200, '{"data":{"ok":true},"meta":{"request_id":"r-12345678","version":"1"}}');
    };
    const bridge = createBridge({ baseURL: 'https://api.test', transport });
    const data = await bridge.call(
      'profile.avatar.upload',
      { avatar: new Blob(['x']) },
      {
        onUploadProgress: (p) => progress.push(p.loaded / (p.total ?? 1)),
      },
    );
    expect(data).toEqual({ ok: true });
    expect(progress).toEqual([0.5]);
    expect(FakeXhr.last?.method).toBe('POST');
    expect(FakeXhr.last?.url).toBe('https://api.test/bridge/v1/call/profile.avatar.upload');
    expect(FakeXhr.last?.headers['x-bridge-version']).toBe('1');
    expect(FakeXhr.last?.body).toBeInstanceOf(FormData);
  });

  it('sets withCredentials for credentials: include', async () => {
    FakeXhr.respond = (xhr) => xhr.finish(200, '{"data":null,"meta":{"request_id":"r-12345678","version":"1"}}');
    await createBridge({ baseURL: 'https://api.test', transport, credentials: 'include' }).call('cart.show');
    expect(FakeXhr.last?.withCredentials).toBe(true);
  });

  it('maps XHR errors to network errors and aborts to abort errors', async () => {
    FakeXhr.respond = (xhr) => xhr.onerror?.();
    await expect(createBridge({ baseURL: 'https://api.test', transport }).call('cart.show')).rejects.toBeInstanceOf(
      BridgeNetworkError,
    );
    FakeXhr.respond = () => undefined;
    const controller = new AbortController();
    const pending = createBridge({ baseURL: 'https://api.test', transport }).call(
      'cart.show',
      {},
      { signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 5);
    await expect(pending).rejects.toBeInstanceOf(BridgeAbortError);
  });

  it('parses raw response headers', () => {
    const headers = parseResponseHeaders('A: 1\r\nB: two: parts\r\n\r\nbad line\r\n');
    expect(headers.get('a')).toBe('1');
    expect(headers.get('b')).toBe('two: parts');
  });
});
