import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import {
  countAudioChunks,
  deleteSession,
  findUnfinishedLecture,
  getSession,
  purgeOldConversations,
  listAudioChunks,
  listUtterances,
  saveAudioChunk,
  saveSession,
  saveUtterance,
  saveUtterances,
  type Session,
} from "./db";

const session = (id: string, extra: Partial<Session> = {}): Session => ({
  id,
  kind: "lecture",
  title: id,
  sourceLang: "it",
  startedAt: Date.now(),
  costUsd: 0,
  ...extra,
});

describe("本机存储", () => {
  it("按会话保存和读取句子，并按顺序返回", async () => {
    await saveSession(session("a"));
    await saveSession(session("b"));
    await saveUtterances([
      { sessionId: "a", seq: 2, lang: "it", source: "c", status: "done", at: 3 },
      { sessionId: "a", seq: 0, lang: "it", source: "a", status: "done", at: 1 },
      { sessionId: "b", seq: 0, lang: "it", source: "other", status: "done", at: 1 },
    ]);
    await saveUtterance({ sessionId: "a", seq: 1, lang: "it", source: "b", status: "pending", at: 2 });
    const list = await listUtterances("a");
    expect(list.map((u) => u.source)).toEqual(["a", "b", "c"]);
  });

  it("找到没有结束的课用于续录", async () => {
    await saveSession(session("done", { endedAt: Date.now(), startedAt: 1 }));
    await saveSession(session("open", { startedAt: Date.now() + 1000 }));
    expect((await findUnfinishedLecture())?.id).toBe("open");
  });

  it("超过保存期限的对话自动删除，课堂记录不受影响", async () => {
    const day = 86_400_000;
    const now = Date.now();
    await saveSession(session("c-old", { kind: "conversation", startedAt: now - 40 * day, endedAt: now - 31 * day }));
    await saveSession(session("c-recent", { kind: "conversation", startedAt: now - 40 * day, endedAt: now - 2 * day }));
    await saveSession(session("l-old", { startedAt: now - 100 * day, endedAt: now - 99 * day }));
    await saveUtterance({ sessionId: "c-old", seq: 0, lang: "zh", source: "你好", status: "done", at: 1 });

    expect(await purgeOldConversations(0, now)).toBe(0); // 0 = 永久保存
    expect(await purgeOldConversations(30, now)).toBe(1);
    expect(await getSession("c-old")).toBeUndefined();
    expect(await listUtterances("c-old")).toEqual([]);
    expect((await getSession("c-recent"))?.id).toBe("c-recent");
    expect((await getSession("l-old"))?.id).toBe("l-old");
  });

  it("录音分段按顺序保存，删除会话时一起删除", async () => {
    await saveSession(session("rec"));
    await saveAudioChunk("rec", 0, new Blob(["one"]));
    await saveAudioChunk("rec", 1, new Blob(["two"]));
    await saveUtterance({ sessionId: "rec", seq: 0, lang: "it", source: "x", status: "done", at: 1 });
    expect(await countAudioChunks("rec")).toBe(2);
    expect((await listAudioChunks("rec")).length).toBe(2);
    await deleteSession("rec");
    expect(await countAudioChunks("rec")).toBe(0);
    expect(await listUtterances("rec")).toEqual([]);
  });
});
