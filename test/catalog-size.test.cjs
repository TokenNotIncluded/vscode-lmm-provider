const { test } = require("node:test");
const assert = require("node:assert/strict");
const { jsonRequest } = require("../dist/auth");
test("full catalog responses exceed the old 4 MB cap without widening OAuth responses", async () => {
  const body = JSON.stringify({ models: [{ id: "future-route", description: "x".repeat(5_000_000) }] });
  const fetcher = async () => new Response(body, { headers: { "content-type": "application/json" } });
  assert.equal((await jsonRequest("/api/oauth2/catalog", {}, fetcher)).models.length, 1);
  await assert.rejects(jsonRequest("/.well-known/oauth-authorization-server", {}, fetcher), /too large/);
});
