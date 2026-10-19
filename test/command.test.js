import test from "node:test";
import assert from "node:assert/strict";
import { Config, apply } from "../lib/index.js";

/**
 * Minimal Cordis-like context with the two optional services used by the
 * command. configEditor.edit mimics the host editor: it replaces the entry's
 * config with the callback's result.
 */
function fakeContext(entries) {
  const byId = new Map(entries.map((entry) => [entry.options.id, entry]));
  const ctx = {
    web: { registerSearchProvider() {} },
    configEditor: {
      entries: () => [...byId.values()],
      async edit(entry, change) {
        entry.options.config = change(entry.options.config ?? {}, {});
      },
    },
    commands: {
      register(definition) {
        ctx.definition = definition;
        return () => {};
      },
    },
    inject(_services, callback) {
      callback(ctx);
    },
    effect(callback) {
      return callback();
    },
  };
  return ctx;
}

function fixture() {
  const provider = {
    options: {
      id: "web-search-searxng",
      config: { baseURL: "https://old.example/searxng", language: "zh-CN" },
    },
  };
  const web = {
    options: {
      id: "web",
      config: { searchProvider: "deepseek-search-api", fetchProvider: "deepseek-fetch-api" },
    },
  };
  const ctx = fakeContext([provider, web]);
  apply(ctx, Config({}));
  return { ctx, provider, web };
}

test("/searxng sets baseURL and selects the searxng provider", async () => {
  const { ctx, provider, web } = fixture();
  const result = await ctx.definition.handler({ rawInput: "https://search.example.com/searxng/" });
  assert.equal(result.kind, "success");
  assert.equal(provider.options.config.baseURL, "https://search.example.com/searxng");
  assert.equal(provider.options.config.language, "zh-CN");
  assert.equal(web.options.config.searchProvider, "searxng");
  assert.equal(web.options.config.fetchProvider, "deepseek-fetch-api");
  assert.match(result.text, /no restart needed/u);
});

test("/searxng status reports the active provider and URL", async () => {
  const { ctx } = fixture();
  await ctx.definition.handler({ rawInput: "https://search.example.com/searxng" });
  const status = await ctx.definition.handler({ rawInput: "status" });
  assert.equal(status.kind, "success");
  assert.match(status.text, /Provider: searxng/u);
  assert.match(status.text, /Base URL: https:\/\/search\.example\.com\/searxng/u);
});

test("/searxng rejects a non-http URL without changing configuration", async () => {
  const { ctx, provider, web } = fixture();
  const before = JSON.stringify(provider.options.config);
  const result = await ctx.definition.handler({ rawInput: "ftp://search.example.com" });
  assert.equal(result.kind, "error");
  assert.match(result.text, /Invalid URL/u);
  assert.equal(JSON.stringify(provider.options.config), before);
  assert.equal(web.options.config.searchProvider, "deepseek-search-api");
});

test("/searxng reset clears baseURL and restores deepseek-search-api", async () => {
  const { ctx, provider, web } = fixture();
  await ctx.definition.handler({ rawInput: "https://search.example.com/searxng" });
  const result = await ctx.definition.handler({ rawInput: "reset" });
  assert.equal(result.kind, "success");
  assert.equal(provider.options.config.baseURL, undefined);
  assert.equal(web.options.config.searchProvider, "deepseek-search-api");
});
