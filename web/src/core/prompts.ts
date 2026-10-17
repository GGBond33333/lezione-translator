import { LANGS } from "./languages";
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
