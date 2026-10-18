import Anthropic from "@anthropic-ai/sdk";
import { MODELS, usageCost, type OnlineModelId } from "./models-catalog";
import type { Lang } from "./languages";
import {
  conversationSystemPrompt,
  conversationUserMessage,
  liveSystemPrompt,
  type ConversationTurn,
  liveUserMessage,
  notesSystemPrompt,
  parseTagged,
  refineSystemPrompt,
} from "./prompts";
import type { TranslateContext, TranslateResult, Translator } from "./translator";

type CreateParams = Anthropic.Beta.MessageCreateParamsNonStreaming;

// Opus 和 Sonnet 支持服务端回退：模型拒答时自动换一个模型继续，翻译不会中断
const FALLBACK_MODELS = new Set<OnlineModelId>(["claude-opus-5-5", "claude-sonnet-5-5"]);

function makeClient(apiKey: string): Anthropic {
  // 纯前端应用，Key 只保存在用户自己的手机上
  return new Anthropic({ apiKey, dangerouslyAllowBrowser: true, maxRetries: 2, timeout: 60_000 });
}

/** 实时翻译：降低思考档位以减少延迟和费用 */
export function liveParams(model: OnlineModelId): Partial<CreateParams> {
  const p: Partial<CreateParams> = {};
  if (model === "claude-sonnet-5-5") p.thinking = { type: "between_tools" };
  else p.output_config = { effort: "low" };
  if (FALLBACK_MODELS.has(model)) {
    p.betas = ["server-side-fallback-2026-07-01"];
    p.fallbacks = "default";
  }
  return p;
}

function fallbackParams(model: OnlineModelId): Partial<CreateParams> {
  return FALLBACK_MODELS.has(model) ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" } : {};
}

function textOf(msg: Anthropic.Beta.BetaMessage): string {
  if (msg.stop_reason === "refusal") throw new Error("模型拒绝翻译这段内容");
  return msg.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
}

export class ClaudeTranslator implements Translator {
  readonly engine: string;
  private client: Anthropic;

  constructor(apiKey: string, private model: OnlineModelId) {
    this.client = makeClient(apiKey);
    this.engine = MODELS[model].name;
  }

  async translate(sentences: string[], ctx: TranslateContext): Promise<TranslateResult> {
    const msg = await this.client.beta.messages.create({
      model: this.model,
      max_tokens: 4000,
      system: [{ type: "text", text: liveSystemPrompt(ctx), cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: liveUserMessage(sentences, ctx.previous) }],
      ...liveParams(this.model),
    });
    return {
      translations: parseTagged(textOf(msg), sentences.length),
      costUsd: usageCost(msg.model, msg.usage),
      engine: this.engine,
    };
  }

  /** 双语对话：翻译一句话，附带前文聊天记录作为上下文 */
  async translateTurn(text: string, from: Lang, to: Lang, history: ConversationTurn[]): Promise<TranslateResult> {
    const msg = await this.client.beta.messages.create({
      model: this.model,
      max_tokens: 2000,
      system: [{ type: "text", text: conversationSystemPrompt(), cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: conversationUserMessage(text, from, to, history) }],
      ...liveParams(this.model),
    });
    return {
      translations: [textOf(msg).trim()],
      costUsd: usageCost(msg.model, msg.usage),
      engine: this.engine,
    };
  }

  /** 课后精修一段（几百句）：用流式请求避免长响应超时 */
  async refineChunk(sentences: string[], ctx: TranslateContext): Promise<TranslateResult> {
    const stream = this.client.beta.messages.stream({
      model: this.model,
      max_tokens: 64_000,
      system: [{ type: "text", text: refineSystemPrompt(ctx), cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: liveUserMessage(sentences) }],
      ...fallbackParams(this.model),
    });
    const msg = await stream.finalMessage();
    return {
      translations: parseTagged(textOf(msg), sentences.length),
      costUsd: usageCost(msg.model, msg.usage),
      engine: this.engine,
    };
  }

  async notes(transcript: string, ctx: TranslateContext): Promise<{ notes: string; costUsd: number }> {
    const stream = this.client.beta.messages.stream({
      model: this.model,
      max_tokens: 32_000,
      system: [{ type: "text", text: notesSystemPrompt(ctx), cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: transcript }],
      ...fallbackParams(this.model),
    });
    const msg = await stream.finalMessage();
    return { notes: textOf(msg), costUsd: usageCost(msg.model, msg.usage) };
  }
}

export function describeApiError(e: unknown): string {
  if (e instanceof Anthropic.AuthenticationError) return "API Key 无效，请在设置里检查";
  if (e instanceof Anthropic.PermissionDeniedError) return "这个 API Key 没有权限使用该模型";
  if (e instanceof Anthropic.RateLimitError) return "请求太频繁或额度不足，请稍后再试或检查账户余额";
  if (e instanceof Anthropic.APIConnectionError) return "网络连接失败";
  if (e instanceof Anthropic.APIError) return `翻译服务出错（${e.status ?? "未知"}）`;
  return e instanceof Error ? e.message : String(e);
}

/** 认证或权限错误重试也没用，不再排队 */
export function isPermanentApiError(e: unknown): boolean {
  return e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError || e instanceof Anthropic.BadRequestError;
}
