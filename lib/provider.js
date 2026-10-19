/**
 * SearXNG-backed search provider for the DSH web capability seam (ctx.web).
 *
 * The provider only adapts the SearXNG JSON API to the seam's normalized
 * source vocabulary. Result-count policy stays in the seam: this provider
 * returns every source it mapped and reports `truncated: false`.
 *
 * @module dsh-web-search-searxng/provider
 */
import { WebError } from "@deepseek-ai/dsh-web";
import { buildSearchURL, normalizeBaseURL } from "./url.js";

/** Stable provider id registered with ctx.web. */
export const SEARXNG_PROVIDER_ID = "searxng";

/** Default upper bound for one HTTP request. */
export const DEFAULT_TIMEOUT_MS = 15_000;

/** Default number of SearXNG result pages to request when maxResults is larger than one page. */
export const DEFAULT_MAX_PAGES = 2;

/** Attribution header sent when the user does not override it. */
export const DEFAULT_USER_AGENT = "dsh-web-search-searxng/0.2";

/**
 * Map one SearXNG JSON payload to the seam's search-result shape.
 *
 * Only URL is required. Blank titles, snippets and dates are omitted rather
 * than fabricated; entries with an invalid or duplicate URL are dropped.
 *
 * @param {unknown} payload - parsed SearXNG response body.
 * @param {{includeAnswers?: boolean}} [options] - whether to expose SearXNG answers as `content`.
 * @returns {{content?: string, sources: Array<{url: string, title?: string, snippet?: string, publishedAt?: string}>, truncated: boolean}} normalized result.
 * @throws {WebError} when the response is not a SearXNG result object.
 */
export function mapSearxngPayload(payload, options = {}) {
  if (payload === null || typeof payload !== "object" || !Array.isArray(payload.results)) {
    throw new WebError(
      "SearXNG returned an unexpected JSON body: expected an object with a results array",
      "WEB_PROVIDER_ERROR",
    );
  }
  const seen = new Set();
  const sources = [];
  for (const item of payload.results) {
    if (item === null || typeof item !== "object") continue;
    const rawURL = typeof item.url === "string" ? item.url.trim() : "";
    if (rawURL.length === 0) continue;
    let parsedURL;
    try {
      parsedURL = new URL(rawURL);
    } catch {
      continue;
    }
    // A search result is a citation target, not an executable URL: only
    // HTTP(S) pages are safe to surface to the model.
    if (parsedURL.protocol !== "http:" && parsedURL.protocol !== "https:") continue;
    const normalizedURL = parsedURL.href;
    if (seen.has(normalizedURL)) continue;
    seen.add(normalizedURL);
    const title = typeof item.title === "string" ? item.title.trim() : "";
    const snippet = typeof item.content === "string" ? item.content.trim() : "";
    const publishedAt = typeof item.publishedDate === "string" ? item.publishedDate.trim() : "";
    sources.push({
      url: normalizedURL,
      ...(title.length > 0 ? { title } : {}),
      ...(snippet.length > 0 ? { snippet } : {}),
      ...(publishedAt.length > 0 ? { publishedAt } : {}),
    });
  }
  const answers = options.includeAnswers === true ? readAnswers(payload.answers) : [];
  return {
    ...(answers.length > 0 ? { content: answers.join("\n\n") } : {}),
    sources,
    truncated: false,
  };
}

/**
 * Read SearXNG's optional `answers` array, which can contain plain strings or
 * `{ answer: string }` objects depending on the engine and version.
 *
 * @param {unknown} value - raw answers array.
 * @returns {string[]} non-empty answers.
 */
function readAnswers(value) {
  if (!Array.isArray(value)) return [];
  const answers = [];
  for (const entry of value) {
    if (typeof entry === "string" && entry.trim().length > 0) {
      answers.push(entry.trim());
    } else if (
      entry !== null
      && typeof entry === "object"
      && typeof entry.answer === "string"
      && entry.answer.trim().length > 0
    ) {
      answers.push(entry.answer.trim());
    }
  }
  return answers;
}

/**
 * A search provider backed by one SearXNG instance.
 *
 * The constructor takes a thunk so settings changes apply to the next search
 * without re-registering the provider (and without a visible provider flicker).
 */
export class SearxngSearchProvider {
  /** @type {string} */
  id = SEARXNG_PROVIDER_ID;

