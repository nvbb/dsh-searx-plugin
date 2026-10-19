import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { Context } from "@deepseek-ai/cordis";
import WebRuntime from "@deepseek-ai/dsh-web";
import { Config, apply, inject } from "../lib/index.js";

test("the real web seam selects searxng and enforces maxResults", async (t) => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      results: Array.from({ length: 12 }, (_, index) => ({
        url: `https://seam.example/${index}`,
        title: `result ${index}`,
        content: `snippet ${index}`,
      })),
    }));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(async () => {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  });
  const { port } = server.address();

  const ctx = new Context();
  await ctx.plugin(WebRuntime, { searchProvider: "searxng" });
  await ctx.plugin({ apply, Config, inject }, {
    baseURL: `http://127.0.0.1:${port}`,
  });
  try {
    const result = await ctx.web.search({ query: "seam", maxResults: 5 });
    assert.equal(result.sources.length, 5);
    assert.equal(result.truncated, true);
    assert.equal(result.sources[0].url, "https://seam.example/0");
  } finally {
    await ctx.fiber.dispose();
  }
});
