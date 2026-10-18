import { LANGS, type Lang } from "./languages";
import type { GlossaryEntry, TranslateContext } from "./translator";

function glossaryBlock(glossary?: GlossaryEntry[]): string {
  if (!glossary?.length) return "";
  const lines = glossary.map((g) => `- ${g.source} → ${g.target}`).join("\n");
  return `\n\nAlways use these fixed translations for terms and names:\n${lines}`;
}

/** 实时翻译的系统提示。内容保持稳定，便于缓存。 */
export function liveSystemPrompt(ctx: TranslateContext): string {
  const from = LANGS[ctx.from].promptName;
  const to = LANGS[ctx.to].promptName;
  const course = ctx.course ? ` The lecture is from the course "${ctx.course}".` : "";
  return (
    `You are a live interpreter for an international student at an Italian university. ` +
    `Translate spoken ${from} into natural, fluent ${to}.${course}\n\n` +
    `The input comes from speech recognition, so it may contain misheard words, missing punctuation, or fragments. ` +
    `Infer the intended meaning from context and translate that; do not comment on recognition errors. ` +
    `Keep proper names recognizable: for well-known people, works and places use the standard ${to} name, ` +
    `and for less-known names keep the original spelling.\n\n` +
    `Input lines are tagged [1], [2], ... Reply with exactly one line per input line, starting with the same tag, ` +
    `followed only by the translation. Do not add explanations.` +
    glossaryBlock(ctx.glossary)
  );
}

export function liveUserMessage(sentences: string[], previous?: string): string {
  const ctx = previous ? `Previous sentence (context only, do not translate): ${previous}\n\n` : "";
  return ctx + sentences.map((s, i) => `[${i + 1}] ${s}`).join("\n");
}

/** 解析带编号的输出；数量对不上时尽量对齐，返回与输入同样长度的数组 */
export function parseTagged(output: string, count: number): string[] {
  const result: string[] = new Array(count).fill("");
  const re = /^\s*\[(\d+)\]\s*(.*)$/;
  let matched = 0;
  let lastIdx = -1;
  for (const line of output.split(/\r?\n/)) {
    const m = re.exec(line);
    if (m) {
      const idx = Number(m[1]) - 1;
      if (idx >= 0 && idx < count) {
        result[idx] = m[2].trim();
        lastIdx = idx;
        matched++;
      }
    } else if (lastIdx >= 0 && line.trim()) {
      // 模型把一句译文拆成了多行
      result[lastIdx] = `${result[lastIdx]} ${line.trim()}`.trim();
    }
  }
  if (matched === 0) {
    const text = output.trim();
    if (count === 1) result[0] = text;
    else {
      const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      if (lines.length === count) lines.forEach((l, i) => (result[i] = l));
      else result[0] = text;
    }
  }
  return result;
}

// —— 双语对话 ——
export interface ConversationTurn {
  from: Lang;
  source: string;
  translation: string;
}

/** 翻译时附带的前文：最多 MAX_TURNS 句、MAX_CHARS 个字符，从最近的往前取 */
export const CONTEXT_MAX_TURNS = 12;
const CONTEXT_MAX_CHARS = 3000;

export function pickContext(history: ConversationTurn[]): ConversationTurn[] {
  const picked: ConversationTurn[] = [];
  let chars = 0;
  for (let i = history.length - 1; i >= 0 && picked.length < CONTEXT_MAX_TURNS; i--) {
    const t = history[i];
    if (!t.translation) continue;
    chars += t.source.length + t.translation.length;
    if (chars > CONTEXT_MAX_CHARS && picked.length) break;
    picked.unshift(t);
  }
  return picked;
}

/** 双语对话的系统提示：两个方向共用同一段，内容稳定便于缓存 */
export function conversationSystemPrompt(): string {
  return (
    `You are a live interpreter in a face-to-face conversation between a Chinese international student in Italy ` +
    `and an Italian speaker (for example at a university office, a doctor, a bank, a shop, or with a flatmate). ` +
    `Each turn you translate one utterance: Simplified Chinese into natural spoken Italian, or Italian into natural Simplified Chinese.\n\n` +
    `The utterance comes from speech recognition and may contain misheard words or missing punctuation; infer what was meant. ` +
    `Use the earlier conversation to resolve pronouns, omitted subjects, names, document names and the level of formality ` +
    `(use the polite "Lei" form in Italian unless the conversation is clearly informal). ` +
    `Keep the translation as short and direct as the original: it will be shown on screen and read aloud.\n\n` +
    `Reply with only the translation, without quotes, notes or explanations.`
  );
}

const LANG_TAG: Record<Lang, string> = { zh: "中文", it: "Italiano" };

export function conversationUserMessage(text: string, from: Lang, to: Lang, history: ConversationTurn[]): string {
  const ctx = pickContext(history);
  const lines = ctx.map((t) => `[${LANG_TAG[t.from]}] ${t.source}\n  → ${t.translation}`).join("\n");
  const prefix = lines ? `Conversation so far (context only, do not translate again):\n${lines}\n\n` : "";
  return `${prefix}Translate this ${LANGS[from].promptName} utterance into ${LANGS[to].promptName}:\n${text}`;
}

/** 课后精修：逐段重新翻译（上下文更完整） */
export function refineSystemPrompt(ctx: TranslateContext): string {
  const from = LANGS[ctx.from].promptName;
  const to = LANGS[ctx.to].promptName;
  const course = ctx.course ? ` from the course "${ctx.course}"` : "";
  return (
    `You are revising the transcript of a university lecture${course}, recorded with speech recognition in ${from}. ` +
    `Produce a careful, accurate ${to} translation for a student who will study from it. ` +
    `Use surrounding lines to fix misrecognized words, names, dates and technical terms. ` +
    `Input lines are tagged [1], [2], ... Reply with exactly one line per input line, with the same tag, followed only by the translation.` +
    glossaryBlock(ctx.glossary)
  );
}

/** 课后笔记：要点、时间线、术语表；最后附一段 JSON 术语表便于一键加入课程 */
export function notesSystemPrompt(ctx: TranslateContext): string {
  const from = LANGS[ctx.from].promptName;
  const course = ctx.course ? ` from the course "${ctx.course}"` : "";
  return (
    `You are helping a Chinese international student study a university lecture${course}. ` +
    `You will receive the full ${from} transcript (from speech recognition, may contain errors). ` +
    `Write study notes in Simplified Chinese using Markdown with these sections:\n` +
    `## 本课要点 — the main ideas, as concise bullet points\n` +
    `## 时间线 — dated events in order, if the lecture covers history (omit the section if there are none)\n` +
    `## 人名、作品与术语 — a table with columns: 原文 | 中文 | 说明\n` +
    `## 可能识别错误的地方 — places where the transcript is likely wrong and what was probably said\n\n` +
    `After the notes, output a fenced code block tagged json containing an array of {"source": original term, "target": Chinese term} ` +
    `for the key names and terms, so they can be added to the course glossary.` +
    glossaryBlock(ctx.glossary)
  );
}

export function parseGlossaryJson(notes: string): GlossaryEntry[] {
  const m = /```json\s*([\s\S]*?)```/i.exec(notes);
  if (!m) return [];
  try {
    const arr = JSON.parse(m[1]);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((x) => x && typeof x.source === "string" && typeof x.target === "string")
      .map((x) => ({ source: x.source.trim(), target: x.target.trim() }))
      .filter((x) => x.source && x.target);
  } catch {
    return [];
  }
}

export function stripGlossaryJson(notes: string): string {
  return notes.replace(/```json[\s\S]*?```/i, "").trim();
}
