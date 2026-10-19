/**
 * Cordis plugin entry for the SearXNG search provider.
 *
 * Registers provider id `searxng` into the DSH web capability seam
 * (`ctx.web`) and, when the interactive services exist, a `/searxng`
 * command that edits the live profile configuration through
 * `ctx.configEditor` — no hand-editing cordis.patch.yml.
 *
 * @module dsh-web-search-searxng
 */
import z from "@deepseek-ai/schemastery";
import {
  DEFAULT_MAX_PAGES,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_USER_AGENT,
  SearxngSearchProvider,
  normalizeBaseURL,
} from "./provider.js";

/** Cordis plugin name used by loader diagnostics. */
export const name = "web-search-searxng";

/** The web seam this provider registers into. */
export const inject = ["web"];

/**
 * Plugin settings. Every field is volatile so a saved settings change applies
 * to the next search without remounting the provider.
 */
export const Config = z.object({
  /** SearXNG base URL, including any reverse-proxy sub-path. Empty = `$SEARXNG_BASE_URL`. */
  baseURL: z.string().default("").volatile(),
  /** Optional raw `Authorization` header for a protected instance. */
  authHeader: z.string().role("secret").default("").volatile(),
  /** SearXNG `language` parameter, e.g. `zh-CN`. Empty = instance default. */
  language: z.string().default("").volatile(),
  /** Comma-separated SearXNG categories. Empty = instance default. */
  categories: z.string().default("").volatile(),
  /** Comma-separated engine allowlist. Empty = instance default. */
  engines: z.string().default("").volatile(),
  /** SearXNG `time_range`: `day`, `month`, or `year`. Empty = no range. */
  timeRange: z.string().default("").volatile(),
  /** SearXNG `safesearch`: 0, 1, 2; -1 omits the parameter. */
  safesearch: z.number().step(1).min(-1).max(2).default(-1).volatile(),
  /** Result pages to request when one page cannot satisfy `maxResults` (1-5). */
  maxPages: z.number().step(1).min(1).max(5).default(DEFAULT_MAX_PAGES).volatile(),
  /** Per-request HTTP timeout in milliseconds (1000-60000). */
  timeoutMs: z.number().step(1).min(1000).max(60000).default(DEFAULT_TIMEOUT_MS).volatile(),
  /** In-process result cache TTL in milliseconds; 0 disables caching. */
  cacheTtlMs: z.number().step(1).min(0).default(0).volatile(),
  /** Expose SearXNG `answers` as provider answer text (off by default). */
  includeAnswers: z.boolean().default(false).volatile(),
  /** HTTP User-Agent sent to SearXNG. */
  userAgent: z.string().default(DEFAULT_USER_AGENT).volatile(),
});

/**
 * Read a volatile settings accessor or a plain value.
 * @param {unknown} value - settings field or accessor.
 * @returns {any} current value.
 */
function read(value) {
  return value !== null && typeof value === "object" && typeof value.get === "function"
    ? value.get()
    : value;
}

/**
 * Project the live settings section into the provider's per-search options.
 * Environment fallbacks stay here so the provider reads fully defaulted values.
 * @param {any} config - the plugin's settings section.
 * @returns {object} options for the next search.
 */
function resolveOptions(config) {
  const configuredBaseURL = String(read(config.baseURL) ?? "").trim();
  const envBaseURL = typeof process.env.SEARXNG_BASE_URL === "string"
    ? process.env.SEARXNG_BASE_URL.trim()
    : "";
  const configuredAuth = String(read(config.authHeader) ?? "").trim();
  const envAuth = typeof process.env.SEARXNG_AUTH_HEADER === "string"
    ? process.env.SEARXNG_AUTH_HEADER.trim()
    : "";
  return {
    baseURL: configuredBaseURL.length > 0 ? configuredBaseURL : envBaseURL,
    authHeader: configuredAuth.length > 0 ? configuredAuth : envAuth,
    language: String(read(config.language) ?? "").trim(),
    categories: String(read(config.categories) ?? "").trim(),
    engines: String(read(config.engines) ?? "").trim(),
    timeRange: String(read(config.timeRange) ?? "").trim(),
    safesearch: Number(read(config.safesearch)),
    maxPages: Number(read(config.maxPages)),
    timeoutMs: Number(read(config.timeoutMs)),
    cacheTtlMs: Number(read(config.cacheTtlMs)),
    includeAnswers: read(config.includeAnswers) === true,
    userAgent: String(read(config.userAgent) ?? "").trim(),
  };
}

/**
 * Read one loader entry's plain config object.
 * @param {{options?: {config?: unknown}} | undefined} entry - loader entry.
 * @returns {Record<string, unknown>} config object, or an empty object.
 */
