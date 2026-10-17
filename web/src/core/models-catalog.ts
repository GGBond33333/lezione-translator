// 翻译模型目录：模型 ID、优势说明、单价。价格变动时只改这个文件。
// 单价来源：Anthropic 官方 API 价格（美元 / 百万 token），2026-10。

export type OnlineModelId = "claude-haiku-5-5" | "claude-sonnet-5-5" | "claude-opus-5-5";
export type LiveModelChoice = OnlineModelId | "offline";

export interface ModelInfo {
  id: OnlineModelId;
  name: string;
  strengths: string;
  /** 每百万输入 token 的价格（美元） */
  inputPerM: number;
  /** 每百万输出 token 的价格（美元），思考 token 也按输出计费 */
  outputPerM: number;
  /** 实时翻译时每小时额外的思考 token（用于估算） */
  liveThinkingPerHour: number;
  recommendedFor?: "live" | "refine";
}

export const MODELS: Record<OnlineModelId, ModelInfo> = {
  "claude-haiku-5-5": {
    id: "claude-haiku-5-5",
    name: "Claude Haiku 5.5",
    strengths: "速度最快、价格极低；日常对话和课堂大意足够用",
    inputPerM: 0.1,
    outputPerM: 0.5,
    liveThinkingPerHour: 20_000,
    recommendedFor: "live",
  },
  "claude-sonnet-5-5": {
    id: "claude-sonnet-5-5",
    name: "Claude Sonnet 5.5",
    strengths: "专业术语、人名、作品名更准确，中文更通顺；性价比最高的高质量选项",
    inputPerM: 2,
    outputPerM: 10,
    // 实时翻译时用 between_tools 关闭思考
    liveThinkingPerHour: 0,
    recommendedFor: "refine",
  },
  "claude-opus-5-5": {
    id: "claude-opus-5-5",
    name: "Claude Opus 5.5",
    strengths: "质量最高，理解复杂长句、学术论述和文化背景最好；略慢",
    inputPerM: 4,
    outputPerM: 20,
    liveThinkingPerHour: 20_000,
  },
};

export const OFFLINE_INFO = {
  name: "离线模型（Whisper + Opus-MT）",
  strengths: "免费、没网也能用、隐私最好；但翻译生硬，专业术语经常出错",
};

export const MODEL_ORDER: OnlineModelId[] = ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"];

// —— 估算参数 ——
// 每小时约 600 句；每次请求约 500 token 输入（系统提示 + 句子 + 上下文）；每小时约 2 万 token 中文输出。
export const LIVE_INPUT_PER_HOUR = 300_000;
export const LIVE_OUTPUT_PER_HOUR = 20_000;
// 课后精修：3 小时课约 4 万 token 输入、7 万 token 输出
export const REFINE_INPUT_PER_HOUR = 40_000 / 3;
export const REFINE_OUTPUT_PER_HOUR = 70_000 / 3;

export function tokenCost(model: OnlineModelId, input: number, output: number): number {
  const m = MODELS[model];
  return (input * m.inputPerM + output * m.outputPerM) / 1_000_000;
}

export function estimateLivePerHour(model: LiveModelChoice): number {
  if (model === "offline") return 0;
  return tokenCost(model, LIVE_INPUT_PER_HOUR, LIVE_OUTPUT_PER_HOUR + MODELS[model].liveThinkingPerHour);
}

export function estimateRefine(model: OnlineModelId, hours: number): number {
  return tokenCost(model, REFINE_INPUT_PER_HOUR * hours, REFINE_OUTPUT_PER_HOUR * hours);
}

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

/** 根据 API 响应里的 usage 计算实际花费。缓存写入按 1.25 倍、缓存读取按 0.1 倍输入价计。 */
export function usageCost(model: string, usage: Usage): number {
  const m = MODELS[model as OnlineModelId] ?? MODELS["claude-opus-5-5"];
  const input =
    usage.input_tokens +
    (usage.cache_creation_input_tokens ?? 0) * 1.25 +
    (usage.cache_read_input_tokens ?? 0) * 0.1;
  return (input * m.inputPerM + usage.output_tokens * m.outputPerM) / 1_000_000;
}

export function formatUsd(v: number): string {
  if (v === 0) return "$0";
  if (v < 0.01) return "<$0.01";
  return `$${v < 1 ? v.toFixed(2) : v.toFixed(1)}`;
}
