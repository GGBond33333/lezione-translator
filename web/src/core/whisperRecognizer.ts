import { diag } from "./diagLog";
import { LANGS, type Lang } from "./languages";
import { transcribeOffline } from "./mlClient";
import { SegmentRecognizer, type SegmentInfo } from "./segmentRecognizer";

export { SegmentQueue } from "./segmentRecognizer";

/** 最多几段在排队等识别；手机算得比说得慢时，超出的段落不再排队（录音备份里还有） */
export const MAX_BACKLOG = 2;

/**
 * 离线识别：在浏览器里用 Whisper。
 * 课堂转写按停顿自动切段并做远场处理；双语对话（hold）松开按钮后整段识别。
 */
export class WhisperRecognizer extends SegmentRecognizer {
  readonly kind = "whisper" as const;
  private failedSegments = 0;

  constructor(purpose: "lecture" | "conversation" = "lecture") {
    super("离线识别", {
      hold: purpose === "conversation",
      profile: purpose === "conversation" ? "near" : "far",
      maxBacklog: MAX_BACKLOG,
      concurrency: 1,
    });
  }

  protected hint(): string {
    return "（离线识别：每段说完后出字）";
  }

  protected backlogMessage(): string {
    return "手机离线识别速度跟不上，部分段落已跳过（录音备份里仍然有）。联网时用联网识别会更流畅。";
  }

  protected async transcribe(audio: Float32Array, info: SegmentInfo, lang: Lang): Promise<string> {
    const began = Date.now();
    try {
      const text = await transcribeOffline(audio, LANGS[lang].whisper);
      this.failedSegments = 0;
      diag(
        `离线识别：第 ${info.seg} 段（${info.seconds.toFixed(1)} 秒，音量 ${info.speechRms.toFixed(4)}，放大 ${info.gain.toFixed(1)} 倍）识别用了 ${((Date.now() - began) / 1000).toFixed(1)} 秒，得到 ${text.length} 字`,
      );
      return text;
    } catch (e) {
      // 模型进程崩溃后下一段会自动重建，只在第一次失败时提示，避免每段都刷报错
      this.failedSegments++;
      diag(`离线识别：识别失败 ${e instanceof Error ? e.message : e}`);
      if (this.failedSegments === 1) this.handlers?.onError?.(`离线识别失败：${e instanceof Error ? e.message : e}，正在自动重试`);
      return "";
    }
  }
}
