export type Lang = "it" | "zh";

export interface LangInfo {
  code: Lang;
  /** 界面上显示的名称 */
  label: string;
  flag: string;
  /** Web Speech API 和 speechSynthesis 用的 locale */
  locale: string;
  /** Whisper 的 language 参数 */
  whisper: string;
  /** 给大模型的语言名 */
  promptName: string;
}

export const LANGS: Record<Lang, LangInfo> = {
  it: {
    code: "it",
    label: "意大利语",
    flag: "🇮🇹",
    locale: "it-IT",
    whisper: "italian",
    promptName: "Italian",
  },
  zh: {
    code: "zh",
    label: "中文",
    flag: "🇨🇳",
    locale: "zh-CN",
    whisper: "chinese",
    promptName: "Simplified Chinese",
  },
};

export function other(lang: Lang): Lang {
  return lang === "it" ? "zh" : "it";
}
