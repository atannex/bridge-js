import type { BridgeFile, ReactNativeFile } from '../contracts/types.js';

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
};

/** True for a React Native style file: `{ uri, name, type }`, all strings. */
export function isReactNativeFile(value: unknown): value is ReactNativeFile {
  return (
    isPlainObject(value) &&
    typeof value['uri'] === 'string' &&
    typeof value['name'] === 'string' &&
    typeof value['type'] === 'string'
  );
}

/** True for anything the client uploads as a file part. */
export function isBridgeFile(value: unknown): value is BridgeFile {
  return (typeof Blob !== 'undefined' && value instanceof Blob) || isReactNativeFile(value);
}

interface FoundFile {
  path: string;
  file: BridgeFile;
}

/**
 * Splits files out of an input.
 *
 * The JSON part keeps everything else. A file under an object key is left out
 * of the JSON; a file inside an array becomes `null` so the other indexes stay
 * where they are. The server puts each file back at its path.
 */
export function extractFiles(input: unknown): { json: unknown; files: FoundFile[] } {
  const files: FoundFile[] = [];

  const walk = (value: unknown, path: string): unknown => {
    if (isBridgeFile(value)) {
      files.push({ path, file: value });
      return undefined;
    }
    if (Array.isArray(value)) {
      return value.map((item, index) => {
        const result = walk(item, path === '' ? String(index) : `${path}.${index}`);
        return result === undefined ? null : result;
      });
    }
    if (isPlainObject(value)) {
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value)) {
        const result = walk(item, path === '' ? key : `${path}.${key}`);
        if (result !== undefined) out[key] = result;
      }
      return out;
    }
    return value;
  };

  const json = walk(input, '');
  return { json, files };
}

export type EncodedBody = { kind: 'json'; body: string } | { kind: 'multipart'; body: FormData };

/** Encodes an operation input per PROTOCOL.md: JSON, or multipart when it holds files. */
export function encodeInput(input: unknown): EncodedBody {
  const { json, files } = extractFiles(input ?? {});
  if (files.length === 0) {
    return { kind: 'json', body: JSON.stringify({ input: input ?? {} }) };
  }
  if (typeof FormData === 'undefined') {
    throw new TypeError('This input contains files, but FormData is not available in this environment.');
  }
  const form = new FormData();
  form.append('input', JSON.stringify(json ?? {}));
  for (const { path, file } of files) {
    if (isReactNativeFile(file)) {
      // React Native's FormData takes { uri, name, type } in place of a Blob.
      form.append(`files[${path}]`, file as unknown as Blob);
    } else {
      const name = (file as Blob & { name?: unknown }).name;
      form.append(`files[${path}]`, file, typeof name === 'string' && name !== '' ? name : 'blob');
    }
  }
  return { kind: 'multipart', body: form };
}
