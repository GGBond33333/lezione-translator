import { countAudioChunks, saveAudioChunk } from "../storage/db";
import { diag } from "./diagLog";
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
  private sessionId = "";
  private index = 0;
  private saving: Promise<void> = Promise.resolve();
  mime: string | undefined;

  async start(sessionId: string): Promise<boolean> {
    this.mime = pickMime();
    if (!this.mime) return false;
    this.sessionId = sessionId;
    // 续录时接着之前的编号保存，同一节课的录音按顺序拼接
    this.index = await countAudioChunks(sessionId);
    await this.record();
    return true;
  }

  private async record() {
    const stream = await acquireMic();
    const rec = new MediaRecorder(stream, { mimeType: this.mime, audioBitsPerSecond: 32_000 });
    const sessionId = this.sessionId;
    rec.ondataavailable = (e) => {
      if (!e.data.size) return;
      const idx = this.index++;
      this.saving = this.saving.then(() => saveAudioChunk(sessionId, idx, e.data)).catch(() => undefined);
    };
    rec.onerror = () => diag("录音备份：录音出错");
    // 被系统打断时 MediaRecorder 会自己停下来；不是我们调用的 stop 就重新开始录
    rec.onstop = () => {
      if (rec !== this.recorder) return;
      this.recorder = null;
      releaseMic();
      diag("录音备份：被系统停止");
    };
    rec.start(CHUNK_MS);
    this.recorder = rec;
  }

  /** 被打断后恢复录音；已经在录就重新开一段（旧的音轨可能已经被静音） */
  async restart(): Promise<void> {
    if (!this.sessionId) return;
    await this.stopRecorder();
    try {
      await this.record();
      diag("录音备份：已恢复");
    } catch (e) {
      diag(`录音备份：恢复失败 ${e instanceof Error ? e.message : e}`);
    }
  }

  private async stopRecorder() {
    const rec = this.recorder;
    if (!rec) return;
    this.recorder = null;
    if (rec.state !== "inactive") {
      await new Promise<void>((resolve) => {
        rec.addEventListener("stop", () => resolve(), { once: true });
        setTimeout(resolve, 1500);
        rec.stop();
      });
    }
    releaseMic();
  }

  async stop(): Promise<void> {
    await this.stopRecorder();
    this.sessionId = "";
    await this.saving;
  }
}
