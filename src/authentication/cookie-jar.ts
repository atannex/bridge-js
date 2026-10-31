/**
 * Keeps cookies for one origin outside the browser.
 *
 * Browsers and React Native manage cookies themselves; Node's fetch does not.
 * Pass a jar to `sanctumSession` to run a cookie session from Node (tests,
 * scripts, server-side rendering on behalf of one user).
 */
export interface CookieJar {
  /** Records the `Set-Cookie` headers of a response. */
  store(headers: Headers): void;
  /** The `Cookie` header value to send, or undefined when empty. */
  header(): string | undefined;
  get(name: string): string | undefined;
  clear(): void;
}

interface StoredCookie {
  value: string;
  expires: number | undefined;
}

/** Splits a combined `Set-Cookie` header without breaking `Expires=Wed, 21 Oct ...` dates. */
export function splitSetCookie(combined: string): string[] {
  return combined
    .split(/,(?=\s*[^;,=\s]+=[^;]*)/)
    .map((part) => part.trim())
    .filter((part) => part !== '');
}

function setCookieHeaders(headers: Headers): string[] {
  const withGetter = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof withGetter.getSetCookie === 'function') {
    return withGetter.getSetCookie();
  }
  const combined = headers.get('set-cookie');
  return combined === null ? [] : splitSetCookie(combined);
}

/** A minimal in-memory jar: name/value pairs for a single origin, honouring `Max-Age` and `Expires`. */
export function memoryCookieJar(now: () => number = Date.now): CookieJar {
  const cookies = new Map<string, StoredCookie>();

  const live = (name: string): StoredCookie | undefined => {
    const cookie = cookies.get(name);
    if (cookie?.expires !== undefined && cookie.expires <= now()) {
      cookies.delete(name);
      return undefined;
    }
    return cookie;
  };

  return {
    store(headers) {
      for (const line of setCookieHeaders(headers)) {
        const [pair = '', ...attributes] = line.split(';');
        const index = pair.indexOf('=');
        if (index <= 0) continue;
        const name = pair.slice(0, index).trim();
        const value = pair.slice(index + 1).trim();
        let expires: number | undefined;
        for (const attribute of attributes) {
          const [key = '', ...rest] = attribute.split('=');
          const attrValue = rest.join('=').trim();
          const lower = key.trim().toLowerCase();
          if (lower === 'max-age' && /^-?\d+$/.test(attrValue)) {
            // Max-Age wins over Expires (RFC 6265, 5.3).
            expires = now() + Number(attrValue) * 1000;
            break;
          }
          if (lower === 'expires') {
            const date = Date.parse(attrValue);
            if (!Number.isNaN(date)) expires = date;
          }
        }
        if (expires !== undefined && expires <= now()) {
          cookies.delete(name);
        } else {
          cookies.set(name, { value, expires });
        }
      }
    },
    header() {
      const parts: string[] = [];
      for (const name of [...cookies.keys()]) {
        const cookie = live(name);
        if (cookie !== undefined) parts.push(`${name}=${cookie.value}`);
      }
      return parts.length === 0 ? undefined : parts.join('; ');
    },
    get(name) {
      return live(name)?.value;
    },
    clear() {
      cookies.clear();
    },
  };
}
