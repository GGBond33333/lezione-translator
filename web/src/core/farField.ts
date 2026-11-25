// 远场收音：老师离手机较远时，让声音尽量清楚地送进识别。
// - MicPipeline：麦克风 → 高通滤波 → 采样，带打断检测和自动重建
// - Segmenter：按教室底噪自适应判断"有人在说话"，在停顿处切段
// - normalizeSegment：按这一段说话的音量自动放大（软件增益），远处的小声也能放大到识别需要的响度
// - encodeWav：16kHz 单声道 WAV，用于上传云端识别

import { diag } from "./diagLog";
import { acquireMic, releaseMic, type MicProfile } from "./mic";

// —— 切段 ——

export interface SegmenterOptions {
  /** 说话后停顿多久切一段（毫秒） */
  pauseMs: number;
  /** 每段最短 / 最长（秒） */
  minSeconds: number;
  maxSeconds: number;
  /** 音量比底噪高多少倍才算说话 */
  speechRatio: number;
  /** 绝对下限：再安静的教室也不把低于这个音量的声音当成说话 */
  minSpeechRms: number;
  /** 一段里至少要有多少毫秒的说话声，否则当噪音丢掉 */
  minVoicedMs: number;
  /** 开始说话前保留多少毫秒，避免吃掉第一个字 */
  preRollMs: number;
  /** 用最近多长时间的音量估计底噪（毫秒） */
  floorWindowMs: number;
}

export const DEFAULT_SEGMENTER: SegmenterOptions = {
  pauseMs: 600,
  minSeconds: 2,
  maxSeconds: 25,
  speechRatio: 2.5,
  minSpeechRms: 0.0012,
  minVoicedMs: 300,
  preRollMs: 300,
  floorWindowMs: 15_000,
};

export interface Segment {
  samples: Float32Array;
  sampleRate: number;
  /** 这一段里说话部分的平均音量（用于自动增益和诊断） */
  speechRms: number;
  voicedMs: number;
}

export function frameRms(f: Float32Array): number {
  let s = 0;
  for (let i = 0; i < f.length; i++) s += f[i] * f[i];
  return Math.sqrt(s / (f.length || 1));
}

export class Segmenter {
  private opts: SegmenterOptions;
  /** 教室底噪（安静时的音量），持续自适应 */
  floor = 0;
  private history: number[] = [];
  private frames: Float32Array[] = [];
  private samples = 0;
  private preRoll: Float32Array[] = [];
  private preRollSamples = 0;
  private inSegment = false;
  private silentMs = 0;
  private voicedMs = 0;
  private speechEnergy = 0;
  private speechFrames = 0;

  constructor(
    readonly sampleRate: number,
    opts: Partial<SegmenterOptions> = {},
  ) {
    this.opts = { ...DEFAULT_SEGMENTER, ...opts };
  }

  threshold(): number {
    return Math.max(this.floor * this.opts.speechRatio, this.opts.minSpeechRms);
  }

  /** 输入一帧音频，返回这一帧结束时切出的完整段落（通常为空） */
  push(frame: Float32Array): Segment[] {
    const rms = frameRms(frame);
    const ms = (frame.length / this.sampleRate) * 1000;
    // 底噪 = 最近 15 秒里最安静的那部分（第 5 百分位）。讲课时句子之间、字与字之间总有空隙，
    // 所以连续讲很久也不会把说话声当成底噪；空调突然打开这类持续的噪音，十几秒后也会被算进底噪。
    this.history.push(rms);
    const maxFrames = Math.max(1, Math.round(this.opts.floorWindowMs / ms));
    if (this.history.length > maxFrames) this.history.splice(0, this.history.length - maxFrames);
    const sorted = [...this.history].sort((a, b) => a - b);
    this.floor = sorted[Math.floor((sorted.length - 1) * 0.05)];
    const speech = rms > this.threshold();

    const out: Segment[] = [];
    if (!this.inSegment) {
      this.preRoll.push(frame);
      this.preRollSamples += frame.length;
      while (this.preRoll.length > 1 && this.preRollSamples - this.preRoll[0].length >= (this.opts.preRollMs / 1000) * this.sampleRate) {
        this.preRollSamples -= this.preRoll.shift()!.length;
      }
      if (speech) {
        this.inSegment = true;
        this.frames = this.preRoll;
        this.samples = this.preRollSamples;
        this.preRoll = [];
        this.preRollSamples = 0;
        this.silentMs = 0;
        this.voicedMs = ms;
        this.speechEnergy = rms * rms;
        this.speechFrames = 1;
      }
      return out;
    }

    this.frames.push(frame);
    this.samples += frame.length;
    if (speech) {
      this.silentMs = 0;
      this.voicedMs += ms;
      this.speechEnergy += rms * rms;
      this.speechFrames++;
    } else {
      this.silentMs += ms;
    }
    const seconds = this.samples / this.sampleRate;
    if (seconds >= this.opts.maxSeconds) {
      const seg = this.cut();
      if (seg) out.push(seg);
      // 强制切断时，如果还在说话，下一段马上接着开始
      if (speech) {
        this.inSegment = true;
        this.voicedMs = 0;
        this.speechEnergy = 0;
        this.speechFrames = 0;
      }
    } else if (this.silentMs >= this.opts.pauseMs && seconds >= this.opts.minSeconds) {
      const seg = this.cut();
      if (seg) out.push(seg);
    } else if (this.silentMs >= this.opts.pauseMs * 4) {
      // 很短的一声（咳嗽、关门）之后长时间安静：太短就丢掉
      const seg = this.cut();
      if (seg) out.push(seg);
    }
    return out;
  }