function entryConfig(entry) {
  const value = entry?.options?.config;
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

/**
 * Re-find a profile entry after a config edit: reconciliation can replace the
 * entry object, so a previously captured reference may be stale.
 * @param {any} ctx - context carrying `configEditor`.
 * @param {string} id - loader entry id.
 * @returns {any} the current entry, or undefined.
 */
function findEntry(ctx, id) {
  return ctx.configEditor.entries().find((entry) => entry.options.id === id);
}

/** Render the current provider/base URL and command usage. */
function statusText(ctx) {
  const web = findEntry(ctx, "web");
  const provider = findEntry(ctx, "web-search-searxng");
  const selected = entryConfig(web).searchProvider;
  const baseURL = entryConfig(provider).baseURL;
  return [
    "SearXNG web search",
    `Provider: ${typeof selected === "string" && selected.length > 0 ? selected : "(unset)"}`,
    `Base URL: ${typeof baseURL === "string" && baseURL.length > 0 ? baseURL : "(unset)"}`,
    "Usage: /searxng <https://host/searxng> | /searxng status | /searxng reset",
  ].join("\n");
}

/**
 * Persist a new base URL and select the SearXNG provider. The write goes
 * through `configEditor`, so YAML comments are preserved and the running
 * provider's volatile `baseURL` updates immediately.
 * @param {any} ctx - context carrying `configEditor`.
 * @param {string} raw - user-supplied URL.
 * @returns {Promise<{kind: "success" | "error", text: string}>} command result.
 */
async function setBaseURL(ctx, raw) {
  const parsed = normalizeBaseURL(raw);
  if (parsed === undefined) {
    return {
      kind: "error",
      text: "Invalid URL. Use an absolute http(s) URL without credentials, a query string, or a fragment, e.g. https://search.example.com/searxng",
    };
  }
  const provider = findEntry(ctx, "web-search-searxng");
  if (provider === undefined) {
    return {
      kind: "error",
      text: "The web-search-searxng entry is not mounted in this profile; install the plugin and restart DSH.",
    };
  }
  try {
    await ctx.configEditor.edit(provider, (current) => ({ ...current, baseURL: parsed.href }));
    // The edit may replace loader entries during reconciliation; re-find the
    // web row instead of reusing an entry captured before the write.
    const web = findEntry(ctx, "web");
    if (web !== undefined) {
      await ctx.configEditor.edit(web, (current) => ({ ...current, searchProvider: "searxng" }));
    }
    return {
      kind: "success",
      text: `SearXNG URL set to ${parsed.href}\nProvider: searxng\nThe next web_search uses it; no restart needed.`,
    };
  } catch (error) {
    return {
      kind: "error",
      text: `Could not save the SearXNG URL: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Clear the configured URL and return web_search to the built-in DeepSeek
 * Search API selection.
 * @param {any} ctx - context carrying `configEditor`.
 * @returns {Promise<{kind: "success" | "error", text: string}>} command result.
 */
async function resetProvider(ctx) {
  const provider = findEntry(ctx, "web-search-searxng");
  if (provider === undefined) {
    return {
      kind: "error",
      text: "The web-search-searxng entry is not mounted in this profile.",
    };
  }
  try {
    await ctx.configEditor.edit(provider, (current) => {
      const next = { ...current };
      delete next.baseURL;
      return next;
    });
    const web = findEntry(ctx, "web");
    if (web !== undefined) {
      await ctx.configEditor.edit(web, (current) => ({ ...current, searchProvider: "deepseek-search-api" }));
    }
    return {
      kind: "success",
      text: "SearXNG URL cleared; web_search is back on deepseek-search-api.",
    };
  } catch (error) {
    return {
      kind: "error",
      text: `Could not reset the SearXNG configuration: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Register `/searxng` when the interactive services exist. Headless profiles
 * without `commands` or `configEditor` simply skip the command.
 * @param {any} ctx - child context carrying both services.
 */
function applyCommand(ctx) {
  ctx.effect(
    () => ctx.commands.register({
      name: "searxng",
      description: "Set or show the SearXNG base URL used by web_search",
      input: { hint: "<https://host/searxng> | status | reset" },
      handler: async (invocation) => {
        const raw = invocation.rawInput.trim();
        if (raw.length === 0 || raw.toLowerCase() === "status") {
          return { kind: "success", text: statusText(ctx) };
        }
        if (raw.toLowerCase() === "reset") return resetProvider(ctx);
        return setBaseURL(ctx, raw);
      },
    }),
    "web-search-searxng /searxng command",
  );
}

/**
 * Register the SearXNG search provider.
 * @param {any} ctx - Cordis context with the `web` service.
 * @param {any} config - the plugin's resolved settings section.
 */
export function apply(ctx, config) {
  const provider = new SearxngSearchProvider(() => resolveOptions(config));
  ctx.web.registerSearchProvider(provider);
  ctx.inject(["commands", "configEditor"], (child) => {
    applyCommand(child);
  });
}

export {
  DEFAULT_MAX_PAGES,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_USER_AGENT,
  SEARXNG_PROVIDER_ID,
  SearxngSearchProvider,
  buildSearchURL,
  mapSearxngPayload,
  normalizeBaseURL,
} from "./provider.js";
