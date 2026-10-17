import { LANGS, type Lang } from "./languages";
import type { Recognizer, RecognizerHandlers } from "./recognizer";

// Safari / Chrome 的 Web Speech API 没有标准类型定义，这里只声明用到的部分
interface SpeechResultLike {
  isFinal: boolean;
  0: { transcript: string };
}
interface SpeechEventLike {
  resultIndex: number;
  results: ArrayLike<SpeechResultLike>;
}
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: SpeechEventLike) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

function getCtor(): (new () => SpeechRecognitionLike) | undefined {
  const w = globalThis as unknown as Record<string, unknown>;
  return (w.SpeechRecognition ?? w.webkitSpeechRecognition) as (new () => SpeechRecognitionLike) | undefined;
}

export function webSpeechSupported(): boolean {
  return !!getCtor();
}

/** 长时间没有任何结果时主动重启（Safari 偶尔会静默卡住，不触发 onend） */
const WATCHDOG_MS = 45_000;
const FATAL_ERRORS = new Set(["not-allowed", "service-not-allowed", "language-not-supported"]);

export class WebSpeechRecognizer implements Recognizer {
  readonly kind = "webspeech" as const;
  private rec: SpeechRecognitionLike | null = null;
  private active = false;
  private handlers: RecognizerHandlers | null = null;
  private lang: Lang = "it";
  private partial = "";
  private lastResultAt = 0;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private endWaiter: (() => void) | null = null;
  /** 连续多少次重启后都没有识别到任何内容，用于退避，避免网络断开时疯狂重试 */
  private failures = 0;
  private gotResult = false;

  async start(lang: Lang, handlers: RecognizerHandlers): Promise<void> {
    if (!getCtor()) throw new Error("这个浏览器不支持语音识别，请用 Safari 或 Chrome，或者切换到离线模式");
    this.lang = lang;
    this.handlers = handlers;
    this.active = true;
    this.partial = "";
    this.failures = 0;
    this.spawn();
    this.watchdog = setInterval(() => {
      if (this.active && Date.now() - this.lastResultAt > WATCHDOG_MS) {
        this.lastResultAt = Date.now();
        this.rec?.abort(); // 触发 onend → 自动重启
      }
    }, 5_000);
  }

  private spawn() {
    const Ctor = getCtor()!;
    const rec = new Ctor();
    rec.lang = LANGS[this.lang].locale;
    rec.continuous = true;
    rec.interimResults = true;
    this.lastResultAt = Date.now();
    this.gotResult = false;

    rec.onresult = (e) => {
      this.lastResultAt = Date.now();
      this.gotResult = true;
      this.failures = 0;
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        const text = r[0].transcript.trim();
        if (r.isFinal) {
          if (text) this.handlers?.onFinal(text);
          this.partial = "";
        } else {
          interim += r[0].transcript;
        }
      }
      this.partial = interim.trim();
      this.handlers?.onPartial(this.partial);
    };

    rec.onerror = (e) => {
      if (FATAL_ERRORS.has(e.error)) {
        this.active = false;
        this.handlers?.onError?.(
          e.error === "not-allowed" ? "没有麦克风或语音识别权限，请在系统设置里允许" : `语音识别不可用：${e.error}`,
        );
      }
      // no-speech / network / aborted 等错误交给 onend 自动重启
    };

    rec.onend = () => {
      // 识别被打断时还没定稿的部分，当作一句话保存，避免丢内容
      if (this.partial) {
        this.handlers?.onFinal(this.partial);
        this.partial = "";
        this.handlers?.onPartial("");
      }
      if (this.active) {
        this.handlers?.onStatus?.("reconnecting");
        if (!this.gotResult) this.failures++;
        // 正常的停顿重启很快；连续失败时逐步延长到 5 秒
        const delay = this.failures <= 1 ? 250 : Math.min(250 * 2 ** this.failures, 5000);
        if (this.failures === 5) this.handlers?.onError?.("语音识别连接不稳定，正在自动重试…");
        setTimeout(() => {
          if (!this.active) return;
          try {
            this.spawn();
          } catch {
            this.handlers?.onError?.("语音识别重启失败");
          }
        }, delay);
      } else {
        this.handlers?.onStatus?.("idle");
        this.endWaiter?.();
        this.endWaiter = null;
      }
    };

    this.rec = rec;
    rec.start();
    this.handlers?.onStatus?.("listening");
  }

  async stop(): Promise<void> {
    if (!this.rec) return;
    this.active = false;
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
    const done = new Promise<void>((resolve) => {
      this.endWaiter = resolve;
      setTimeout(resolve, 1500); // 有的浏览器 stop 后不触发 onend
    });
    try {
      this.rec.stop();
    } catch {
      // 已经停止
    }
    await done;
    if (this.partial) {
      this.handlers?.onFinal(this.partial);
      this.partial = "";
    }
    this.rec = null;
  }
}
