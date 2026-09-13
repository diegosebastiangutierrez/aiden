/** Only an operator-configured HTTPS origin may be presented as an account portal.
 * A portal link is not proof of a signed-in local account or a paid entitlement. */
export function safeAccountPortal(value: unknown): string | null {
  if (typeof value !== 'string' || !value || value !== value.trim()) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
      || url.pathname !== '/' || url.origin === 'null' || /[\s\\]/.test(value)) return null;
    if (value !== url.origin && value !== `${url.origin}/`) return null;
    return url.origin;
  } catch { return null; }
}
