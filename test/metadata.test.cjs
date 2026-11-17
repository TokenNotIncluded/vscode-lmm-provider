const { test } = require("node:test");
const assert = require("node:assert/strict");
const metadataApi = require("../dist/metadata");
const { catalogItem } = metadataApi;
const { ModelsDevCatalog } = require("../dist/models-dev-cache");
const profile = (id, context, output, extra = {}) => ({ id, name: id, limit: { context, output }, modalities: { input: ["text"], output: ["text"] }, reasoning: true, tool_call: true, ...extra });
const nonChatIds = ["text-embedding-3-large", "text-embedding-3-small", "gemini-embedding-001", "gemini-embedding-2", "gpt-image-2", "dall-e-3", "whisper-1", "tts-1", "rerank-v3.5", "gemini-3-pro-image", "lyria-3-clip-preview", "mistral-embed"];
const references = new ModelsDevCatalog({ openai: { id: "openai", models: {
  "gpt-4o": profile("gpt-4o", 128000, 16384),
  "gpt-5": profile("gpt-5", 400000, 128000, { limit: { context: 400000, input: 272000, output: 128000 } }),
  "gpt-6.1-sol": profile("gpt-6.1-sol", 1050000, 128000, { limit: { context: 1050000, input: 922000, output: 128000 } }),
  ...Object.fromEntries(nonChatIds.map(id => [id, profile(id, 8192, 0, { modalities: { input: ["text"], output: ["image"] }, tool_call: false })])),
} }, anthropic: { id: "anthropic", models: { "claude-sonnet-4-5": profile("claude-sonnet-4-5", 200000, 64000) } } });
const modelMetadata = (entry, overrides, input, output) => metadataApi.modelMetadata(entry, overrides, input, output, references);
const referenceMetadata = (id, catalog = references) => metadataApi.referenceMetadata(id, catalog);
const isTextChatModel = id => metadataApi.isTextChatModel(id, references);
const toolCallingEnabled = (entry, models) => metadataApi.toolCallingEnabled(entry, models, references);
const chatUnsupportedReason = entry => metadataApi.chatUnsupportedReason(entry, references);
const { balanceLabel } = require("../dist/balance");
const { catalogModels } = require("../dist/wire");
const { RESOURCE } = require("../dist/protocol");
const entry = (group = "default", model = "gpt-4o", ratio = 0.5) => ({
  id: `lmm:${Buffer.from(group).toString("base64url")}:${Buffer.from(model).toString("base64url")}`,
  group_id: Buffer.from(group).toString("base64url"), group, upstream_model: model, name: model,
  groupMultiplier: ratio, apis: ["openai-completions"],
});
test("known context is model-specific, reserves output, and labels source", () => {
  const info = modelMetadata(entry());
  assert.equal(info.maxInputTokens, 128000 - 4096);
  assert.equal(info.maxOutputTokens, 4096);
  assert.match(info.tooltip, /models.dev: https:\/\/models.dev\//);
  assert.match(info.tooltip, /not gateway guarantee/);
  assert.notEqual(modelMetadata(entry("default", "claude-sonnet-4-5")).maxInputTokens, info.maxInputTokens);
});
test("groups and zero multipliers remain distinct, unknown is not free", () => {
  assert.notEqual(modelMetadata(entry()).name, modelMetadata(entry("other")).name);
  assert.match(modelMetadata(entry("default", "gpt-4o", 0)).name, /0×/);
  assert.match(modelMetadata(entry("default", "gpt-4o", null)).name, /倍率未知/);
});
test("exact wire override beats upstream override; caps cannot exceed context", () => {
  const e = entry();
  const info = modelMetadata(e, { "gpt-4o": { contextWindow: 10000, maxOutputTokens: 2000 }, [e.id]: { contextWindow: 8000, maxOutputTokens: 1000 } }, 9000, 4096);
  assert.equal(info.maxInputTokens, 7000);
  assert.equal(info.maxOutputTokens, 1000);
  assert.equal(modelMetadata(e, {}, 5000).maxInputTokens, 5000);
  assert.throws(() => modelMetadata(e, { "gpt-4o": { contextWindow: 1000, maxOutputTokens: 1000 } }));
  assert.throws(() => modelMetadata(e, {}, undefined, NaN));
});
test("unknown aliases use explicitly labeled compatibility estimates", () => {
  const info = modelMetadata(entry("default", "unlisted-private-model"));
  assert.equal(info.maxInputTokens, 32768);
  assert.match(info.tooltip, /unknown model limits; compatibility estimate/);
  assert.match(modelMetadata(entry("default", "__proto__")).tooltip, /unknown/);
});
test("independent upstream input limit and provider-qualified exact IDs are honored", () => {
  assert.equal(modelMetadata(entry("default", "gpt-5")).maxInputTokens, 272000);
  assert.equal(modelMetadata(entry("default", "openai/gpt-5")).maxInputTokens, 272000);
  assert.equal(modelMetadata(entry("default", "gpt-6.1-sol")).maxInputTokens, 922000);
  assert.equal(modelMetadata(entry("default", "gpt-5"), {}, 20000).maxInputTokens, 20000);
  assert.match(modelMetadata(entry("default", "gpt-5")).tooltip, /reasoning yes; tools yes/);
  assert.match(modelMetadata(entry("default", "unknown")).tooltip, /capabilities unknown/);
});
test("conflicting provider metadata is unknown unless provider is explicit", () => {
  const models = new ModelsDevCatalog({
    one: { id: "one", models: { duplicate: profile("duplicate", 128000, 4096) } },
    two: { id: "two", models: { duplicate: profile("duplicate", 4096, 1024) } },
  });
  assert.equal(referenceMetadata("duplicate", models), undefined);
  assert.equal(referenceMetadata("one/duplicate", models).context, 128000);
  assert.equal(referenceMetadata("two/duplicate", models).context, 4096);
});
test("known non-chat entries stay excluded despite configuration overrides", () => {
  for (const id of ["text-embedding-3-large", "text-embedding-3-small", "gemini-embedding-001", "gemini-embedding-2", "gpt-image-2", "dall-e-3", "whisper-1", "tts-1", "rerank-v3.5", "gemini-3-pro-image", "lyria-3-clip-preview", "mistral-embed"]) {
    assert.equal(isTextChatModel(id), false, id);
    assert.throws(() => modelMetadata(entry("default", id), { [id]: { contextWindow: 8192, maxOutputTokens: 1024 } }), id);
    assert.equal(toolCallingEnabled(entry("default", id), [id]), false, id);
  }
  assert.equal(isTextChatModel("my-private-chat-alias"), true);
});
test("wire-specific tool verification does not enable another group's route", () => {
  const a = entry("first", "unlisted-tool-model"), b = entry("second", "unlisted-tool-model");
  assert.equal(toolCallingEnabled(a, [a.id]), true);
  assert.equal(toolCallingEnabled(b, [a.id]), false);
  assert.equal(toolCallingEnabled(b, [a.upstream_model]), true);
  assert.equal(toolCallingEnabled(a, []), false);
});
test("catalog reads per-model effective ratio or legacy group ratio, binds granted groups", () => {
  const e = entry();
  const group = { id: e.group_id, name: e.group, scope: `group:${e.group_id}`, multiplier: 2 };
  const m = { ...e, apis: ["openai-completions"], pricing: { group_multiplier: 0.25 } };
  const body = { schema_version: 1, resource: RESOURCE, groups: [group], models: [m] };
  assert.equal(catalogModels(body, group.scope)[0].groupMultiplier, 0.25);
  delete m.pricing;
  assert.equal(catalogModels(body, group.scope)[0].groupMultiplier, 2);
  m.pricing = { group_multiplier: null };
  assert.equal(catalogModels(body, group.scope)[0].groupMultiplier, null);
  m.pricing.group_multiplier = -1;
  assert.throws(() => catalogModels(body, group.scope));
  delete m.pricing;
  assert.throws(() => catalogModels({ ...body, groups: [group, group] }, group.scope));
  assert.throws(() => catalogModels(body, "group:other"));
});
test("catalog validates every route and retains unsupported APIs for discovery", () => {
  const e = entry(), group = { id: e.group_id, name: e.group, scope: `group:${e.group_id}`, multiplier: 2 };
  const m = { ...e, apis: ["openai-completions"] };
  const body = { schema_version: 1, resource: RESOURCE, groups: [group], models: [m] };
  for (const invalid of [null, {}, { ...m, apis: [] }, { ...m, apis: [1] }, { ...m, apis: ["anthropic-messages"] }])
    assert.throws(() => catalogModels({ ...body, models: [m, invalid] }, group.scope)); // duplicate IDs also fail
  const unsupported = { ...entry("default", "messages-only"), apis: ["anthropic-messages"] };
  const routes = catalogModels({ ...body, models: [m, unsupported] }, group.scope);
  assert.equal(routes.length, 2);
  assert.match(catalogItem(routes[1]).detail, /Unsupported Chat API: anthropic-messages/);
  assert.match(catalogItem(routes[1]).detail, /Limits\/capabilities: unknown/);
  assert.throws(() => catalogModels({ ...body, models: [unsupported] }, "group:other"));
  assert.throws(() => catalogModels({ ...body, groups: [{ ...group, name: "" }] }, group.scope));
});
test("catalog preserves server labels, group identity and explicit limitations", () => {
  const a = { ...entry("first", "private-alias", null), name: "Reviewed server label" };
  const b = { ...entry("second", "private-alias", 0), name: a.name };
  assert.equal(catalogItem(a).label, "first / Reviewed server label");
  assert.match(catalogItem(a).description, /private-alias · 倍率未知/);
  assert.match(catalogItem(a).detail, /Limits\/capabilities: unknown/);
  assert.notEqual(catalogItem(a).label, catalogItem(b).label);
  assert.match(catalogItem(b).description, /0×/);
  assert.match(modelMetadata(a).name, /Reviewed server label/);
  assert.match(chatUnsupportedReason(entry("first", "text-embedding-3-small")), /non-text or non-chat/);
});
const wallet = () => ({ schema_version: 2, currency: "USD", quota: 500000, quota_per_unit: 500000, balance: 1, updated_at: 1,
  authorization_limit: null, credit_unit: 1, credits_per_usd: "500000", public_credit_balance: "500000" });
test("wallet validates USD basis and never equates credits with dollars", () => {
  assert.equal(balanceLabel(wallet()), "1 USD · 500,000 平台额度");
  assert.equal(balanceLabel({ schema_version: 1, currency: "USD", quota: 500000, quota_per_unit: 500000, balance: 1, updated_at: 1, authorization_limit: null }), "1 平台额度（旧版单位）");
  for (const patch of [{ balance: 2 }, { public_credit_balance: "1" }, { credits_per_usd: "0" }, { authorization_limit: 1 }, { quota_unit: "USD" }, { updated_at: NaN }, { quota_per_unit: Number.MIN_VALUE }, { currency: "CNY" }])
    assert.throws(() => balanceLabel({ ...wallet(), ...patch }));
  assert.equal(balanceLabel({ ...wallet(), quota: -500000, public_credit_balance: "-500000", balance: -1 }), "-1 USD · -500,000 平台额度");
});
test("wallet retains every digit of safe integer credit balances", () => {
  for (const [quota, formatted] of [
    [1234567890123, "1,234,567,890,123"],
    [-1234567890123, "-1,234,567,890,123"],
    [Number.MAX_SAFE_INTEGER, "9,007,199,254,740,991"],
    [-Number.MAX_SAFE_INTEGER, "-9,007,199,254,740,991"],
  ]) {
    const value = balanceLabel({ ...wallet(), quota, public_credit_balance: String(quota), balance: quota / 500000 });
    assert.ok(value.endsWith(` USD · ${formatted} 平台额度`), value);
  }
});

test('server metadata updates unseen model limits and pricing without a bundled entry', () => {
  const e = {...entry('default','future-private-model'), metadata: {context_window:128000,max_input_tokens:100000,max_output_tokens:16000,
    input_modalities:['text'],output_modalities:['text'],reasoning:true,tool_call:true,source:'server'},
    pricing:{currency:'USD',unit:'million_tokens',price_basis:'effective_user_rates',input:1,output:2,cache_read:null,cache_write:null,group_multiplier:2,trust_multiplier:0.5}};
  const info = modelMetadata(e);
  assert.equal(info.maxInputTokens, 100000);
  assert.equal(toolCallingEnabled(e,[]), true);
  assert.match(info.tooltip,/input 1, output 2, cache read unknown/);
  assert.match(info.tooltip,/LMM server: server/);
  assert.equal(modelMetadata({...e,metadata:{...e.metadata,context_window:64000}}).maxInputTokens,59904);
  assert.equal(modelMetadata({...e,metadata:{...e.metadata,context_window:null,max_input_tokens:null}}).maxInputTokens, 32768);
  assert.equal(chatUnsupportedReason({...e,metadata:{...e.metadata,output_modalities:['image']}}),'Unsupported Chat content: known non-text or non-chat model');
});


test("fuzzy cached metadata covers prefixed/punctuated IDs while server fields retain authority", () => {
  const e = entry("default", "gateway/GPT_4O");
  assert.equal(modelMetadata(e).maxInputTokens, 128000 - 4096);
  assert.equal(toolCallingEnabled(e, []), true);
  const changed = { ...e, metadata: { context_window: 64000, max_input_tokens: null, max_output_tokens: null,
    input_modalities: null, output_modalities: null, reasoning: null, tool_call: false, source: "server" } };
  assert.equal(modelMetadata(changed).maxInputTokens, 64000 - 4096);
  assert.equal(toolCallingEnabled(changed, [changed.id]), false);
  assert.equal(chatUnsupportedReason(changed), undefined);
});
test("known text and audio output remains usable as text chat", () => {
  const e = { ...entry("default", "multimodal-private"), metadata: { context_window: 32000, max_input_tokens: null, max_output_tokens: null,
    input_modalities: ["text", "image"], output_modalities: ["text", "audio"], reasoning: false, tool_call: true, source: "server" } };
  assert.equal(chatUnsupportedReason(e), undefined);
  assert.equal(toolCallingEnabled(e, []), true);
});

test("declared non-chat types with text output cannot enter the Chat picker", () => {
  for (const type of ["embedding", "reranking", "transcription"]) {
    const catalog = new ModelsDevCatalog({ custom: { id: "custom", models: { future: profile("future", 128000, 4096, { type }) } } });
    const e = entry("default", "CUSTOM/FUTURE");
    assert.equal(metadataApi.isTextChatModel(e.upstream_model, catalog), false, type);
    assert.match(metadataApi.chatUnsupportedReason(e, catalog), /non-text or non-chat/, type);
    assert.equal(metadataApi.toolCallingEnabled(e, [e.id], catalog), false, type);
  }
});

test("public zero limits use documented budgets without losing the authorized route", () => {
  const catalog = new ModelsDevCatalog({ custom: { id: "custom", models: { future: profile("future", 0, 0) } } });
  const e = entry("default", "custom/future");
  const info = metadataApi.modelMetadata(e, {}, undefined, 4096, catalog);
  assert.equal(info.maxInputTokens, 32768);
  assert.equal(info.maxOutputTokens, 4096);
  assert.equal(metadataApi.chatUnsupportedReason(e, catalog), undefined);
});
