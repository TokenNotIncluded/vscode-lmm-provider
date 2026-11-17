import { peekModelsDev, type ModelsDevCatalog } from "./models-dev-cache";
import { assert, record } from "./protocol";
import type { CatalogModel } from "./wire";

export interface ModelLimitOverride { contextWindow: number; maxOutputTokens: number }
export interface ReferenceModel {
  source: string; type: string; family: string | null;
  context: number | null; input: number | null; output: number | null;
  inputModalities: string[] | null; outputModalities: string[] | null;
  reasoning: boolean | null; toolCalling: boolean | null;
}

/** Public metadata is matched independently of the account's exact route identity. */
export function referenceMetadata(id: string, references: ModelsDevCatalog = peekModelsDev()): ReferenceModel | undefined {
  const row = references.resolve(id);
  if (!row) return undefined;
  return {
    source: row.source, type: row.type ?? "chat", family: null,
    context: row.limit.context > 0 ? row.limit.context : null,
    input: row.limit.input && row.limit.input > 0 ? row.limit.input : null,
    output: row.limit.output > 0 ? row.limit.output : null,
    inputModalities: row.modalities.input, outputModalities: row.modalities.output,
    reasoning: row.reasoning, toolCalling: row.tool_call,
  };
}
function textCapable(input: string[] | null | undefined, output: string[] | null | undefined): boolean {
  return (!input || input.includes("text")) && (!output || output.includes("text"));
}
export function isTextChatModel(id: string, references: ModelsDevCatalog = peekModelsDev()): boolean {
  const row = referenceMetadata(id, references);
  return !row || (row.type === "chat" && textCapable(row.inputModalities, row.outputModalities));
}
/** Only known transport/content limitations exclude a route; unknown metadata does not. */
export function chatUnsupportedReason(entry: CatalogModel, references: ModelsDevCatalog = peekModelsDev()): string | undefined {
  if (!entry.apis.includes("openai-completions")) return `Unsupported Chat API: ${entry.apis.join(", ")}`;
  const known = referenceMetadata(entry.upstream_model, references);
  if ((known && known.type !== "chat") || !textCapable(entry.metadata?.input_modalities ?? known?.inputModalities,
    entry.metadata?.output_modalities ?? known?.outputModalities))
    return "Unsupported Chat content: known non-text or non-chat model";
  return undefined;
}
/** Every authorized route is visible, including routes the Chat host cannot use. */
export function catalogItem(entry: CatalogModel) {
  const ratio = entry.groupMultiplier === null ? "倍率未知" : `${entry.groupMultiplier}×`;
  return {
    label: `${entry.group} / ${entry.name}`,
    description: `${entry.upstream_model} · ${ratio}`,
    detail: `${chatUnsupportedReason(entry) ?? "Supported in VS Code Chat (text input/output)"} · ${entry.metadata ? `Limits/capabilities: LMM server (${entry.metadata.source}); missing fields use models.dev when available` : referenceMetadata(entry.upstream_model) ? "Limits: cached models.dev reference (not gateway guarantee)" : "Limits/capabilities: unknown"} · ${pricingDetails(entry)} · APIs: ${entry.apis.join(", ")} · ${entry.id}`,
  };
}
export function toolCallingEnabled(entry: CatalogModel, models: readonly string[], references: ModelsDevCatalog = peekModelsDev()): boolean {
  if (chatUnsupportedReason(entry, references)) return false;
  if (entry.metadata?.tool_call !== null && entry.metadata?.tool_call !== undefined) return entry.metadata.tool_call;
  const known = referenceMetadata(entry.upstream_model, references);
  return known?.toolCalling === true || models.includes(entry.id) || models.includes(entry.upstream_model);
}

