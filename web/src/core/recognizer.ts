import type { Lang } from "./languages";

export type RecognizerStatus = "idle" | "listening" | "reconnecting" | "processing";

export interface RecognizerHandlers {
  /** 还没说完的部分结果，用于实时显示 */
  onPartial(text: string): void;
  /** 一句话识别完成 */
  onFinal(text: string): void;
  onStatus?(status: RecognizerStatus): void;
  onError?(message: string): void;
}

export interface Recognizer {
  readonly kind: "webspeech" | "whisper";
  start(lang: Lang, handlers: RecognizerHandlers): Promise<void>;
  /** 停止识别；resolve 时所有剩余结果都已经通过 onFinal 发出 */
  stop(): Promise<void>;
}
