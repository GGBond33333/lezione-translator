import { diag } from "./diagLog";

// 麦克风流只申请一次，由 Whisper 识别和录音备份共用。
// iOS Safari 再次调用 getUserMedia 时可能让之前的音轨静音，所以不要各自申请。
let stream: MediaStream | null = null;
let streamProfile: MicProfile = "near";
let users = 0;

/**
 * near：近距离说话（双语对话），开启 iPhone 的通话语音处理（回声消除、降噪），避免把朗读的译文录进去。
 * far：远距离收音（课堂），关掉通话语音处理——它会把远处老师的声音当成背景噪音压掉。
 */
export type MicProfile = "near" | "far";

const CONSTRAINTS: Record<MicProfile, MediaTrackConstraints> = {
  near: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
  far: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
};
const lostListeners = new Set<(reason: string) => void>();

function usable(s: MediaStream | null): boolean {
  return !!s && s.getAudioTracks().some((t) => t.readyState === "live" && !t.muted);
}

export async function acquireMic(profile: MicProfile = "near"): Promise<MediaStream> {
  // 已经有人在用时直接共用（iOS 重复申请会让之前的音轨静音）；没人用时按需要的模式重新申请
  const reuse = usable(stream) && (users > 0 || streamProfile === profile);
  if (!reuse) {
    // 旧音轨已经结束或被系统静音（来电、通知、耳机切换后常见），重新申请
    if (stream) {
      diag(usable(stream) ? "麦克风：切换收音模式，重新申请" : "麦克风：旧音轨不可用，重新申请");
      stream.getTracks().forEach((t) => t.stop());
    }
    stream = await navigator.mediaDevices.getUserMedia({ audio: CONSTRAINTS[profile] });
    streamProfile = profile;
    diag(`麦克风：已打开（${profile === "far" ? "远场模式" : "近场模式"}）`);
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