  /**
   * @param {() => {baseURL: string, authHeader?: string, language?: string, categories?: string, engines?: string, timeRange?: string, safesearch?: number, maxPages?: number, timeoutMs?: number, cacheTtlMs?: number, includeAnswers?: boolean, userAgent?: string}} resolveOptions - reads the current settings snapshot.
   */
  constructor(resolveOptions) {
    this.resolveOptions = resolveOptions;
    /** @type {Map<string, {expiresAt: number, result: object}>} */
    this.cache = new Map();
  }

  /**
   * Cheap local usability check. Never performs a network request.
   * @returns {boolean} whether the current settings can issue a search.
   */
  available() {
    const options = this.resolveOptions();
    return normalizeBaseURL(options.baseURL) !== undefined
      && Number.isInteger(options.timeoutMs) && options.timeoutMs > 0
      && Number.isInteger(options.maxPages) && options.maxPages >= 1;
  }

  /**
   * Run one search, requesting additional pages until `maxResults` is met or
   * the configured page budget is exhausted.
   *
   * @param {{query: string, maxResults?: number}} request - seam search request.
   * @param {AbortSignal} [signal] - caller cancellation.
   * @returns {Promise<object>} normalized search result.
   */
  async search(request, signal) {
    const options = this.resolveOptions();
    const baseURL = normalizeBaseURL(options.baseURL);
    if (baseURL === undefined) {
      throw new WebError(
        "SearXNG is not configured: set web-search-searxng.baseURL or SEARXNG_BASE_URL to an absolute HTTP(S) URL",
        "WEB_PROVIDER_ERROR",
      );
    }
    const query = typeof request.query === "string" ? request.query.trim() : "";
    if (query.length === 0) {
      throw new WebError("SearXNG search query is empty", "WEB_PROVIDER_ERROR");
    }

    const maxResults = Number.isInteger(request.maxResults) && request.maxResults > 0
      ? request.maxResults
      : Infinity;
    const maxPages = Number.isInteger(options.maxPages) && options.maxPages > 0
      ? options.maxPages
      : 1;
    const cacheKey = JSON.stringify([
      baseURL.href,
      query,
      options.language ?? "",
      options.categories ?? "",
      options.engines ?? "",
      options.timeRange ?? "",
      options.safesearch ?? -1,
      maxPages,
      options.includeAnswers === true,
    ]);
    const cached = this.readCache(cacheKey, options.cacheTtlMs ?? 0);
    if (cached !== undefined) return cached;

    const sources = [];
    const seen = new Set();
    const answers = [];
    for (let page = 1; page <= maxPages; page += 1) {
      throwIfAborted(signal);
      const url = buildSearchURL(baseURL, {
        query,
        page,
        language: options.language,
        categories: options.categories,
        engines: options.engines,
        timeRange: options.timeRange,
        safesearch: options.safesearch,
      });
      const payload = await this.requestPage(url, options, signal);
      const mapped = mapSearxngPayload(payload, { includeAnswers: options.includeAnswers });
      if (mapped.content !== undefined) answers.push(mapped.content);

      let added = 0;
      for (const source of mapped.sources) {
        if (seen.has(source.url)) continue;
        seen.add(source.url);
        sources.push(source);
        added += 1;
      }
      if (sources.length >= maxResults) break;
      // An empty page, or a page that added nothing new, means pagination
      // cannot improve the result: stop instead of burning more requests.
      if (mapped.sources.length === 0 || added === 0) break;
    }

    const result = {
      ...(answers.length > 0 ? { content: answers.join("\n\n") } : {}),
      sources,
      truncated: false,
    };
    this.writeCache(cacheKey, result, options.cacheTtlMs ?? 0);
    return result;
  }

