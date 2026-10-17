import type { Lang } from "./languages";

export interface GlossaryEntry {
  source: string;
  target: string;
}

export interface TranslateContext {
  from: Lang;
  to: Lang;
  /** 课程名，帮助模型理解领域 */
  course?: string;
  glossary?: GlossaryEntry[];
  /** 上一句原文，帮助理解指代和断句 */
  previous?: string;
}

export interface TranslateResult {
  translations: string[];
  /** 本次请求的花费（美元），离线为 0 */
  costUsd: number;
  engine: string;
}

export interface Translator {
  readonly engine: string;
  /** 一次翻译多句，返回顺序与输入一致 */
  translate(sentences: string[], ctx: TranslateContext): Promise<TranslateResult>;
}
