// 云端语音识别：OpenAI 转写接口。浏览器直接调用，Key 只保存在本机。
// 价格来源：OpenAI 官方价格页（2026-11）。模型停用或改名时只改这个文件。

import type { Lang } from "./languages";

export const ASR_ENDPOINT = "https://api.openai.com/v1/audio/transcriptions";
export const ASR_MODEL = "gpt-transcribe";
export const ASR_NAME = "OpenAI gpt-transcribe";
/** 每分钟音频的价格（美元） */
export const ASR_USD_PER_MIN = 0.0045;
export const ASR_USD_PER_HOUR = ASR_USD_PER_MIN * 60;
const MAX_KEYWORDS = 50;
const TIMEOUT_MS = 30_000;

export function asrCost(seconds: number): number {
  return (seconds / 60) * ASR_USD_PER_MIN;
}

/** 关键词不能换行、不能含 < >，否则整个请求会被拒绝；去重并限制数量 */
export function cleanKeywords(list: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list) {
    const k = raw.replace(/[<>\r\n]/g, " ").replace(/\s+/g, " ").trim();
    if (!k || k.length > 100 || seen.has(k.toLowerCase())) continue;
    seen.add(k.toLowerCase());
    out.push(k);
    if (out.length >= MAX_KEYWORDS) break;
  }
  return out;
}

export interface AsrRequest {
  wav: ArrayBuffer;
  lang: Lang;
  keywords: string[];
  prompt: string;
}

export function buildTranscribeForm(r: AsrRequest): FormData {
  const fd = new FormData();
  fd.append("model", ASR_MODEL);
  fd.append("file", new Blob([r.wav], { type: "audio/wav" }), "segment.wav");
  fd.append("languages[]", r.lang === "zh" ? "zh" : "it");
  for (const k of cleanKeywords(r.keywords)) fd.append("keywords[]", k);
  if (r.prompt.trim()) fd.append("prompt", r.prompt.trim().slice(0, 800));
  return fd;
}

export class AsrError extends Error {
  constructor(
    message: string,
    /** HTTP 状态码；0 表示网络错误或被浏览器拦截 */
    readonly status: number,
  ) {
    super(message);
  }
  /** Key 错误、余额不足、参数错误等，重试也没用 */
  get permanent(): boolean {
    return this.status === 400 || this.status === 401 || this.status === 403 || this.status === 404;
  }
}

function describeStatus(status: number, detail: string): string {
  if (status === 401) return "OpenAI Key 无效或已删除";
  if (status === 403) return "OpenAI Key 没有权限使用语音识别";
  if (status === 404) return `识别模型 ${ASR_MODEL} 不可用（可能已停用，需要更新）`;
  if (status === 429) return detail.includes("quota") ? "OpenAI 账户余额不足" : "请求太频繁，稍后重试";
  if (status >= 500) return "OpenAI 服务暂时出错";
  return detail || `HTTP ${status}`;
}

export async function transcribeCloud(key: string, r: AsrRequest, fetchImpl: typeof fetch = fetch): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetchImpl(ASR_ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}` },
      body: buildTranscribeForm(r),
      signal: ctrl.signal,
    });
  } catch (e) {
    throw new AsrError(ctrl.signal.aborted ? "识别超时" : `网络错误：${e instanceof Error ? e.message : e}`, 0);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    let detail = "";
    try {
      detail = ((await res.json()) as { error?: { message?: string } }).error?.message ?? "";
    } catch {
      // 不是 JSON
    }
    throw new AsrError(describeStatus(res.status, detail), res.status);
  }
  const data = (await res.json()) as { text?: string };
  return (data.text ?? "").trim();
}

/** 设置页"测试 Key"：查询模型列表，只读，不产生费用 */
export async function testOpenAIKey(key: string, fetchImpl: typeof fetch = fetch): Promise<"ok" | "invalid" | "network"> {
  try {
    const res = await fetchImpl("https://api.openai.com/v1/models", { headers: { Authorization: `Bearer ${key}` } });
    if (res.ok) return "ok";
    return res.status === 401 || res.status === 403 ? "invalid" : "network";
  } catch {
    return "network";
  }
}
