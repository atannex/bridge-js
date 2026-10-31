import { ref, shallowRef, type Ref } from 'vue';
import { createBridge, isValidationError, sanctumSession, type BridgeError } from '@atannex/bridge';
import { operations, type AppBridge, type Cart } from '../generated/bridge.js';

export const bridge = createBridge<AppBridge>({
  baseURL: 'https://api.example.com',
  operations,
  auth: sanctumSession(),
});

/** Adds to the cart and exposes loading, per-field errors and the result. */
export function useAddToCart(): {
  cart: Ref<Cart | undefined>;
  busy: Ref<boolean>;
  fieldErrors: Ref<Record<string, string[]>>;
  error: Ref<BridgeError | undefined>;
  add: (productId: number, quantity: number) => Promise<void>;
} {
  const cart = shallowRef<Cart>();
  const busy = ref(false);
  const fieldErrors = ref<Record<string, string[]>>({});
  const error = shallowRef<BridgeError>();

  async function add(productId: number, quantity: number): Promise<void> {
    busy.value = true;
    fieldErrors.value = {};
    error.value = undefined;
    try {
      cart.value = await bridge.call('cart.add', { product_id: productId, quantity }, { idempotencyKey: true });
    } catch (caught) {
      if (isValidationError(caught)) fieldErrors.value = caught.fields;
      else error.value = caught as BridgeError;
    } finally {
      busy.value = false;
    }
  }

  return { cart, busy, fieldErrors, error, add };
}
