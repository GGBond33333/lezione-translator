// 根据当前设置和网络状态组装识别器、翻译器
import { ClaudeTranslator } from "./claudeTranslator";
import { translatePair } from "./mlClient";
import type { OnlineModelId } from "./models-catalog";
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

export function currentTranslatorRoute(spentUsd: number): TranslatorRoute {
  const s = getSettings();
  return chooseTranslator({
    mode: s.mode,
    online: isOnline(),
    hasApiKey: !!s.apiKey.trim(),
    offlineReady: s.offlineReady,
    webSpeech: webSpeechSupported(),
    liveModel: s.liveModel,
    spentUsd,
    capUsd: s.costCapUsd,
  });
}

export function currentRecognizerRoute(): RecognizerRoute {
  const s = getSettings();
  return chooseRecognizer({ mode: s.mode, online: isOnline(), offlineReady: s.offlineReady, webSpeech: webSpeechSupported() });
}

/** chunkSeconds：离线识别时每段的长度，0 表示松开按钮后整段识别 */
export function createRecognizer(chunkSeconds: number): Recognizer | string {
  const r = currentRecognizerRoute();
  if (r.engine === "none") return r.reason;
  return r.engine === "webspeech" ? new WebSpeechRecognizer() : new WhisperRecognizer(chunkSeconds);
}