  /** 结束时把正在积累的一段吐出来 */
  flush(): Segment | null {
    return this.inSegment ? this.cut() : null;
  }

  private cut(): Segment | null {
    const voicedMs = this.voicedMs;
    const speechRms = Math.sqrt(this.speechEnergy / (this.speechFrames || 1));
    const frames = this.frames;
    this.frames = [];
    this.samples = 0;
    this.inSegment = false;
    this.silentMs = 0;
    this.voicedMs = 0;
    this.speechEnergy = 0;
    this.speechFrames = 0;
    if (voicedMs < this.opts.minVoicedMs) return null;
    return { samples: concat(frames), sampleRate: this.sampleRate, speechRms, voicedMs };
  }
}

function concat(parts: Float32Array[]): Float32Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Float32Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

// —— 自动增益 ——

/** 说话部分放大到这个音量（约 -20 dBFS） */
export const TARGET_RMS = 0.1;
export const MAX_GAIN = 20;

/** 按这一段说话的平均音量放大，最多 MAX_GAIN 倍；用软限幅防止爆音。返回新数组和实际倍数 */
export function normalizeSegment(samples: Float32Array, speechRms: number): { samples: Float32Array; gain: number } {
  const gain = Math.min(MAX_GAIN, Math.max(1, TARGET_RMS / Math.max(speechRms, 1e-6)));
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) out[i] = Math.tanh(samples[i] * gain);
  return { samples: out, gain };
}

// —— WAV 编码 ——

export function encodeWav(samples: Float32Array, sampleRate = 16_000): ArrayBuffer {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const str = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i));
  };
  str(0, "RIFF");
  v.setUint32(4, 36 + samples.length * 2, true);
  str(8, "WAVE");
  str(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // 单声道
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, "data");
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buf;
}

// —— 麦克风链路 ——

/** 超过这么久没收到麦克风数据，就认为录音链路被系统打断了，重建 */
export const AUDIO_STALL_MS = 5_000;

function pageHidden(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

export interface PipelineEvents {
  onFrame(frame: Float32Array, sampleRate: number): void;
  onReconnecting?(): void;
  onReconnected?(): void;
  onError?(message: string): void;
}

/**
 * 麦克风 → 高通滤波（去掉 80Hz 以下的空调、桌面震动声）→ ScriptProcessor 采样。
 * 来电、通知、切后台等打断后会自动重建；连续失败时 restart() 抛错，由上层决定是否提示用户手动重试。
 */
export class MicPipeline {
  private ctx: AudioContext | null = null;
  private nodes: AudioNode[] = [];
  private active = false;
  private lastAudioAt = 0;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private rebuilding: Promise<void> | null = null;
  sampleRate = 48_000;

  constructor(
    private profile: MicProfile,
    private events: PipelineEvents,
    private tag: string,
  ) {}

  async start(): Promise<void> {
    this.active = true;
    await this.build();
    this.heartbeat = setInterval(() => {
      if (!this.active || this.rebuilding || pageHidden()) return;
      if (Date.now() - this.lastAudioAt > AUDIO_STALL_MS) {
        void this.rebuild(`${AUDIO_STALL_MS / 1000} 秒没有收到声音数据`).catch(() => undefined);
      }
    }, 2_000);
  }

  private async build() {
    const stream = await acquireMic(this.profile);
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctx();
    this.ctx = ctx;
    this.sampleRate = ctx.sampleRate;
    await ctx.resume();
    const source = ctx.createMediaStreamSource(stream);
    const highpass = ctx.createBiquadFilter();
    highpass.type = "highpass";
    highpass.frequency.value = 80;
    const node = ctx.createScriptProcessor(4096, 1, 1);
    node.onaudioprocess = (e) => {
      this.lastAudioAt = Date.now();
      this.events.onFrame(new Float32Array(e.inputBuffer.getChannelData(0)), ctx.sampleRate);
    };
    source.connect(highpass);
    highpass.connect(node);
    node.connect(ctx.destination);
    this.nodes = [source, highpass, node];
    this.lastAudioAt = Date.now();
    // 来电、通知、Siri 等会把 AudioContext 打断（iOS 上是 "interrupted"），先试着恢复，不行就重建
    ctx.onstatechange = () => {
      if (ctx !== this.ctx || !this.active) return;
      diag(`${this.tag}：AudioContext 状态 ${ctx.state}`);
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
    for (const n of this.nodes) {
      if (n instanceof ScriptProcessorNode) n.onaudioprocess = null;
      n.disconnect();
    }
    this.nodes = [];
    await ctx.close().catch(() => undefined);
    releaseMic();
  }

  rebuild(reason: string): Promise<void> {
    if (this.rebuilding) return this.rebuilding;
    diag(`${this.tag}：重建录音链路（${reason}）`);
    this.events.onReconnecting?.();
    this.rebuilding = (async () => {
      try {
        await this.teardown();
        await this.build();
        this.events.onReconnected?.();
      } catch (e) {
        diag(`${this.tag}：重建失败 ${e instanceof Error ? e.message : e}`);
        this.events.onError?.("麦克风被系统占用，暂时无法恢复，请点“重新开始识别”");
        throw e;
      } finally {
        this.rebuilding = null;
      }
    })();
    return this.rebuilding;
  }

  async stop(): Promise<void> {
    if (!this.active) return;
    this.active = false;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    await this.rebuilding?.catch(() => undefined);
    await this.teardown();
  }
}
