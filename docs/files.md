# Uploads and downloads

## Uploads

Put a file in the input where the operation's schema expects one:

```ts
// Browser: a File or Blob
await bridge.call('profile.avatar.upload', { avatar: fileInput.files[0] });

// React Native / Expo: { uri, name, type }, e.g. from expo-image-picker
const asset = result.assets[0];
await bridge.call('profile.avatar.upload', {
  avatar: { uri: asset.uri, name: asset.fileName ?? 'photo.jpg', type: asset.mimeType ?? 'image/jpeg' },
});
```

When the input holds a file anywhere (also nested or in arrays), the client
sends `multipart/form-data`: the rest of the input as JSON in an `input` field,
and each file as `files[<dot.path>]`. A file under an object key is left out
of the JSON; one inside an array becomes `null` there, so other indexes keep
their position. The server puts each file back at its path, then validates
size and type. Client-side checks are only a courtesy to the user.

### Progress

Fetch cannot report upload progress. Use the XHR transport where you need it:

```ts
import { xhrTransport } from '@atannex/bridge/xhr';

const bridge = createBridge<AppBridge>({ baseURL, operations, auth, transport: xhrTransport() });

await bridge.call('profile.avatar.upload', { avatar }, {
  onUploadProgress: ({ loaded, total }) => setProgress(total ? loaded / total : undefined),
});
```

It works in browsers and React Native. With the fetch transport,
`onUploadProgress` is never called.

### Retries

Uploads are usually `unsafe` operations and are never retried automatically.
If the operation is `idempotent` on the server, pass `idempotencyKey: true`
and it can be retried; React Native file objects are re-read on each attempt.

## Downloads

An operation can return a `DownloadLink`:

```ts
interface DownloadLink { url: string; name: string; expires_at: string }
```

The URL is signed, expires, and may be bound to the user who requested it.
Fetch it through the client so the same credentials go along:

```ts
const response = await bridge.download(link);
const blob = await response.blob();               // browsers
```

### Download progress

```ts
const response = await bridge.download(link, {
  onDownloadProgress: ({ loaded, total }) => setProgress(total ? loaded / total : undefined),
});
const blob = await response.blob(); // progress fires while this reads
```

Progress is reported while the body is read, so it fires as you consume the
response, not when `download` resolves. `total` is the `Content-Length`, and
undefined when the server sent none or compressed the body (its length then
counts encoded bytes). In React Native, where response bodies are not
streams, it fires once, with the full size, when the body has arrived.

In React Native, either read `response.arrayBuffer()` or, for large files,
hand the URL and the auth header to `expo-file-system`'s download API.

`download` refuses to attach credentials to another origin than `baseURL`, and
rejects redirects. `signal` and `timeout` keep applying while the body is read,
so give large files a larger `timeout`.
