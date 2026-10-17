import type { Lang } from "./languages";
import type { TranslateContext, TranslateResult, Translator } from "./translator";

/** 执行单个语言对翻译的函数（实际由 Worker 里的 Opus-MT 模型完成） */
export type PairFn = (pair: string, text: string) => Promise<string>;

/** 意大利语和中文之间没有直接互译的 Opus-MT 模型，经英语中转 */
export function pivotPairs(from: Lang, to: Lang): string[] {
  if (from === to) return [];
  return [`${from}-en`, `en-${to}`];
}

export class OpusMtTranslator implements Translator {
  readonly engine = "离线 Opus-MT";

  constructor(private pairFn: PairFn) {}

  async translate(sentences: string[], ctx: TranslateContext): Promise<TranslateResult> {
    const pairs = pivotPairs(ctx.from, ctx.to);
    const translations: string[] = [];
    for (const s of sentences) {
      let text = s;
      for (const pair of pairs) text = await this.pairFn(pair, text);
      translations.push(text);
    }
    return { translations, costUsd: 0, engine: this.engine };
  }
}
