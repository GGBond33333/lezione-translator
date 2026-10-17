import { getCourse, getSession, listUtterances, saveSession, saveUtterances } from "../storage/db";
import { claudeTranslator } from "./engines";
import { chunkForRefine } from "./export";
import { other } from "./languages";
import type { OnlineModelId } from "./models-catalog";
import { parseGlossaryJson, stripGlossaryJson } from "./prompts";
import type { GlossaryEntry } from "./translator";

export interface RefineProgress {
  step: string;
  done: number;
  total: number;
  costUsd: number;
}

/**
 * 课后精修：把整节课分段重新翻译，然后生成课堂笔记。
 * 每段完成后立即保存，中途失败已完成的部分不会丢。
 */
export async function refineSession(
  sessionId: string,
  model: OnlineModelId,
  onProgress: (p: RefineProgress) => void,
): Promise<{ glossary: GlossaryEntry[]; costUsd: number }> {
  const session = await getSession(sessionId);
  if (!session) throw new Error("找不到这节课");
  const course = await getCourse(session.courseId);
  const list = await listUtterances(sessionId);
  if (!list.length) throw new Error("这节课没有内容");

  const t = claudeTranslator(model);
  const ctx = {
    from: session.sourceLang,
    to: other(session.sourceLang),
    course: course?.name,
    glossary: course?.glossary,
  };
  const chunks = chunkForRefine(list);
  const total = chunks.length + 1;
  let cost = 0;

  for (let i = 0; i < chunks.length; i++) {
    onProgress({ step: `精修译文 第 ${i + 1}/${chunks.length} 段`, done: i, total, costUsd: cost });
    const chunk = chunks[i];
    const res = await t.refineChunk(chunk.map((u) => u.source), ctx);
    cost += res.costUsd;
    chunk.forEach((u, j) => {
      if (res.translations[j]) u.refined = res.translations[j];
    });
    await saveUtterances(chunk);
  }

  onProgress({ step: "生成课堂笔记", done: chunks.length, total, costUsd: cost });
  const transcript = list.map((u) => u.source).join("\n");
  const { notes, costUsd } = await t.notes(transcript, ctx);
  cost += costUsd;

  const latest = (await getSession(sessionId)) ?? session;
  await saveSession({
    ...latest,
    notes: stripGlossaryJson(notes),
    refinedAt: Date.now(),
    costUsd: latest.costUsd + cost,
  });
  onProgress({ step: "完成", done: total, total, costUsd: cost });
  return { glossary: parseGlossaryJson(notes), costUsd: cost };
}
