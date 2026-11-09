import { concatFloat32, resample, rms } from "./audio";
import { diag } from "./diagLog";
import { LANGS, type Lang } from "./languages";
import { acquireMic, releaseMic } from "./mic";
import { transcribeOffline } from "./mlClient";
import type { Recognizer, RecognizerHandlers } from "./recognizer";

const SILENCE_RMS = 0.005;
/** 超过这么久没收到麦克风数据，就认为录音链路被系统打断了，重建 */
export const AUDIO_STALL_MS = 5_000;
/** 最多几段在排队等识别；手机算得比说得慢时，超出的段落不再排队（录音备份里还有） */
export const MAX_BACKLOG = 2;

/**
 * 待识别段落的队列：一次只识别一段，排队的段数有上限，防止积压把手机内存撑爆。
 */
export class SegmentQueue<T> {
  private chain: Promise<void> = Promise.resolve();
  private inFlight = 0;

  constructor(
    private process: (item: T) => Promise<void>,
    private maxBacklog = MAX_BACKLOG,
  ) {}

  get size(): number {
    return this.inFlight;
  }

  /** 加入队列；队列已满时返回 false（这一段被跳过） */
  push(item: T): boolean {
    if (this.inFlight >= this.maxBacklog) return false;
    this.inFlight++;
    this.chain = this.chain
      .then(() => this.process(item))
      .catch(() => undefined) // 一段失败不能卡住后面的段落
      .finally(() => {
        this.inFlight--;
      });
    return true;
  }

  idle(): Promise<void> {
    return this.chain;
  }
}

