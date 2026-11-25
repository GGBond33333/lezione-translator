import type { Lang } from "./languages";

export type RecognizerStatus = "idle" | "listening" | "reconnecting" | "processing";

export interface RecognizerHandlers {
  /** 还没说完的部分结果，用于实时显示 */
  onPartial(text: string): void;
  /** 一句话识别完成 */
  onFinal(text: string): void;
  onStatus?(status: RecognizerStatus): void;
  onError?(message: string): void;
  /** 实时音量（0–1 的均方根），用于界面上的音量条；只有能拿到音频的识别方式才有 */
  onLevel?(level: number): void;
  /** 识别本身产生的费用（美元），例如云端识别按时长计费 */
  onCost?(usd: number): void;
}

export interface Recognizer {
  readonly kind: "webspeech" | "whisper" | "cloud";
  start(lang: Lang, handlers: RecognizerHandlers): Promise<void>;
  /** 停止识别；resolve 时所有剩余结果都已经通过 onFinal 发出 */
  stop(): Promise<void>;
  /** 被系统打断（切后台、来电、通知）后重建识别；不丢已经识别好的内容 */
  restart(reason: string): Promise<void>;
}
