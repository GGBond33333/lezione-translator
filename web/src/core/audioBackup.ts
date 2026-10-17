import { countAudioChunks, saveAudioChunk } from "../storage/db";
import { acquireMic, releaseMic } from "./mic";

const CHUNK_MS = 60_000;

function pickMime(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  // Safari 支持 mp4/aac，Chrome 支持 webm/opus
  return ["audio/mp4", "audio/webm;codecs=opus", "audio/webm"].find((m) => MediaRecorder.isTypeSupported(m));
}

/** 录音备份：低码率录制原始音频，每分钟一段存入 IndexedDB，崩溃也最多丢一分钟 */
export class AudioBackup {
  private recorder: MediaRecorder | null = null;
  private index = 0;
  private saving: Promise<void> = Promise.resolve();
  mime: string | undefined;

  async start(sessionId: string): Promise<boolean> {
    this.mime = pickMime();
    if (!this.mime) return false;
    const stream = await acquireMic();
    // 续录时接着之前的编号保存，同一节课的录音按顺序拼接
    this.index = await countAudioChunks(sessionId);
    const rec = new MediaRecorder(stream, { mimeType: this.mime, audioBitsPerSecond: 32_000 });
    rec.ondataavailable = (e) => {
      if (!e.data.size) return;
      const idx = this.index++;
      this.saving = this.saving.then(() => saveAudioChunk(sessionId, idx, e.data)).catch(() => undefined);
    };
    rec.start(CHUNK_MS);
    this.recorder = rec;
    return true;
  }

  async stop(): Promise<void> {
    const rec = this.recorder;
    if (!rec) return;
    this.recorder = null;
    await new Promise<void>((resolve) => {
      rec.addEventListener("stop", () => resolve(), { once: true });
      rec.stop();
    });
    await this.saving;
    releaseMic();
  }
}
