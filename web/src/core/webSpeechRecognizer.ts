import { diag } from "./diagLog";
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

function pageHidden(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

/** 长时间没有任何结果时主动重启（Safari 偶尔会静默卡住，不触发 onend） */
export const WATCHDOG_MS = 45_000;
/** 出错或调用 abort 后，等 onend 的最长时间；Safari 有时不触发 onend，超时就直接换一个新实例 */
export const END_TIMEOUT_MS = 2_000;
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
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private endTimer: ReturnType<typeof setTimeout> | null = null;
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
    diag(`联网识别：开始（${LANGS[lang].locale}）`);
    this.spawn();
    this.watchdog = setInterval(() => {
      if (!this.active || pageHidden()) return;
      if (!this.rec && !this.restartTimer) {
        // 重启过程中出了意外，没有任何实例在工作
        diag("联网识别：看门狗发现没有在识别，重新启动");
        try {
          this.spawn();
        } catch (e) {
          diag(`联网识别：重新启动失败 ${e instanceof Error ? e.message : e}`);
        }
      } else if (Date.now() - this.lastResultAt > WATCHDOG_MS) {
        diag(`联网识别：看门狗触发（${Math.round(WATCHDOG_MS / 1000)} 秒没有结果）`);
        this.replace();
      }
    }, 5_000);
  }

  private flushPartial() {
    // 识别被打断时还没定稿的部分，当作一句话保存，避免丢内容
    if (this.partial) {
      this.handlers?.onFinal(this.partial);
      this.partial = "";
      this.handlers?.onPartial("");
    }
  }

  /** 丢掉当前实例（不再等它的 onend），立即换一个新的 */
  private replace() {
    this.detach();
    this.clearRestart();
    if (this.active) this.spawn();
  }

  private detach() {
    const old = this.rec;
    this.rec = null;
    if (this.endTimer) clearTimeout(this.endTimer);
    this.endTimer = null;
    this.flushPartial();
    if (!old) return;
    old.onresult = null;
    old.onerror = null;
    old.onend = null;
    try {
      old.abort();
    } catch {
      // 已经停止
    }
  }

  private clearRestart() {
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
  }

  private scheduleRestart() {
    if (!this.active || this.restartTimer) return;
    this.handlers?.onStatus?.("reconnecting");
    if (!this.gotResult) this.failures++;
    // 正常的停顿重启很快；连续失败时逐步延长到 5 秒
    const delay = this.failures <= 1 ? 250 : Math.min(250 * 2 ** this.failures, 5000);
    if (this.failures === 5) this.handlers?.onError?.("语音识别连接不稳定，正在自动重试…");
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      // 在后台时 iOS 不允许启动识别，等回到前台由 restart() 恢复
      if (this.active && !pageHidden()) this.spawn();
    }, delay);
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
      if (rec !== this.rec) return;
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
      if (rec !== this.rec) return;
      if (e.error !== "no-speech" && e.error !== "aborted") diag(`联网识别：错误 ${e.error}`);
      // 在后台时 iOS 会报 not-allowed，这不是用户拒绝了权限，回到前台后会恢复
      if (FATAL_ERRORS.has(e.error) && !pageHidden()) {
        this.active = false;
        this.handlers?.onError?.(
          e.error === "not-allowed" ? "没有麦克风或语音识别权限，请在系统设置里允许" : `语音识别不可用：${e.error}`,
        );
      } else if (e.error === "audio-capture") {
        this.handlers?.onError?.("麦克风被系统占用（来电、通知或其他 App），正在恢复…");
      }
      // 其余错误交给 onend 自动重启；Safari 有时不触发 onend，超时后直接换新实例
      if (this.active && !this.endTimer) {
        this.endTimer = setTimeout(() => {
          this.endTimer = null;
          if (rec === this.rec && this.active) {
            diag("联网识别：出错后没有收到结束事件，强制重启");
            this.detach();
            this.scheduleRestart();
          }
        }, END_TIMEOUT_MS);
      }
    };

    rec.onend = () => {
      if (rec !== this.rec) return;
      if (this.endTimer) clearTimeout(this.endTimer);
      this.endTimer = null;
      this.flushPartial();
      this.rec = null;
      if (this.active) {
        this.scheduleRestart();
      } else {
        this.handlers?.onStatus?.("idle");
        this.endWaiter?.();
        this.endWaiter = null;
      }
    };

    this.rec = rec;
    try {
      rec.start();
    } catch (e) {
      // 上一个实例还没完全释放麦克风时 start 可能抛错，稍后再试
      diag(`联网识别：启动失败 ${e instanceof Error ? e.message : e}`);
      this.rec = null;
      this.scheduleRestart();
      return;
    }
    this.handlers?.onStatus?.("listening");
  }

  async restart(reason: string): Promise<void> {
    if (!this.active) return;
    diag(`联网识别：重新启动（${reason}）`);
    this.failures = 0;
    this.replace();
  }

  async stop(): Promise<void> {
    if (!this.active && !this.rec) return;
    this.active = false;
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
    this.clearRestart();
    if (this.endTimer) clearTimeout(this.endTimer);
    this.endTimer = null;
    diag("联网识别：停止");
    const rec = this.rec;
    if (rec) {
      const done = new Promise<void>((resolve) => {
        this.endWaiter = resolve;
        setTimeout(resolve, 1500); // 有的浏览器 stop 后不触发 onend
      });
      try {
        rec.stop();
      } catch {
        // 已经停止
      }
      await done;
    }
    this.flushPartial();
    this.rec = null;
    this.handlers?.onStatus?.("idle");
  }
}
