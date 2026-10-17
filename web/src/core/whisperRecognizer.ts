import { concatFloat32, resample, rms } from "./audio";
import { LANGS, type Lang } from "./languages";
import { acquireMic, releaseMic } from "./mic";
import { transcribeOffline } from "./mlClient";
import type { Recognizer, RecognizerHandlers } from "./recognizer";

const SILENCE_RMS = 0.005;

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
  private handlers: RecognizerHandlers | null = null;
  private lang: Lang = "it";
  private queue: Promise<void> = Promise.resolve();

  constructor(private chunkSeconds = 15) {}

  async start(lang: Lang, handlers: RecognizerHandlers): Promise<void> {
    this.lang = lang;
    this.handlers = handlers;
    const stream = await acquireMic();
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.ctx = new Ctx();
    await this.ctx.resume();
    this.source = this.ctx.createMediaStreamSource(stream);
    this.node = this.ctx.createScriptProcessor(4096, 1, 1);
    this.node.onaudioprocess = (e) => {
      this.buffer.push(new Float32Array(e.inputBuffer.getChannelData(0)));
      this.bufferedSamples += e.inputBuffer.length;
      if (this.chunkSeconds > 0 && this.bufferedSamples >= this.chunkSeconds * this.ctx!.sampleRate) this.flush();
    };
    this.source.connect(this.node);
    this.node.connect(this.ctx.destination);
    handlers.onStatus?.("listening");
    handlers.onPartial("（离线识别：每段说完后出字）");
  }

  private flush() {
    if (!this.ctx || this.buffer.length === 0) return;
    const raw = concatFloat32(this.buffer);
    const rate = this.ctx.sampleRate;
    this.buffer = [];
    this.bufferedSamples = 0;
    if (rms(raw) < SILENCE_RMS) return;
    const audio = resample(raw, rate);
    const lang = this.lang;
    this.queue = this.queue.then(async () => {
      this.handlers?.onStatus?.("processing");
      try {
        const text = await transcribeOffline(audio, LANGS[lang].whisper);
        if (text) this.handlers?.onFinal(text);
      } catch (e) {
        this.handlers?.onError?.(`离线识别失败：${e instanceof Error ? e.message : e}`);
      }
      this.handlers?.onStatus?.(this.ctx ? "listening" : "idle");
    });
  }

  async stop(): Promise<void> {
    if (!this.ctx) return;
    this.flush();
    this.node?.disconnect();
    this.source?.disconnect();
    const ctx = this.ctx;
    this.ctx = null;
    await ctx.close();
    releaseMic();
    await this.queue;
    this.handlers?.onPartial("");
    this.handlers?.onStatus?.("idle");
  }
}
