import { createBridge, sanctumSession } from '@atannex/bridge';
import { operations, type AppBridge } from '../generated/bridge.js';

/** Cookie-session auth: the SPA is served from a domain listed in SANCTUM_STATEFUL_DOMAINS. */
export const auth = sanctumSession<{ id: number; name: string; email: string }>();

export const bridge = createBridge<AppBridge>({
  baseURL: 'https://api.example.com',
  operations,
  auth,
  client: 'shop-web/1.0.0',
});
