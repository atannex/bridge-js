# Authentication

Bridge does not do authentication itself. It uses Laravel's: Sanctum cookie
sessions with Fortify for web apps, and Sanctum personal access tokens issued by
Bridge's token endpoint for mobile apps. Signing in only proves who the user
is; the server still authorizes every operation separately.

Pick by where the code runs:

| App | Adapter |
|-----|---------|
| React / Vue / Astro SPA, Next.js client components, served from a domain Sanctum treats as stateful | `sanctumSession()` |
| React Native, Expo | `bearerToken({ storage: expoSecureStore(SecureStore) })` |
| Node scripts, server-side jobs acting as a service account | `bearerToken({ storage: memoryStorage() })` |
| Node tests of the session flow | `sanctumSession({ cookieJar: memoryCookieJar() })` |

Pass the adapter as `auth` to `createBridge`; keep a reference to it for
`login`, `logout` and `user`. One adapter belongs to one client.

## Web apps: Sanctum cookie sessions

```ts
import { createBridge, sanctumSession } from '@atannex/bridge';

export const auth = sanctumSession();
export const bridge = createBridge<AppBridge>({ baseURL: 'https://api.example.com', operations, auth });

const result = await auth.login({ email, password, remember: true });
if (result.status === 'two_factor_required') {
  await auth.twoFactorChallenge({ code }); // or { recovery_code }
}
const me = await auth.user(); // null when signed out
await auth.logout();
```

What it does:

- Sends every request with `credentials: 'include'`.
- `login` first fetches `/sanctum/csrf-cookie`, then posts to Fortify's `/login`.
- Copies the `XSRF-TOKEN` cookie into the `X-XSRF-TOKEN` header.
- On `419` it refreshes the CSRF cookie and replays the request once.
- On `401` it calls `onSessionExpired`.

Paths are options (`csrfPath`, `loginPath`, `logoutPath`, `twoFactorPath`,
`userPath`) if your routes differ.

### Server requirements

Cookie sessions only work when the browser will send the cookies. Check:

- **Stateful domains.** Your SPA's host (with port in development, e.g.
  `localhost:5173`) is in `SANCTUM_STATEFUL_DOMAINS`.
- **Same site.** The SPA and API share a registrable domain
  (`app.example.com` + `api.example.com`). Cookies across unrelated domains are
  blocked by browsers.
- **Cookie domain.** `SESSION_DOMAIN=.example.com` so the SPA can read
  `XSRF-TOKEN` from `document.cookie`.
- **CORS.** `config/cors.php`: `supports_credentials => true`, your SPA's origin
  in `allowed_origins` (not `*`), and the paths `bridge/*`, `sanctum/csrf-cookie`,
  `login`, `logout`, `two-factor-challenge`. Allowed headers must include
  `X-Bridge-Version`, `X-Request-Id`, `X-Correlation-Id`, `X-Bridge-Tenant`,
  `X-Bridge-Client`, `Idempotency-Key`, `X-XSRF-TOKEN`, `X-Requested-With`,
  `Content-Type`, `Accept`, `Accept-Language`.
- **HTTPS in production**, with `SESSION_SECURE_COOKIE=true`. `SameSite=Lax`
  (Laravel's default) is right for same-site setups.

### Next.js

Client components can use `sanctumSession` like any SPA. Server components,
route handlers and server actions run on your Next.js server, which does not
have the visitor's browser cookies for the API domain. Do not forward a
visitor's session cookie from there to Laravel; if the server must call
Laravel, use a `bearerToken` that belongs to the server (a service account,
token in an environment variable) and authorize accordingly in Laravel.

## Mobile apps: bearer tokens

```ts
import * as SecureStore from 'expo-secure-store';
import { bearerToken, createBridge } from '@atannex/bridge';
import { expoSecureStore } from '@atannex/bridge/expo';

export const auth = bearerToken({
  storage: expoSecureStore(SecureStore, { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK }),
  deviceName: `${Device.modelName ?? 'device'}`,
  onSessionExpired: () => router.replace('/login'),
});
export const bridge = createBridge<AppBridge>({ baseURL: API_URL, operations, auth });

const result = await auth.login({ email, password });
if (result.status === 'two_factor_required') {
  await auth.completeTwoFactor({ challenge: result.challenge, code });
}
```

- The token endpoint (`POST /bridge/v1/auth/token`) must be enabled on the
  server (`bridge.auth.tokens.enabled`). It needs `laravel/sanctum`.
- With two-factor auth on, `login` returns a short-lived, single-use
  `challenge` and **no token**. The token is issued only by
  `completeTwoFactor` with a valid TOTP or recovery code.
- Tokens are stored only in the storage you pass. There is deliberately no
  default: use `expoSecureStore` (Keychain / Keystore) on Expo. Do not use
  plain AsyncStorage for tokens.
- `logout()` revokes the token on the server, then always deletes it locally,
  even if the request fails (it rethrows non-401 failures so you know the
  server may not have revoked it).
- A `401` on any call deletes the stored token and calls `onSessionExpired`
  once, even when several calls fail at the same time. A token saved after
  the failing request went out (a fresh login) is kept.
- Tokens are refreshed, not re-entered. The server reports when a token
  expires (`expires_at`, stored next to the token). From `refreshBefore`
  seconds before that (default 3 days), the next request first swaps the
  token for a new one with `POST auth/refresh`; concurrent requests wait for
  that one refresh and go out with the new token. Call `auth.refresh()`
  yourself at any time, and `auth.expiresAt()` to see the date.
  `refreshBefore: 0` turns the automatic refresh off.
- There is no separate refresh token. A token that has already expired or
  been revoked cannot be refreshed: `refresh()` rejects with
  `BridgeAuthenticationError`, the token is deleted, `onSessionExpired` runs,
  and the user signs in again. A refresh that fails for another reason
  (offline) keeps the old token, and the request still goes out with it.
- A request already in flight with the old token when the refresh lands gets
  401 from the server; the new token is kept and the session stays signed in.
  Retry that call (TanStack Query does for queries).
- Tokens expire when the server says (Bridge's default is 30 days; the
  example app turns expiry off, so its tokens report `expires_at: null` and
  are never refreshed automatically). An expired token answers 401 like a
  revoked one.
- A `429 RATE_LIMITED` (`BridgeRateLimitError`) from `login` or
  `completeTwoFactor` is not always "too many requests from this device": the
  server also locks a user out of the second factor for a while after too many
  wrong codes, across challenges. Show "Try again later" with
  `error.retryAfter` when present, rather than offering another code at once.

React Native does not enforce CORS and does not need CSRF; bearer requests are
not cookie-authenticated, so CSRF does not apply to them.

## Writing your own adapter

```ts
import type { AuthAdapter } from '@atannex/bridge';

const apiKey: AuthAdapter = {
  prepare(request) {
    request.headers['authorization'] = `Bearer ${getKeyFromVault()}`;
  },
  onUnauthenticated() { /* ... */ },
};
```

`attach(host)` gives the adapter `host.send()` (requests with the client's
base URL, headers and transport, same origin only) and `host.prefixed(path)`.
