// 按段识别的公共部分：离线 Whisper 和云端识别都用它。
// 麦克风（MicPipeline）→ 按停顿切段（Segmenter）→ 自动增益 → 重采样到 16kHz → 排队识别 → 按顺序输出。

import { resample } from "./audio";
import { diag } from "./diagLog";
import { frameRms, MicPipeline, normalizeSegment, Segmenter, type Segment } from "./farField";
import type { Lang } from "./languages";
import type { MicProfile } from "./mic";
import type { Recognizer, RecognizerHandlers } from "./recognizer";

/**
 * 待识别段落的队列：可以同时处理几段，但结果严格按加入顺序交给 onResult；
 * 排队的段数有上限，防止手机算得比说得慢时积压把内存撑爆。某一段失败不影响后面的段落。
 */
export class SegmentQueue<T, R = void> {
  private entries: { done: boolean; result?: R; ok: boolean }[] = [];
  private waiting: { item: T; entry: { done: boolean; result?: R; ok: boolean } }[] = [];
  private running = 0;
  private idleWaiters: (() => void)[] = [];

  constructor(
    private process: (item: T) => Promise<R>,
    private opts: { maxBacklog?: number; concurrency?: number; onResult?: (r: R) => void } = {},
  ) {}

  /** 已加入但还没交出结果的段数（包括正在处理、等待处理、等待前面段落的） */
  get size(): number {
    return this.entries.length;
  }

  /** 加入队列；队列已满时返回 false（这一段被跳过） */
  push(item: T): boolean {
    if (this.entries.length >= (this.opts.maxBacklog ?? 2)) return false;
    const entry = { done: false, ok: false } as { done: boolean; result?: R; ok: boolean };
    this.entries.push(entry);
    this.waiting.push({ item, entry });
    this.pump();
    return true;
  }

  private pump() {
    while (this.running < (this.opts.concurrency ?? 1) && this.waiting.length) {
      const { item, entry } = this.waiting.shift()!;
      this.running++;
      this.process(item)
        .then(
          (r) => {
            entry.result = r;
            entry.ok = true;
          },
          () => undefined,
        )
        .finally(() => {
          entry.done = true;
          this.running--;
          this.deliver();
          this.pump();
        });
    }
  }

  private deliver() {
    while (this.entries.length && this.entries[0].done) {
      const e = this.entries.shift()!;
      if (e.ok) {
        try {
          this.opts.onResult?.(e.result as R);
        } catch {
          // 回调出错不能卡住队列
        }
      }
    }
    if (this.entries.length === 0) {
      const w = this.idleWaiters;
      this.idleWaiters = [];
      w.forEach((f) => f());
    }
  }

  idle(): Promise<void> {
    if (this.entries.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }
}

export interface SegmentInfo {
  /** 第几段（从 1 开始） */
  seg: number;
  seconds: number;
  /** 说话部分的原始音量 */
  speechRms: number;
  gain: number;
}

/**
 * hold = true 时只在 stop() 时把整段录音交给识别（双语对话的"按住说话"）；
 * 否则按停顿自动切段（课堂转写）。
 */
export abstract class SegmentRecognizer implements Recognizer {
  abstract readonly kind: Recognizer["kind"];
  protected handlers: RecognizerHandlers | null = null;
  protected lang: Lang = "it";
  protected active = false;
  private pipeline: MicPipeline | null = null;
  private segmenter: Segmenter | null = null;
  private held: Float32Array[] = [];
  private segments = 0;
  private skipped = 0;
  private lastLevelAt = 0;
  private queue: SegmentQueue<{ audio: Float32Array; info: SegmentInfo; lang: Lang }, string>;

  constructor(
    protected readonly tag: string,
    private readonly opts: { hold: boolean; profile: MicProfile; maxBacklog: number; concurrency: number },
  ) {
    this.queue = new SegmentQueue((s) => this.runSegment(s.audio, s.info, s.lang), {
      maxBacklog: opts.maxBacklog,
      concurrency: opts.concurrency,
      onResult: (text) => {
        if (text) this.handlers?.onFinal(text);
      },
    });
  }

