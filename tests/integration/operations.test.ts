import { beforeAll, expect, it } from 'vitest';
import {
  BridgeAuthenticationError,
  BridgeAuthorizationError,
  BridgeConflictError,
  BridgeError,
  BridgeNotFoundError,
  BridgeValidationError,
  createBridge,
} from '@atannex/bridge';
import { operations, type AppBridge } from './contract.generated.js';
import { baseURL, describeLive, emptyCart, PNG_BYTES, signedIn, type TokenClient } from './support.js';

const guest = () => createBridge<AppBridge>({ baseURL: baseURL ?? '', operations });

describeLive('operations over HTTP', () => {
  let alice: TokenClient;
  let bob: TokenClient;

  beforeAll(async () => {
    alice = await signedIn('alice@example.com');
    bob = await signedIn('bob@example.com');
  });

  it('answers the health check with nothing but a status', async () => {
    const response = await fetch(`${baseURL}/bridge/v1/health`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: unknown; meta: { request_id: string } };
    expect(body.data).toEqual({ status: 'ok' });
    expect(body.meta.request_id).toMatch(/^[A-Za-z0-9._:-]{8,128}$/);
  });

  it('lists products for guests, paginated', async () => {
    const page1 = await guest().call('products.list');
    expect(page1.items).toHaveLength(5);
    expect(page1.pagination).toMatchObject({ type: 'length_aware', current_page: 1, per_page: 5, has_more: true });
    if (page1.pagination.type === 'length_aware') expect(page1.pagination.total).toBeGreaterThanOrEqual(12);
    const product = page1.items[0]!;
    expect(typeof product.id).toBe('number');
    expect(product.price).toMatch(/^\d+\.\d{2}$/);
    expect(product.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/);
    expect(Object.keys(product).sort()).toEqual(['created_at', 'id', 'name', 'price']);

    const page2 = await guest().call('products.list', { page: 2 });
    expect(page2.pagination).toMatchObject({ current_page: 2 });
    expect(page2.items[0]?.id).not.toBe(product.id);
  });

  it('shows a product and 404s an unknown one', async () => {
    const first = (await guest().call('products.list')).items[0]!;
    // The detail shape extends the list shape with description and stock.
    const detail = await guest().call('products.show', { id: first.id });
    expect(detail).toMatchObject(first);
    expect(typeof detail.description).toBe('string');
    expect(typeof detail.in_stock).toBe('boolean');
    await expect(guest().call('products.show', { id: 999_999 })).rejects.toBeInstanceOf(BridgeNotFoundError);
  });

  it('404s an operation that is not registered', async () => {
    const error = await createBridge({ baseURL: baseURL ?? '' })
      .call('internal.secret.delete')
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BridgeNotFoundError);
    expect((error as BridgeError).code).toBe('NOT_FOUND');
    expect((error as BridgeError).requestId).toBeDefined();
  });

  it('rejects invalid input with field details', async () => {
    const error = await alice.bridge.call('cart.add', { product_id: 1, quantity: 0 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BridgeValidationError);
    expect((error as BridgeValidationError).code).toBe('VALIDATION_FAILED');
    expect((error as BridgeValidationError).fields['quantity']?.length).toBeGreaterThan(0);
  });

  it('401s user operations without credentials', async () => {
    const error = await guest()
      .call('cart.show')
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BridgeAuthenticationError);
    expect((error as BridgeError).code).toBe('UNAUTHENTICATED');
  });

  it('403s an operation the user may not run', async () => {
    const error = await alice.bridge.call('admin.stats').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BridgeAuthorizationError);
    expect((error as BridgeError).code).toBe('FORBIDDEN');
  });

  it('scopes tenant operations to teams the user belongs to', async () => {
    const red = await alice.bridge.call('team.projects.list', {}, { tenant: 1 });
    expect(red.team).toBe('red');
    const blue = await bob.bridge.call('team.projects.list', {}, { tenant: 2 });
    expect(blue.team).toBe('blue');

    const crossTenant = await alice.bridge.call('team.projects.list', {}, { tenant: 2 }).catch((e: unknown) => e);
    expect(crossTenant).toBeInstanceOf(BridgeAuthorizationError);
    expect((crossTenant as BridgeError).code).toBe('TENANT_FORBIDDEN');

    // Without a selection the server picks the user's own team.
    expect((await alice.bridge.call('team.projects.list')).team).toBe('red');
    expect(red.projects.map((p) => p.name)).not.toContain('Blue team secret plan');

    // A user with no team cannot run tenant operations at all.
    const admin = await signedIn('admin@example.com');
    const missing = await admin.bridge.call('team.projects.list').catch((e: unknown) => e);
    expect(missing).toBeInstanceOf(BridgeError);
    expect((missing as BridgeError).status).toBe(400);
    expect((missing as BridgeError).code).toBe('TENANT_REQUIRED');
  });

  it('replays an idempotent call and refuses a reused key with other input', async () => {
    await emptyCart(bob.bridge);
    const [product] = (await guest().call('products.list')).items;
    const key = `it-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    const first = await bob.bridge.callRaw(
      'cart.add',
      { product_id: product!.id, quantity: 2 },
      { idempotencyKey: key },
    );
    const again = await bob.bridge.callRaw(
      'cart.add',
      { product_id: product!.id, quantity: 2 },
      { idempotencyKey: key },
    );
    expect(first.meta.idempotent_replay).toBeFalsy();
    expect(again.meta.idempotent_replay).toBe(true);
    expect(again.data).toEqual(first.data);
    // The replay did not add a second time.
    expect((await bob.bridge.call('cart.show')).items.find((i) => i.product_id === product!.id)?.quantity).toBe(2);

    const reused = await bob.bridge
      .call('cart.add', { product_id: product!.id, quantity: 3 }, { idempotencyKey: key })
      .catch((e: unknown) => e);
    expect(reused).toBeInstanceOf(BridgeConflictError);
    expect((reused as BridgeError).code).toBe('IDEMPOTENCY_KEY_REUSED');
    await emptyCart(bob.bridge);
  });

  it("creates orders, refuses an empty cart and hides other users' orders", async () => {
    await emptyCart(alice.bridge);
    const empty = await alice.bridge.call('orders.create', {}).catch((e: unknown) => e);
    expect(empty).toBeInstanceOf(BridgeConflictError);
    expect((empty as BridgeError).code).toBe('CONFLICT');

    const [a, b] = (await guest().call('products.list')).items;
    await alice.bridge.call('cart.add', { product_id: a!.id, quantity: 1 });
    const cart = await alice.bridge.call('cart.add', { product_id: b!.id, quantity: 3 });
    expect(cart.items).toHaveLength(2);
    expect(cart.total).toMatch(/^\d+\.\d{2}$/);

    const order = await alice.bridge.call('orders.create', { note: 'Leave at the gate' }, { idempotencyKey: true });
    expect(order.status).toBe('pending');
    expect(order.items).toHaveLength(2);
    expect(order.total).toBe(cart.total);
    expect((await alice.bridge.call('cart.show')).items).toHaveLength(0);

    expect(await alice.bridge.call('orders.show', { id: order.id })).toEqual(order);
    await expect(bob.bridge.call('orders.show', { id: order.id })).rejects.toBeInstanceOf(BridgeNotFoundError);
  });

  it('uploads a file and downloads it back through the signed link', async () => {
    const avatar = new File([PNG_BYTES], 'avatar.png', { type: 'image/png' });
    const result = await alice.bridge.call('profile.avatar.upload', { avatar });
    expect(result.size).toBe(PNG_BYTES.byteLength);
    expect(result.mime).toBe('image/png');
    expect(result.download.url).toContain('/bridge/v1/files/');
    expect(Date.parse(result.download.expires_at)).toBeGreaterThan(Date.now());

    const response = await alice.bridge.download(result.download);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG_BYTES);
  });

  it('rejects an upload that is not an image', async () => {
    const avatar = new File(['not an image'], 'avatar.png', { type: 'image/png' });
    await expect(alice.bridge.call('profile.avatar.upload', { avatar })).rejects.toBeInstanceOf(BridgeValidationError);
  });
});