/** Server fields take priority; cached fuzzy references fill gaps, then labeled host defaults. */
export function modelMetadata(entry: CatalogModel, overrides: Record<string, ModelLimitOverride> = {}, inputCap?: number, outputCap = 4096, references: ModelsDevCatalog = peekModelsDev()) {
  assert(!chatUnsupportedReason(entry, references), "This LMM model is not a supported text chat model.");
  assert(Number.isSafeInteger(outputCap) && outputCap > 0 && outputCap <= 2000000, "Invalid lmm.maxOutputTokens setting.");
  assert(inputCap === undefined || (Number.isSafeInteger(inputCap) && inputCap > 0 && inputCap <= 2000000), "Invalid lmm.maxInputTokens setting.");
  const override = Object.hasOwn(overrides, entry.id) ? overrides[entry.id] :
    Object.hasOwn(overrides, entry.upstream_model) ? overrides[entry.upstream_model] : undefined;
  const known = referenceMetadata(entry.upstream_model, references);
  let contextWindow: number, output: number, upstreamInput = Infinity, source: string;
  if (override !== undefined) {
    const value = record(override);
    assert(Number.isSafeInteger(value.contextWindow) && value.contextWindow > 1 && value.contextWindow <= 2000000 &&
      Number.isSafeInteger(value.maxOutputTokens) && value.maxOutputTokens > 0 && value.maxOutputTokens < value.contextWindow,
      "Invalid lmm.modelLimits override.");
    contextWindow = value.contextWindow;
    output = value.maxOutputTokens;
    source = "user override";
  } else {
    const context = entry.metadata?.context_window ?? known?.context;
    const input = entry.metadata?.max_input_tokens ?? known?.input;
    const declaredOutput = entry.metadata?.max_output_tokens ?? known?.output;
    upstreamInput = input ?? Infinity;
    contextWindow = context ?? input ?? ((inputCap ?? 32768) + outputCap);
    output = declaredOutput ?? outputCap;
    const sources: string[] = [];
    if (entry.metadata) sources.push(`LMM server: ${entry.metadata.source}`);
    if (known) sources.push(`models.dev: ${known.source} (automatically cached; upstream reference, not gateway guarantee)`);
    if (!context && !input) sources.push("unknown model limits; compatibility estimate — configure lmm.modelLimits");
    source = sources.join("; ");
  }
  const maxOutputTokens = Math.min(output, outputCap, contextWindow - 1);
  const maxInputTokens = Math.min(contextWindow - maxOutputTokens, upstreamInput, inputCap ?? Infinity);
  const ratio = entry.groupMultiplier === null ? "倍率未知" : `${entry.groupMultiplier}×`;
  const reasoning = entry.metadata?.reasoning ?? known?.reasoning;
  const tools = entry.metadata?.tool_call ?? known?.toolCalling;
  const flag = (value: boolean | null | undefined) => value === true ? "yes" : value === false ? "no" : "unknown";
  const capabilities = reasoning === undefined && tools === undefined ? "Upstream capabilities unknown." : `Capabilities: reasoning ${flag(reasoning)}; tools ${flag(tools)}. Server values take priority over public references.`;
  return {
    name: `${entry.group} / ${entry.name} · ${ratio}`,
    detail: `${entry.group} · ${ratio}`,
    tooltip: `LMM · ${entry.group} · ${entry.upstream_model} · 分组倍率 ${ratio}\nContext: ${contextWindow.toLocaleString("en-US")} tokens; input budget: ${maxInputTokens.toLocaleString("en-US")}; output budget: ${maxOutputTokens.toLocaleString("en-US")}\n${source}\n${capabilities}\n${pricingDetails(entry)}\nInput reserves the configured output budget. Token counting is a conservative UTF-8 byte estimate, not an exact tokenizer. Usage is billed to your LMM wallet.`,
    maxInputTokens, maxOutputTokens,
  };
}

/** Server rates already include group/trust multipliers; null remains unknown. */
export function pricingDetails(entry: CatalogModel): string {
  const p = entry.pricing;
  if (!p) return 'Token pricing: unknown';
  const rate = (key: string) => typeof p[key] === 'number' && Number.isFinite(p[key]) ? String(p[key]) : 'unknown';
  return `Pricing: ${p.currency ?? 'unknown'}/${p.unit ?? 'unknown'} (${p.price_basis ?? 'unknown'}); input ${rate('input')}, output ${rate('output')}, cache read ${rate('cache_read')}, cache write ${rate('cache_write')}, request ${rate('request')}; group ×${rate('group_multiplier')}, trust ×${rate('trust_multiplier')} (already included)`;
}
