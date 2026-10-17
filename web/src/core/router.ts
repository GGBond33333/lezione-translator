import type { LiveModelChoice, OnlineModelId } from "./models-catalog";
import type { NetMode } from "./settings";

export interface RouteInput {
  mode: NetMode;
  online: boolean;
  hasApiKey: boolean;
  offlineReady: boolean;
  webSpeech: boolean;
  liveModel: LiveModelChoice;
  /** 本节课已花费（美元） */
  spentUsd: number;
  /** 单节课费用上限，0 = 不限 */
  capUsd: number;
}

export type TranslatorRoute =
  | { engine: "claude"; model: OnlineModelId; downgraded: boolean }
  | { engine: "offline" }
  | { engine: "none"; reason: string };

export type RecognizerRoute = { engine: "webspeech" } | { engine: "whisper" } | { engine: "none"; reason: string };

/** 选择翻译引擎：联网优先，超出费用上限时先降到 Haiku，再降到离线 */
export function chooseTranslator(i: RouteInput): TranslatorRoute {
  const offline = (reason: string): TranslatorRoute =>
    i.offlineReady ? { engine: "offline" } : { engine: "none", reason };

  if (i.mode === "offline" || i.liveModel === "offline") return offline("还没有下载离线模型");
  if (!i.online) return offline("没有网络，也没有下载离线模型");
  if (!i.hasApiKey) {
    return i.mode === "online" ? { engine: "none", reason: "请先在设置里填写 API Key" } : offline("请先在设置里填写 API Key");
  }
  const overCap = i.capUsd > 0 && i.spentUsd >= i.capUsd;
  if (!overCap) return { engine: "claude", model: i.liveModel, downgraded: false };
  if (i.liveModel !== "claude-haiku-5-5") return { engine: "claude", model: "claude-haiku-5-5", downgraded: true };
  return offline("已超过本节课的费用上限");
}

/** 选择识别引擎：Safari 自带识别需要联网，离线时用 Whisper */
export function chooseRecognizer(i: Pick<RouteInput, "mode" | "online" | "offlineReady" | "webSpeech">): RecognizerRoute {
  const useWhisper = i.mode === "offline" || !i.online || !i.webSpeech;
  if (useWhisper) {
    if (i.offlineReady) return { engine: "whisper" };
    if (i.mode === "offline") return { engine: "none", reason: "请先在设置里下载离线模型" };
    if (!i.webSpeech) return { engine: "none", reason: "这个浏览器不支持语音识别，请下载离线模型" };
    // 显示为离线但浏览器识别可能仍可用（有些设备支持本机识别），先尝试
    return { engine: "webspeech" };
  }
  return { engine: "webspeech" };
}