  /** 识别一段 16kHz 音频，返回文字（没听到内容返回空字符串） */
  protected abstract transcribe(audio: Float32Array, info: SegmentInfo, lang: Lang): Promise<string>;

  /** 开始时给用户看的提示 */
  protected abstract hint(): string;

  async start(lang: Lang, handlers: RecognizerHandlers): Promise<void> {
    this.lang = lang;
    this.handlers = handlers;
    this.active = true;
    this.skipped = 0;
    this.held = [];
    diag(`${this.tag}：开始（${lang}，${this.opts.profile === "far" ? "远场收音" : "近场收音"}）`);
    this.pipeline = new MicPipeline(
      this.opts.profile,
      {
        onFrame: (f, rate) => this.onFrame(f, rate),
        onReconnecting: () => this.handlers?.onStatus?.("reconnecting"),
        onReconnected: () => this.handlers?.onStatus?.("listening"),
        onError: (m) => this.handlers?.onError?.(m),
      },
      this.tag,
    );
    await this.pipeline.start();
    handlers.onStatus?.("listening");
    handlers.onPartial(this.hint());
  }

  private onFrame(frame: Float32Array, rate: number) {
    const now = Date.now();
    if (now - this.lastLevelAt > 150) {
      this.lastLevelAt = now;
      this.handlers?.onLevel?.(frameRms(frame));
    }
    if (this.opts.hold) {
      this.held.push(frame);
      this.holdRate = rate;
      return;
    }
    if (!this.segmenter || this.segmenter.sampleRate !== rate) this.segmenter = new Segmenter(rate);
    for (const seg of this.segmenter.push(frame)) this.enqueue(seg);
  }

  private enqueue(seg: Segment) {
    const n = ++this.segments;
    const { samples, gain } = normalizeSegment(seg.samples, seg.speechRms);
    const audio = resample(samples, seg.sampleRate);
    const info: SegmentInfo = { seg: n, seconds: audio.length / 16_000, speechRms: seg.speechRms, gain };
    if (!this.queue.push({ audio, info, lang: this.lang })) {
      this.skipped++;
      diag(`${this.tag}：积压过多，跳过第 ${n} 段（累计 ${this.skipped} 段）`);
      if (this.skipped === 1) this.handlers?.onError?.(this.backlogMessage());
    }
  }

  protected backlogMessage(): string {
    return "识别速度跟不上，部分段落已跳过（录音备份里仍然有）。";
  }

  private async runSegment(audio: Float32Array, info: SegmentInfo, lang: Lang): Promise<string> {
    this.handlers?.onStatus?.("processing");
    try {
      return await this.transcribe(audio, info, lang);
    } finally {
      this.handlers?.onStatus?.(this.active ? "listening" : "idle");
    }
  }

  async restart(reason: string): Promise<void> {
    if (!this.active || !this.pipeline) return;
    this.flushPending();
    await this.pipeline.rebuild(reason);
  }

  /** 把正在积累的内容交出去识别（重建链路或停止前调用） */
  private flushPending() {
    if (this.opts.hold) return;
    const seg = this.segmenter?.flush();
    if (seg) this.enqueue(seg);
  }

  async stop(): Promise<void> {
    if (!this.active) return;
    this.active = false;
    await this.pipeline?.stop();
    this.pipeline = null;
    if (this.opts.hold) {
      const total = this.held.reduce((n, f) => n + f.length, 0);
      if (total) {
        // 按住说话：整段交给识别；音量太小（没说话）就不识别
        const all = new Float32Array(total);
        let off = 0;
        for (const f of this.held) {
          all.set(f, off);
          off += f.length;
        }
        this.held = [];
        const level = frameRms(all);
        if (level > 0.002) {
          const rate = this.holdRate;
          this.enqueue({ samples: all, sampleRate: rate, speechRms: level * 1.5, voicedMs: (total / rate) * 1000 });
        }
      }
    } else {
      this.flushPending();
    }
    diag(`${this.tag}：停止`);
    await this.queue.idle();
    this.handlers?.onPartial("");
    this.handlers?.onStatus?.("idle");
  }

  private holdRate = 48_000;
}
