// 根据当前设置和网络状态组装识别器、翻译器
import { ClaudeTranslator } from "./claudeTranslator";
import { CloudRecognizer } from "./cloudRecognizer";
import { translatePair } from "./mlClient";
import type { LiveModelChoice, OnlineModelId } from "./models-catalog";
import { isOnline } from "./network";
import { OpusMtTranslator } from "./opusMtTranslator";
import type { Recognizer } from "./recognizer";
import { chooseRecognizer, chooseTranslator, type RecognizerRoute, type TranslatorRoute } from "./router";
import { getSettings } from "./settings";
import type { Translator } from "./translator";
import { WebSpeechRecognizer, webSpeechSupported } from "./webSpeechRecognizer";
import { WhisperRecognizer } from "./whisperRecognizer";

const claudeCache = new Map<string, ClaudeTranslator>();
let offlineTranslator: OpusMtTranslator | null = null;

export function claudeTranslator(model: OnlineModelId): ClaudeTranslator {
  const key = getSettings().apiKey;
  const id = `${model}|${key}`;
  let t = claudeCache.get(id);
  if (!t) {
    claudeCache.clear();
    t = new ClaudeTranslator(key, model);
    claudeCache.set(id, t);
  }
  return t;
}

export function offline(): Translator | null {
  if (!getSettings().offlineReady) return null;
  offlineTranslator ??= new OpusMtTranslator(translatePair);
  return offlineTranslator;
}

/** model 默认用课堂转写的实时模型；双语对话传入自己的模型 */
export function currentTranslatorRoute(spentUsd: number, model?: LiveModelChoice): TranslatorRoute {
  const s = getSettings();
  return chooseTranslator({
    mode: s.mode,
    online: isOnline(),
    hasApiKey: !!s.apiKey.trim(),
    offlineReady: s.offlineReady,
    webSpeech: webSpeechSupported(),
    liveModel: model ?? s.liveModel,
    spentUsd,
    capUsd: s.costCapUsd,
  });
}

export interface RecognizerContext {
  purpose: "lecture" | "conversation";
  /** 本节课已花费，用于判断是否超过费用上限 */
  spentUsd?: number;
  courseName?: string;
  /** 课程术语表的原文，作为云端识别的关键词 */
  keywords?: string[];
}

export function currentRecognizerRoute(c: RecognizerContext = { purpose: "lecture" }): RecognizerRoute {
  const s = getSettings();
  return chooseRecognizer({
    mode: s.mode,
    online: isOnline(),
    offlineReady: s.offlineReady,
    webSpeech: webSpeechSupported(),
    purpose: c.purpose,
    cloud: s.liveRecognizer === "cloud",
    hasOpenaiKey: !!s.openaiKey.trim(),
    overCap: s.costCapUsd > 0 && (c.spentUsd ?? 0) >= s.costCapUsd,
  });
}

export function createRecognizer(c: RecognizerContext): Recognizer | string {
  const r = currentRecognizerRoute(c);
  if (r.engine === "none") return r.reason;
  if (r.engine === "webspeech") return new WebSpeechRecognizer();
  if (r.engine === "whisper") return new WhisperRecognizer(c.purpose);
  const s = getSettings();
  return new CloudRecognizer({
    apiKey: s.openaiKey.trim(),
    keywords: c.keywords ?? [],
    courseName: c.courseName,
    offlineFallback: s.offlineReady,
  });
}