  /**
   * Read one cached result when its TTL is still valid.
   * @param {string} key - cache key.
   * @param {number} ttlMs - configured TTL; 0 disables the cache.
   * @returns {object | undefined} cached result, or undefined.
   */
  readCache(key, ttlMs) {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) return undefined;
    const entry = this.cache.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.cache.delete(key);
      return undefined;
    }
    return {
      ...entry.result,
      sources: entry.result.sources.map((source) => ({ ...source })),
    };
  }

  /**
   * Store a non-empty result. Empty results are deliberately not cached so a
   * transient upstream outage does not mask recovery for the whole TTL.
   * @param {string} key - cache key.
   * @param {object} result - normalized result.
   * @param {number} ttlMs - configured TTL; 0 disables the cache.
   */
  writeCache(key, result, ttlMs) {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0 || result.sources.length === 0) return;
    this.cache.set(key, { expiresAt: Date.now() + ttlMs, result });
    if (this.cache.size > 128) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
  }

  /**
   * Fetch and parse one SearXNG page.
   * @param {URL} url - request URL.
   * @param {object} options - current settings snapshot.
   * @param {AbortSignal} [signal] - caller cancellation.
   * @returns {Promise<unknown>} parsed JSON body.
   */
  async requestPage(url, options, signal) {
    const timeoutMs = Number.isInteger(options.timeoutMs) && options.timeoutMs > 0
      ? options.timeoutMs
      : DEFAULT_TIMEOUT_MS;
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const combined = signal === undefined ? timeoutSignal : AbortSignal.any([signal, timeoutSignal]);
    const headers = {
      accept: "application/json",
      "user-agent": typeof options.userAgent === "string" && options.userAgent.length > 0
        ? options.userAgent
        : DEFAULT_USER_AGENT,
    };
    if (typeof options.authHeader === "string" && options.authHeader.trim().length > 0) {
      headers.authorization = options.authHeader.trim();
    }

    let response;
    try {
      response = await fetch(url, {
        method: "GET",
        redirect: "follow",
        headers,
        signal: combined,
      });
    } catch (error) {
      throw transportError(error, signal, timeoutSignal, timeoutMs);
    }

    if (!response.ok) {
      // Read (and discard) a bounded amount so the connection can be reused;
      // the response body is untrusted and is never placed in the error text.
      try {
        await response.text();
      } catch {
        // The status code is the useful part; ignore a body-read failure.
      }
      throw httpStatusError(response.status, response.statusText, url);
    }

    let text;
    try {
      text = await response.text();
    } catch (error) {
      throw transportError(error, signal, timeoutSignal, timeoutMs);
    }
    try {
      return JSON.parse(text);
    } catch (error) {
      const hint = text.trimStart().startsWith("<")
        ? " The instance returned HTML; enable JSON output in settings.yml (search.formats must include json)."
        : "";
      throw new WebError(
        `SearXNG returned a non-JSON response (HTTP ${response.status}).${hint}`,
        "WEB_PROVIDER_ERROR",
        { cause: error },
      );
    }
  }
}

/** Throw the seam's cancellation error when the caller already aborted. */
function throwIfAborted(signal) {
  if (signal?.aborted === true) {
    throw new WebError("SearXNG search aborted", "WEB_ABORTED", { cause: signal.reason });
  }
}

/** Map a fetch/body-read failure to the seam's error vocabulary. */
function transportError(error, signal, timeoutSignal, timeoutMs) {
  if (signal?.aborted === true) {
    return new WebError("SearXNG search aborted", "WEB_ABORTED", { cause: signal.reason ?? error });
  }
  if (timeoutSignal.aborted === true) {
    return new WebError(
      `SearXNG request timed out after ${timeoutMs} ms`,
      "WEB_PROVIDER_ERROR",
      { cause: error },
    );
  }
  return new WebError(`SearXNG request failed: ${String(error)}`, "WEB_PROVIDER_ERROR", { cause: error });
}

/** Build an actionable error for a non-2xx SearXNG response. */
function httpStatusError(status, statusText, url) {
  const endpoint = `${url.origin}${url.pathname}`;
  const suffix = typeof statusText === "string" && statusText.length > 0 ? ` ${statusText}` : "";
  if (status === 403) {
    return new WebError(
      `SearXNG refused the request (HTTP 403${suffix}) at ${endpoint}. Enable JSON output in the instance's settings.yml (search.formats must include json) and check the instance limiter and reverse-proxy auth.`,
      "WEB_PROVIDER_ERROR",
    );
  }
  if (status === 429) {
    return new WebError(
      `SearXNG rate-limited the request (HTTP 429${suffix}) at ${endpoint}. Wait before retrying, or relax the instance limiter.`,
      "WEB_PROVIDER_ERROR",
    );
  }
  if (status === 401) {
    return new WebError(
      `SearXNG rejected the configured authHeader (HTTP 401${suffix}) at ${endpoint}.`,
      "WEB_PROVIDER_ERROR",
    );
  }
  return new WebError(
    `SearXNG returned HTTP ${status}${suffix} at ${endpoint}.`,
    "WEB_PROVIDER_ERROR",
  );
}

export { buildSearchURL, normalizeBaseURL } from "./url.js";
