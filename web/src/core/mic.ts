// 麦克风流只申请一次，由 Whisper 识别和录音备份共用。
// iOS Safari 再次调用 getUserMedia 时可能让之前的音轨静音，所以不要各自申请。
let stream: MediaStream | null = null;
let users = 0;

export async function acquireMic(): Promise<MediaStream> {
  if (!stream || stream.getAudioTracks().every((t) => t.readyState === "ended")) {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
    });
  }
  users++;
  return stream;
}

export function releaseMic(): void {
  users = Math.max(0, users - 1);
  if (users === 0 && stream) {
    stream.getTracks().forEach((t) => t.stop());
    stream = null;
  }
}
