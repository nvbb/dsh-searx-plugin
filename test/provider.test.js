import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { Config, apply } from "../lib/index.js";
import {
  SearxngSearchProvider,
  buildSearchURL,
  mapSearxngPayload,
  normalizeBaseURL,
} from "../lib/provider.js";

/**
 * Start a local HTTP server on an ephemeral loopback port.
 * @param {(req: http.IncomingMessage, res: http.ServerResponse) => void} handler - request handler.
 * @returns {Promise<{server: http.Server, baseURL: string, requests: URL[], close: () => Promise<void>}>} server fixture.
 */
async function startServer(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    requests.push(url);
    handler(req, res, url);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const baseURL = `http://127.0.0.1:${address.port}`;
  return {
    server,
    baseURL,
    requests,
    close: async () => {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/**
 * Build provider options with test-safe defaults.
 * @param {string} baseURL - SearXNG base URL.
 * @param {object} [overrides] - option overrides.
 * @returns {object} provider options.
 */
function options(baseURL, overrides = {}) {
  return {
    baseURL,
    authHeader: "",
    language: "",
    categories: "",
    engines: "",
    timeRange: "",
    safesearch: -1,
    maxPages: 1,
    timeoutMs: 5000,
    cacheTtlMs: 0,
    includeAnswers: false,
    userAgent: "test-agent",
    ...overrides,
  };
}

/**
 * Create a provider around a fixed options object.
 * @param {object} resolved - provider options.
 * @returns {SearxngSearchProvider} provider.
 */
function providerFor(resolved) {
  return new SearxngSearchProvider(() => resolved);
}

const json = (res, body, status = 200) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

test("normalizeBaseURL accepts root, trailing slash and sub-path", () => {
  assert.equal(normalizeBaseURL("http://127.0.0.1:8080/").href, "http://127.0.0.1:8080/");
  assert.equal(normalizeBaseURL("https://search.example.com/searxng/").href, "https://search.example.com/searxng");
  assert.equal(normalizeBaseURL("  https://search.example.com  ").href, "https://search.example.com/");
});

test("normalizeBaseURL rejects values that cannot form a safe search endpoint", () => {
  assert.equal(normalizeBaseURL(""), undefined);
  assert.equal(normalizeBaseURL("localhost:8080"), undefined);
  assert.equal(normalizeBaseURL("ftp://search.example.com"), undefined);
  assert.equal(normalizeBaseURL("https://user:pass@search.example.com"), undefined);
  assert.equal(normalizeBaseURL("https://search.example.com/?a=1"), undefined);
  assert.equal(normalizeBaseURL("https://search.example.com/#x"), undefined);
});

test("buildSearchURL preserves the sub-path and encodes filters", () => {
  const url = buildSearchURL("https://search.example.com/searxng/", {
    query: "hello world",
    page: 2,
    language: "zh-CN",
    categories: "general",
    engines: "bing,duckduckgo",
    timeRange: "month",
    safesearch: 1,
  });
  assert.equal(url.origin, "https://search.example.com");
  assert.equal(url.pathname, "/searxng/search");
  assert.equal(url.searchParams.get("q"), "hello world");
  assert.equal(url.searchParams.get("format"), "json");
  assert.equal(url.searchParams.get("pageno"), "2");
  assert.equal(url.searchParams.get("language"), "zh-CN");
  assert.equal(url.searchParams.get("categories"), "general");
  assert.equal(url.searchParams.get("engines"), "bing,duckduckgo");
  assert.equal(url.searchParams.get("time_range"), "month");
  assert.equal(url.searchParams.get("safesearch"), "1");
});

test("mapSearxngPayload keeps valid sources, drops blanks and deduplicates", () => {
  const result = mapSearxngPayload({
    results: [
      { url: "https://a.example/x", title: " A ", content: " snippet ", publishedDate: "2026-01-01" },
      { url: "https://a.example/x", title: "duplicate" },
      { url: "", title: "missing url" },
      { url: "not a url", title: "invalid url" },
      { url: "javascript:alert(1)", title: "unsafe scheme" },
      { url: "mailto:user@example.com", title: "email" },
      { url: "https://b.example", title: "   ", content: "  " },
    ],
  });
  assert.equal(result.truncated, false);
  assert.deepEqual(result.sources, [
    {
      url: "https://a.example/x",
      title: "A",
      snippet: "snippet",
      publishedAt: "2026-01-01",
    },
    { url: "https://b.example/" },
  ]);
});

test("mapSearxngPayload rejects a non-result body", () => {
  assert.throws(
    () => mapSearxngPayload({ error: "nope" }),
    (error) => error.code === "WEB_PROVIDER_ERROR" && /results array/u.test(error.message),
  );
});

test("provider paginates, deduplicates and stops at maxResults", async (t) => {
  const fixture = await startServer((_req, res, url) => {
    const page = Number(url.searchParams.get("pageno"));
    json(res, page === 1
      ? {
          results: [
            { url: "https://a.example/1", title: "A1" },
            { url: "https://a.example/2", title: "A2" },
          ],
        }
      : {
          results: [
            { url: "https://a.example/2", title: "A2 duplicate" },
            { url: "https://a.example/3", title: "A3" },
          ],
        });
  });
  t.after(fixture.close);
  const provider = providerFor(options(fixture.baseURL, { maxPages: 2 }));
  const result = await provider.search({ query: "pagination", maxResults: 4 });
  assert.deepEqual(result.sources.map((source) => source.url), [
    "https://a.example/1",
    "https://a.example/2",
    "https://a.example/3",
  ]);
  assert.equal(fixture.requests.length, 2);
  assert.deepEqual(fixture.requests.map((url) => url.searchParams.get("pageno")), ["1", "2"]);
  assert.equal(fixture.requests[0].searchParams.get("q"), "pagination");
  assert.equal(fixture.requests[0].searchParams.get("format"), "json");
});

test("provider sends authHeader and configured filters", async (t) => {
  let seenAuthorization = "";
  const fixture = await startServer((req, res, url) => {
    seenAuthorization = req.headers.authorization ?? "";
    json(res, {
      results: [{ url: "https://a.example/1", title: `lang=${url.searchParams.get("language")}` }],
    });
  });
  t.after(fixture.close);
  const provider = providerFor(options(fixture.baseURL, {
    authHeader: "Bearer test-token",
    language: "zh-CN",
    categories: "general",
    engines: "bing",
    timeRange: "year",
    safesearch: 0,
  }));
  await provider.search({ query: "auth", maxResults: 1 });
  assert.equal(seenAuthorization, "Bearer test-token");
  const request = fixture.requests[0];
  assert.equal(request.searchParams.get("language"), "zh-CN");
  assert.equal(request.searchParams.get("categories"), "general");
  assert.equal(request.searchParams.get("engines"), "bing");
  assert.equal(request.searchParams.get("time_range"), "year");
  assert.equal(request.searchParams.get("safesearch"), "0");
});

test("provider caches non-empty results when cacheTtlMs is set", async (t) => {
  const fixture = await startServer((_req, res) => {
    json(res, { results: [{ url: "https://a.example/1", title: "cached" }] });
  });
  t.after(fixture.close);
  const provider = providerFor(options(fixture.baseURL, { cacheTtlMs: 60_000 }));
  const first = await provider.search({ query: "cache", maxResults: 1 });
  const second = await provider.search({ query: "cache", maxResults: 1 });
  assert.equal(fixture.requests.length, 1);
  assert.deepEqual(second, first);
});

test("provider maps HTTP 403 to an actionable JSON-format error", async (t) => {
  const fixture = await startServer((_req, res) => {
    res.writeHead(403, { "content-type": "text/plain" });
    res.end("Forbidden");
  });
  t.after(fixture.close);
  const provider = providerFor(options(fixture.baseURL));
  await assert.rejects(provider.search({ query: "denied", maxResults: 1 }), (error) => {
    assert.equal(error.code, "WEB_PROVIDER_ERROR");
    assert.match(error.message, /HTTP 403/u);
    assert.match(error.message, /search\.formats/u);
    return true;
  });
});

test("provider maps HTTP 429 to a rate-limit error", async (t) => {
  const fixture = await startServer((_req, res) => {
    res.writeHead(429, { "content-type": "text/plain" });
    res.end("Too Many Requests");
  });
  t.after(fixture.close);
  const provider = providerFor(options(fixture.baseURL));
  await assert.rejects(provider.search({ query: "limited", maxResults: 1 }), (error) => {
    assert.equal(error.code, "WEB_PROVIDER_ERROR");
    assert.match(error.message, /HTTP 429/u);
    assert.match(error.message, /rate-limited/u);
    return true;
  });
});

test("provider explains an HTML response as disabled JSON output", async (t) => {
  const fixture = await startServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<!doctype html><html><body>search</body></html>");
  });
  t.after(fixture.close);
  const provider = providerFor(options(fixture.baseURL));
  await assert.rejects(provider.search({ query: "html", maxResults: 1 }), (error) => {
    assert.equal(error.code, "WEB_PROVIDER_ERROR");
    assert.match(error.message, /non-JSON/u);
    assert.match(error.message, /search\.formats/u);
    return true;
  });
});

test("provider honors caller cancellation", async (t) => {
  const fixture = await startServer(() => {
    // Deliberately never respond; the caller aborts first.
  });
  t.after(fixture.close);
  const provider = providerFor(options(fixture.baseURL, { timeoutMs: 10_000 }));
  const controller = new AbortController();
  const pending = provider.search({ query: "abort", maxResults: 1 }, controller.signal);
  setTimeout(() => controller.abort(new Error("test abort")), 50);
  await assert.rejects(pending, (error) => {
    assert.equal(error.code, "WEB_ABORTED");
    return true;
  });
});

test("provider maps its own timeout to a provider error", async (t) => {
  const fixture = await startServer(() => {
    // Deliberately never respond.
  });
  t.after(fixture.close);
  const provider = providerFor(options(fixture.baseURL, { timeoutMs: 100 }));
  await assert.rejects(provider.search({ query: "timeout", maxResults: 1 }), (error) => {
    assert.equal(error.code, "WEB_PROVIDER_ERROR");
    assert.match(error.message, /timed out/u);
    return true;
  });
});

test("provider exposes SearXNG answers only when enabled", async (t) => {
  const fixture = await startServer((_req, res) => {
    json(res, {
      answers: ["42", { answer: "second answer" }, "   "],
      results: [{ url: "https://a.example/1", title: "answer" }],
    });
  });
  t.after(fixture.close);
  const off = providerFor(options(fixture.baseURL));
  assert.equal((await off.search({ query: "answer", maxResults: 1 })).content, undefined);

  const on = providerFor(options(fixture.baseURL, { includeAnswers: true, cacheTtlMs: 0 }));
  assert.equal((await on.search({ query: "answer", maxResults: 1 })).content, "42\n\nsecond answer");
});

test("available() is a local check and rejects unusable settings", () => {
  assert.equal(providerFor(options("")).available(), false);
  assert.equal(providerFor(options("not-a-url")).available(), false);
  assert.equal(providerFor(options("http://127.0.0.1:8080", { timeoutMs: 0 })).available(), false);
  assert.equal(providerFor(options("http://127.0.0.1:8080", { maxPages: 0 })).available(), false);
  assert.equal(providerFor(options("http://127.0.0.1:8080")).available(), true);
});

test("apply registers provider id searxng with schema defaults", async (t) => {
  const fixture = await startServer((_req, res) => {
    json(res, { results: [{ url: "https://a.example/plugin", title: "plugin" }] });
  });
  t.after(fixture.close);
  const config = Config({ baseURL: fixture.baseURL });
  let provider;
  apply({ web: { registerSearchProvider(candidate) { provider = candidate; } }, inject() {} }, config);
  assert.equal(provider.id, "searxng");
  assert.equal(provider.available(), true);
  const result = await provider.search({ query: "plugin", maxResults: 1 });
  assert.deepEqual(result.sources, [{ url: "https://a.example/plugin", title: "plugin" }]);
});

test("apply falls back to SEARXNG_BASE_URL when the setting is empty", async (t) => {
  const fixture = await startServer((_req, res) => {
    json(res, { results: [{ url: "https://a.example/env", title: "env" }] });
  });
  t.after(fixture.close);
  const previous = process.env.SEARXNG_BASE_URL;
  process.env.SEARXNG_BASE_URL = fixture.baseURL;
  try {
    const config = Config({});
    let provider;
    apply({ web: { registerSearchProvider(candidate) { provider = candidate; } }, inject() {} }, config);
    const result = await provider.search({ query: "env", maxResults: 1 });
    assert.equal(result.sources[0].url, "https://a.example/env");
  } finally {
    if (previous === undefined) delete process.env.SEARXNG_BASE_URL;
    else process.env.SEARXNG_BASE_URL = previous;
  }
});
