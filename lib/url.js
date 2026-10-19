/**
 * Pure SearXNG URL construction helpers, shared by the provider and the
 * `npx` installer. No DSH imports, so the CLI can run without the host.
 *
 * @module dsh-web-search-searxng/url
 */

/**
 * Normalize a SearXNG base URL.
 *
 * Accepts an absolute HTTP(S) URL, including a reverse-proxy sub-path
 * (`https://example.com/searxng/`). Rejects credentials, query strings and
 * fragments so the only variable part is the path. A trailing slash is
 * removed; `buildSearchURL` appends `/search`.
 *
 * @param {unknown} raw - candidate base URL.
 * @returns {URL | undefined} normalized URL, or undefined when unusable.
 */
export function normalizeBaseURL(raw) {
  if (typeof raw !== "string") return undefined;
  const value = raw.trim();
  if (value.length === 0) return undefined;
  let url;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  if (url.username.length > 0 || url.password.length > 0) return undefined;
  if (url.search.length > 0 || url.hash.length > 0) return undefined;
  url.pathname = url.pathname.replace(/\/+$/u, "");
  return url;
}

/**
 * Build one SearXNG JSON search URL.
 *
 * @param {string | URL} baseURL - normalized or raw base URL.
 * @param {{query: string, page?: number, language?: string, categories?: string, engines?: string, timeRange?: string, safesearch?: number}} options - per-request filters.
 * @returns {URL} the request URL.
 */
export function buildSearchURL(baseURL, options) {
  const base = baseURL instanceof URL ? baseURL : normalizeBaseURL(baseURL);
  if (base === undefined) throw new Error("invalid SearXNG base URL");
  const url = new URL(base.href);
  url.pathname = `${url.pathname.replace(/\/+$/u, "")}/search`;
  url.searchParams.set("q", options.query);
  url.searchParams.set("format", "json");
  url.searchParams.set("pageno", String(options.page ?? 1));
  if (typeof options.language === "string" && options.language.length > 0) {
    url.searchParams.set("language", options.language);
  }
  if (typeof options.categories === "string" && options.categories.length > 0) {
    url.searchParams.set("categories", options.categories);
  }
  if (typeof options.engines === "string" && options.engines.length > 0) {
    url.searchParams.set("engines", options.engines);
  }
  if (typeof options.timeRange === "string" && options.timeRange.length > 0) {
    url.searchParams.set("time_range", options.timeRange);
  }
  if (Number.isInteger(options.safesearch) && options.safesearch >= 0) {
    url.searchParams.set("safesearch", String(options.safesearch));
  }
  return url;
}

