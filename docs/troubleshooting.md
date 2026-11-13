# Troubleshooting

**`BridgeNetworkError` in the browser, but the request works in curl.**
Almost always CORS. Open the browser console: a CORS failure is reported
there, not to JavaScript. Check `config/cors.php` covers `bridge/*`, allows
your origin and the Bridge headers, and (for sessions) has
`supports_credentials => true`. See [authentication](authentication.md#server-requirements).

**`419 CSRF_MISMATCH` on every call with `sanctumSession`.**
The client could not read the `XSRF-TOKEN` cookie. The SPA and API must share
a registrable domain and `SESSION_DOMAIN` must cover both. In Node, pass a
`memoryCookieJar()`.

**`401` right after a successful session login.**
Sanctum did not treat the request as stateful: the SPA's host (with port) is
missing from `SANCTUM_STATEFUL_DOMAINS`, or the request carries no
`Origin`/`Referer`.

**Login works but the token endpoint returns 404.**
Token auth is off by default. Enable `bridge.auth.tokens.enabled` and install
`laravel/sanctum`.

**Nothing is retried.**
Pass the generated `operations` to `createBridge`. Only `safe` operations,
and `idempotent` ones called with an `idempotencyKey`, are ever retried.

**`TypeError: "..." is not a valid Bridge operation name.`**
Names are lower-case, dot-separated segments of letters, digits and `_`
(`orders.create`), at most 120 characters.

**The compiler accepts a call the server rejects.**
Expected: types describe shapes, the server also checks values, ownership and
permissions. If shapes differ, regenerate the contract
(`php artisan bridge:generate`).

**`BridgeProtocolError` on a 200.**
Something between you and Laravel answered (a captive portal, a proxy, a
misrouted URL). Check `baseURL` and `prefix`.

**Upload progress never fires.**
The fetch transport cannot report it; use `xhrTransport()`.

**React Native: `Network request failed` against a local server.**
Android emulators reach the host at `10.0.2.2`; release builds need HTTPS.