function pageHidden(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

/**
 * 离线识别：在浏览器里用 Whisper。
 * chunkSeconds > 0 时每隔这么多秒切一段送去识别（课堂转写）；
 * chunkSeconds = 0 时只在 stop() 时整段识别（按住说话）。
 */
export class WhisperRecognizer implements Recognizer {
  readonly kind = "whisper" as const;
  private ctx: AudioContext | null = null;
  private node: ScriptProcessorNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private buffer: Float32Array[] = [];
  private bufferedSamples = 0;
  private sampleRate = 48_000;
  private handlers: RecognizerHandlers | null = null;
  private lang: Lang = "it";
  private active = false;
  private lastAudioAt = 0;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private rebuilding: Promise<void> | null = null;
  private failedSegments = 0;
  private skipped = 0;
  private segments = 0;
  private queue = new SegmentQueue<{ audio: Float32Array; lang: Lang; seg: number; level: number }>((s) =>
    this.transcribe(s.audio, s.lang, s.seg, s.level),
  );

  constructor(private chunkSeconds = 15) {}

  async start(lang: Lang, handlers: RecognizerHandlers): Promise<void> {
    this.lang = lang;
    this.handlers = handlers;
    this.active = true;
    this.skipped = 0;
    diag(`离线识别：开始（${lang}）`);
    await this.build();
    this.heartbeat = setInterval(() => {
      if (!this.active || this.rebuilding || pageHidden()) return;
      if (Date.now() - this.lastAudioAt > AUDIO_STALL_MS) {
        void this.rebuild(`${AUDIO_STALL_MS / 1000} 秒没有收到声音数据`).catch(() => undefined);
      }
    }, 2_000);
    handlers.onStatus?.("listening");
    handlers.onPartial("（离线识别：每段说完后出字）");
  }

  /** 建立录音链路：麦克风 → AudioContext → ScriptProcessor */
  private async build() {
    const stream = await acquireMic();
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctx();
    this.ctx = ctx;
    this.sampleRate = ctx.sampleRate;
    await ctx.resume();
    this.source = ctx.createMediaStreamSource(stream);
    this.node = ctx.createScriptProcessor(4096, 1, 1);
    this.node.onaudioprocess = (e) => {
      this.lastAudioAt = Date.now();
      this.buffer.push(new Float32Array(e.inputBuffer.getChannelData(0)));
      this.bufferedSamples += e.inputBuffer.length;
      if (this.chunkSeconds > 0 && this.bufferedSamples >= this.chunkSeconds * this.sampleRate) this.flush();
    };
    this.source.connect(this.node);
    this.node.connect(ctx.destination);
    this.lastAudioAt = Date.now();
    // 来电、通知、Siri 等会把 AudioContext 打断（iOS 上是 "interrupted"），先试着恢复，不行就重建
    ctx.onstatechange = () => {
      if (ctx !== this.ctx || !this.active) return;
      diag(`离线识别：AudioContext 状态 ${ctx.state}`);
      if (ctx.state === "running" || pageHidden()) return;
      setTimeout(() => {
        if (ctx !== this.ctx || !this.active || this.rebuilding) return;
        void ctx
          .resume()
          .catch(() => undefined)
          .then(() => {
            if (ctx === this.ctx && ctx.state !== "running")
              return this.rebuild(`AudioContext 停在 ${ctx.state}`).catch(() => undefined);
          });
      }, 500);
    };
  }

  private async teardown() {
    const ctx = this.ctx;
    if (!ctx) return;
    this.ctx = null;
    ctx.onstatechange = null;
    if (this.node) this.node.onaudioprocess = null;
    this.node?.disconnect();
    this.source?.disconnect();
    this.node = null;
    this.source = null;
    await ctx.close().catch(() => undefined);
    releaseMic();
  }

  private rebuild(reason: string): Promise<void> {
    if (this.rebuilding) return this.rebuilding;
    diag(`离线识别：重建录音链路（${reason}）`);
    this.handlers?.onStatus?.("reconnecting");
    this.rebuilding = (async () => {
      try {
        this.flush();
        await this.teardown();
        await this.build();
        this.handlers?.onStatus?.("listening");
      } catch (e) {
        diag(`离线识别：重建失败 ${e instanceof Error ? e.message : e}`);
        this.handlers?.onError?.("麦克风被系统占用，暂时无法恢复，请点“重新开始识别”");
        throw e;
      } finally {
        this.rebuilding = null;
      }
    })();
    return this.rebuilding;
  }

  async restart(reason: string): Promise<void> {
    if (!this.active) return;
    await this.rebuild(reason);
  }

  private flush() {
    if (this.buffer.length === 0) return;
    const raw = concatFloat32(this.buffer);
    const rate = this.sampleRate;
    this.buffer = [];
    this.bufferedSamples = 0;
    const seg = ++this.segments;
    const level = rms(raw);
    const secs = (raw.length / rate).toFixed(1);
    if (level < SILENCE_RMS) {
      // 诊断：老师离得远或声音小时，整段都可能被当成静音跳过
      diag(`离线识别：第 ${seg} 段（${secs} 秒）音量 ${level.toFixed(4)} 低于 ${SILENCE_RMS}，当作静音跳过`);
      return;
    }
    const audio = resample(raw, rate);
    if (!this.queue.push({ audio, lang: this.lang, seg, level })) {
      this.skipped++;
      diag(`离线识别：积压过多，跳过一段（累计 ${this.skipped} 段）`);
      if (this.skipped === 1)
        this.handlers?.onError?.("手机离线识别速度跟不上，部分段落已跳过（录音备份里仍然有）。联网时用联网识别会更流畅。");
    }
  }

  private async transcribe(audio: Float32Array, lang: Lang, seg: number, level: number) {
    this.handlers?.onStatus?.("processing");
    const began = Date.now();
    const secs = (audio.length / 16_000).toFixed(1);
    try {
      const text = await transcribeOffline(audio, LANGS[lang].whisper);
      this.failedSegments = 0;
      diag(
        `离线识别：第 ${seg} 段（${secs} 秒，音量 ${level.toFixed(4)}）识别用了 ${((Date.now() - began) / 1000).toFixed(1)} 秒，得到 ${text.length} 字`,
      );
      if (text) this.handlers?.onFinal(text);
    } catch (e) {
      // 模型进程崩溃后下一段会自动重建，只在第一次失败时提示，避免每段都刷报错
      this.failedSegments++;
      diag(`离线识别：识别失败 ${e instanceof Error ? e.message : e}`);
      if (this.failedSegments === 1) this.handlers?.onError?.(`离线识别失败：${e instanceof Error ? e.message : e}，正在自动重试`);
    }
    this.handlers?.onStatus?.(this.active ? "listening" : "idle");
  }

  async stop(): Promise<void> {
    if (!this.active) return;
    this.active = false;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    await this.rebuilding?.catch(() => undefined);
    this.flush();
    await this.teardown();
    diag("离线识别：停止");
    await this.queue.idle();
    this.handlers?.onPartial("");
    this.handlers?.onStatus?.("idle");
  }
}
