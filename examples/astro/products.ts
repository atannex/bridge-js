// Loaded by ProductGrid.astro as a client-side <script>. Astro bundles it with Vite.
import { createBridge, isBridgeError } from '@atannex/bridge';
import { operations, type AppBridge } from '../generated/bridge.js';

const bridge = createBridge<AppBridge>({ baseURL: 'https://api.example.com', operations });

export async function renderProducts(list: HTMLElement, page = 1): Promise<void> {
  list.setAttribute('aria-busy', 'true');
  try {
    const result = await bridge.call('products.list', { page });
    list.replaceChildren(
      ...result.items.map((product) => {
        const item = document.createElement('li');
        item.textContent = `${product.name} — ${product.price}`;
        return item;
      }),
    );
  } catch (error) {
    list.textContent = isBridgeError(error) ? error.message : 'Something went wrong.';
  } finally {
    list.removeAttribute('aria-busy');
  }
}
