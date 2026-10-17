import type { Session, Utterance } from "../storage/db";
import { LANGS } from "./languages";

function time(ts: number, start: number): string {
  const s = Math.max(0, Math.floor((ts - start) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(sec).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function bestTranslation(u: Utterance): string {
  return u.refined || u.translation || "";
}

/** 导出双语 Markdown：原文在上、译文在下，带时间戳；有课后笔记时附在开头 */
export function toMarkdown(session: Session, list: Utterance[]): string {
  const date = new Date(session.startedAt).toLocaleString("zh-CN");
  const lines = [`# ${session.title}`, "", `${date} · ${LANGS[session.sourceLang].label}`, ""];
  if (session.notes) lines.push(session.notes, "", "---", "", "## 双语全文", "");
  for (const u of list) {
    lines.push(`**[${time(u.at, session.startedAt)}]** ${u.source}`);
    const t = bestTranslation(u);
    lines.push(t ? `> ${t}` : "> （未翻译）", "");
  }
  return lines.join("\n");
}

export function toPlainText(session: Session, list: Utterance[]): string {
  const lines = [session.title, ""];
  for (const u of list) {
    lines.push(`[${time(u.at, session.startedAt)}] ${u.source}`, bestTranslation(u) || "（未翻译）", "");
  }
  return lines.join("\n");
}

/** 把原文切成若干段用于课后精修，每段不超过 maxChars 个字符 */
export function chunkForRefine(list: Utterance[], maxChars = 12_000): Utterance[][] {
  const chunks: Utterance[][] = [];
  let cur: Utterance[] = [];
  let size = 0;
  for (const u of list) {
    if (cur.length && size + u.source.length > maxChars) {
      chunks.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(u);
    size += u.source.length;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

/** 分享或下载文件：iOS 上优先用系统分享面板，可以直接存到"文件"或发给微信 */
export async function shareFile(name: string, content: string | Blob, type = "text/markdown"): Promise<void> {
  const blob = typeof content === "string" ? new Blob([content], { type: `${type};charset=utf-8` }) : content;
  const file = new File([blob], name, { type: blob.type || type });
  const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
  if (nav.canShare?.({ files: [file] })) {
    try {
      await nav.share({ files: [file], title: name });
      return;
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
