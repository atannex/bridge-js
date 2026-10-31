/** Joins a base URL and a path with exactly one slash between them. Absolute URLs pass through. */
export function joinUrl(base: string, path: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) {
    return path;
  }
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

/** The `scheme://host:port` part of an absolute URL, lower-cased, or undefined for relative ones. */
export function originOf(url: string): string | undefined {
  const match = /^([a-z][a-z0-9+.-]*:\/\/[^/?#]+)/i.exec(url);
  return match?.[1]?.toLowerCase();
}
