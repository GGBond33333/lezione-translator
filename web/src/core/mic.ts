import { diag } from "./diagLog";

// 麦克风流只申请一次，由 Whisper 识别和录音备份共用。
// iOS Safari 再次调用 getUserMedia 时可能让之前的音轨静音，所以不要各自申请。
let stream: MediaStream | null = null;
let users = 0;
const lostListeners = new Set<(reason: string) => void>();

function usable(s: MediaStream | null): boolean {
  return !!s && s.getAudioTracks().some((t) => t.readyState === "live" && !t.muted);
}

export async function acquireMic(): Promise<MediaStream> {
  if (!usable(stream)) {
    // 旧音轨已经结束或被系统静音（来电、通知、耳机切换后常见），重新申请
    if (stream) {
      diag("麦克风：旧音轨不可用，重新申请");
      stream.getTracks().forEach((t) => t.stop());
    }
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
    });
    const s = stream;
    s.getAudioTracks().forEach((t) => {
      t.addEventListener("ended", () => s === stream && lost("音轨结束"));
      t.addEventListener("mute", () => s === stream && lost("音轨被静音"));
      t.addEventListener("unmute", () => s === stream && diag("麦克风：音轨恢复"));
    });
  }
  users++;
  return stream!;
}

function lost(reason: string) {
  diag(`麦克风：${reason}`);
  lostListeners.forEach((l) => l(reason));
}

export function releaseMic(): void {
  users = Math.max(0, users - 1);
  if (users === 0 && stream) {
    stream.getTracks().forEach((t) => t.stop());
    stream = null;
  }
}

/** 麦克风被系统打断（音轨结束或被静音）时回调；返回取消订阅函数 */
export function onMicLost(cb: (reason: string) => void): () => void {
  lostListeners.add(cb);
  return () => lostListeners.delete(cb);
}
