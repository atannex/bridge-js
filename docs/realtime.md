# Realtime (experimental)

`@atannex/bridge/realtime` puts typed subscriptions on top of Laravel Echo.
Bridge does not run a socket server: events go through Laravel broadcasting
(Reverb, Pusher, or any Echo connector), and channels are authorized by
Laravel's `/broadcasting/auth` as usual.

**Experimental.** The API may change in a minor release. And there is no
delivery guarantee: events sent while the socket is down are lost. After a
reconnect, refetch what you show (`invalidate(queryClient)` works well).

## Setup

```ts
import Echo from 'laravel-echo';
import Pusher from 'pusher-js';
import { createRealtime, echoAuthorizer } from '@atannex/bridge/realtime';

const echo = new Echo({
  broadcaster: 'reverb',
  key: REVERB_APP_KEY,
  wsHost: 'ws.example.com',
  forceTLS: true,
  Pusher,
  // Authorize private and presence channels with the same credentials as Bridge calls.
  authorizer: echoAuthorizer(auth, { authEndpoint: 'https://api.example.com/broadcasting/auth' }),
});

export const realtime = createRealtime<AppBridge>(echo);
```

With bearer tokens, the broadcasting auth route must accept them:
`Broadcast::routes(['middleware' => ['auth:sanctum']])`. With cookie sessions
the default `web` middleware works, as long as CORS allows the SPA's origin.

React Native: install `pusher-js` and import `Pusher from 'pusher-js/react-native'`.

## Subscribing

```ts
const subscription = realtime.subscribe(
  'orders.updated',
  { channel: `orders.${user.id}`, type: 'private' },
  (order) => { /* typed from the contract */ },
);

subscription.unsubscribe();
```

- `channel` is the name from `routes/channels.php`, without `private-` /
  `presence-`.
- `type` must match the event's channel type in the contract; a private event
  cannot be subscribed on a public channel.
- Several subscriptions share one channel; it is left when the last one
  unsubscribes.
- Presence channels take `presence: { here, joining, leaving }`.

## Connection and auth changes

```ts
realtime.connectionState();                        // 'connected', 'unavailable', ... or 'unknown'
const stop = realtime.onStateChange((state) => {}); // Pusher protocol connectors only
realtime.reauthorize();  // after login, logout or tenant switch: rejoin private/presence channels
realtime.disconnectAll();
```

Echo and pusher-js reconnect by themselves; `reauthorize` makes private
channels authorize again with the current credentials.
