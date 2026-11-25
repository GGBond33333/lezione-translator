import { diag } from "./diagLog";
import { encodeWav } from "./farField";
import { LANGS, type Lang } from "./languages";
import { transcribeOffline } from "./mlClient";
import { ASR_NAME, AsrError, asrCost, transcribeCloud } from "./openaiAsr";
import { SegmentRecognizer, type SegmentInfo } from "./segmentRecognizer";

export interface CloudRecognizerOptions {
  apiKey: string;
  /** 课程术语表的原文，作为识别提示词（人名、作品名更容易认对） */
  keywords: string[];
  courseName?: string;
  /** 下载过离线模型时，云端失败的段落改用离线识别 */
  offlineFallback: boolean;
  /** 测试时注入 */
  fetchImpl?: typeof fetch;
  transcribeOfflineImpl?: typeof transcribeOffline;
}

/**
 * 云端远场识别：远场收音 + 按停顿切段 + 自动增益，每段上传 OpenAI 识别。
 * 最多 2 段同时上传，结果按顺序输出；失败重试一次，再失败就用离线模型或提示（录音备份里仍然有）。
 */
export class CloudRecognizer extends SegmentRecognizer {
  readonly kind = "cloud" as const;
  private lastText = "";
  private failStreak = 0;
  private disabledReason = "";

  constructor(private readonly o: CloudRecognizerOptions) {
    super("云端识别", { hold: false, profile: "far", maxBacklog: 6, concurrency: 2 });
  }

  protected hint(): string {
    return "（云端远场识别：每句说完后出字）";
  }

  protected async transcribe(audio: Float32Array, info: SegmentInfo, lang: Lang): Promise<string> {
    const began = Date.now();
    if (!this.disabledReason) {
      const request = {
        wav: encodeWav(audio),
        lang,
        keywords: this.o.keywords,
        prompt: [this.o.courseName ? `课程：${this.o.courseName}。` : "", this.lastText.slice(-200)].join(""),
      };
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const text = await transcribeCloud(this.o.apiKey, request, this.o.fetchImpl);
          this.handlers?.onCost?.(asrCost(info.seconds));
          this.failStreak = 0;
          if (text) this.lastText = text;
          diag(
            `云端识别：第 ${info.seg} 段（${info.seconds.toFixed(1)} 秒，音量 ${info.speechRms.toFixed(4)}，放大 ${info.gain.toFixed(1)} 倍）用了 ${((Date.now() - began) / 1000).toFixed(1)} 秒，得到 ${text.length} 字`,
          );
          return text;
        } catch (e) {
          const err = e instanceof AsrError ? e : new AsrError(String(e), 0);
          diag(`云端识别：第 ${info.seg} 段第 ${attempt} 次失败：${err.message}（${err.status}）`);
          if (err.permanent) {
            // Key 错误、模型停用等：后面的段落不再上传，避免一直失败
            this.disabledReason = err.message;
            this.handlers?.onError?.(
              `${ASR_NAME} 无法使用：${err.message}。${this.o.offlineFallback ? "暂时改用离线识别，" : ""}请到设置里检查 OpenAI Key。`,
            );
            break;
          }
          if (attempt === 1) await new Promise((r) => setTimeout(r, 1_000));
          else {
            this.failStreak++;
            if (this.failStreak === 1)
              this.handlers?.onError?.(
                `云端识别暂时失败（${err.message}）${this.o.offlineFallback ? "，这段改用离线识别" : "，这段内容保留在录音备份里"}。`,
              );
          }
        }
      }
    }
    if (!this.o.offlineFallback) return "";
    try {
      const text = await (this.o.transcribeOfflineImpl ?? transcribeOffline)(audio, LANGS[lang].whisper);
      diag(`云端识别：第 ${info.seg} 段改用离线识别，得到 ${text.length} 字`);
      return text;
    } catch (e) {
      diag(`云端识别：第 ${info.seg} 段离线识别也失败 ${e instanceof Error ? e.message : e}`);
      return "";
    }
  }
}
