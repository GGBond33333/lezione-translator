import { describe, expect, it, vi } from "vitest";
import type { Utterance } from "../storage/db";
import { chunkForRefine, toMarkdown } from "./export";
import { estimateConversation, estimateLivePerHour, estimateRefine, usageCost } from "./models-catalog";
import { OpusMtTranslator, pivotPairs } from "./opusMtTranslator";
import {
  CONTEXT_MAX_TURNS,
  conversationUserMessage,
  liveUserMessage,
  parseGlossaryJson,
  parseTagged,
  pickContext,
  stripGlossaryJson,
} from "./prompts";
import { chooseRecognizer, chooseTranslator, type RouteInput } from "./router";
import { TranslationQueue, type QueueDeps } from "./translationQueue";
import type { Translator } from "./translator";

describe("费用估算", () => {
  it("实时翻译每小时的预估与方案一致", () => {
    expect(estimateLivePerHour("offline")).toBe(0);
    expect(estimateLivePerHour("claude-haiku-5-5")).toBeCloseTo(0.05, 3);
    expect(estimateLivePerHour("claude-sonnet-5-5")).toBeCloseTo(0.8, 2);
    expect(estimateLivePerHour("claude-opus-5-5")).toBeCloseTo(2.0, 2);
  });

  it("课后精修 3 小时课的预估", () => {
    expect(estimateRefine("claude-haiku-5-5", 3)).toBeCloseTo(0.039, 3);
    expect(estimateRefine("claude-sonnet-5-5", 3)).toBeCloseTo(0.78, 2);
    expect(estimateRefine("claude-opus-5-5", 3)).toBeCloseTo(1.56, 2);
  });

  it("按 usage 计算实际花费，含缓存读写", () => {
    const cost = usageCost("claude-sonnet-5-5", {
      input_tokens: 1000,
      output_tokens: 500,
      cache_creation_input_tokens: 1000,
      cache_read_input_tokens: 10_000,
    });
    // (1000 + 1250 + 1000) * 2 / 1e6 + 500 * 10 / 1e6
    expect(cost).toBeCloseTo(0.0115, 6);
  });
});

describe("提示词与解析", () => {
  it("给句子加编号，带上一句作为上下文", () => {
    expect(liveUserMessage(["a", "b"], "prev")).toBe("Previous sentence (context only, do not translate): prev\n\n[1] a\n[2] b");
  });

  it("按编号解析译文", () => {
    expect(parseTagged("[1] 你好\n[2] 世界", 2)).toEqual(["你好", "世界"]);
    expect(parseTagged("[2] 世界\n[1] 你好", 2)).toEqual(["你好", "世界"]);
  });

  it("一句译文被拆成多行时合并", () => {
    expect(parseTagged("[1] 第一行\n第二行\n[2] 乙", 2)).toEqual(["第一行 第二行", "乙"]);
  });

  it("没有编号时兜底", () => {
    expect(parseTagged("只有一句", 1)).toEqual(["只有一句"]);
    expect(parseTagged("甲\n乙", 2)).toEqual(["甲", "乙"]);
    expect(parseTagged("乱七八糟的输出", 3)).toEqual(["乱七八糟的输出", "", ""]);
  });

  it("从笔记中提取术语 JSON", () => {
    const notes = '## 要点\n- x\n\n```json\n[{"source":"Monteverdi","target":"蒙特威尔第"},{"bad":1}]\n```';
    expect(parseGlossaryJson(notes)).toEqual([{ source: "Monteverdi", target: "蒙特威尔第" }]);
    expect(stripGlossaryJson(notes)).toBe("## 要点\n- x");
    expect(parseGlossaryJson("没有 JSON")).toEqual([]);
  });
});

describe("双语对话", () => {
  const turn = (i: number, from: "zh" | "it" = "zh") => ({ from, source: `原文${i}`, translation: `traduzione ${i}` });

  it("对话每 100 句的预估费用", () => {
    expect(estimateConversation("offline")).toBe(0);
    expect(estimateConversation("claude-haiku-5-5")).toBeCloseTo(0.015, 4);
    expect(estimateConversation("claude-sonnet-5-5")).toBeCloseTo(0.24, 4);
    expect(estimateConversation("claude-opus-5-5")).toBeCloseTo(0.6, 4);
  });

  it("翻译时附带最近 12 句前文，跳过翻译失败的句子", () => {
    const history = Array.from({ length: 20 }, (_, i) => turn(i));
    history[19] = { ...history[19], translation: "" };
    const ctx = pickContext(history);
    expect(ctx.length).toBe(CONTEXT_MAX_TURNS);
    expect(ctx[0].source).toBe("原文7");
    expect(ctx[ctx.length - 1].source).toBe("原文18");
  });

  it("前文太长时只保留最近的部分", () => {
    const long = { from: "it" as const, source: "x".repeat(2000), translation: "y".repeat(2000) };
    expect(pickContext([turn(1), long, turn(2)]).map((t) => t.source)).toEqual(["原文2"]);
    // 最近一句本身很长时仍然保留
    expect(pickContext([turn(1), long]).map((t) => t.source)).toEqual([long.source]);
  });

  it("用户消息包含前文和要翻译的句子", () => {
    const msg = conversationUserMessage("Dove devo firmare?", "it", "zh", [turn(1), turn(2, "it")]);
    expect(msg).toContain("Conversation so far");
    expect(msg).toContain("[中文] 原文1\n  → traduzione 1");
    expect(msg).toContain("[Italiano] 原文2");
    expect(msg.endsWith("Translate this Italian utterance into Simplified Chinese:\nDove devo firmare?")).toBe(true);
    expect(conversationUserMessage("你好", "zh", "it", [])).toBe("Translate this Simplified Chinese utterance into Italian:\n你好");
  });
});

describe("引擎选择", () => {
  const base: RouteInput = {
    mode: "auto",
    online: true,
    hasApiKey: true,
    offlineReady: true,
    webSpeech: true,
    liveModel: "claude-opus-5-5",
    spentUsd: 0,
    capUsd: 3,
  };

  it("联网有 Key 时用所选模型", () => {
    expect(chooseTranslator(base)).toEqual({ engine: "claude", model: "claude-opus-5-5", downgraded: false });
  });

  it("超过费用上限先降到 Haiku，再降到离线", () => {
    expect(chooseTranslator({ ...base, spentUsd: 3 })).toEqual({ engine: "claude", model: "claude-haiku-5-5", downgraded: true });
    expect(chooseTranslator({ ...base, liveModel: "claude-haiku-5-5", spentUsd: 5 })).toEqual({ engine: "offline" });
    expect(chooseTranslator({ ...base, liveModel: "claude-haiku-5-5", spentUsd: 5, offlineReady: false }).engine).toBe("none");
    expect(chooseTranslator({ ...base, spentUsd: 100, capUsd: 0 }).engine).toBe("claude");
  });

  it("没网或没 Key 时回退离线", () => {
    expect(chooseTranslator({ ...base, online: false })).toEqual({ engine: "offline" });
    expect(chooseTranslator({ ...base, hasApiKey: false })).toEqual({ engine: "offline" });
    expect(chooseTranslator({ ...base, hasApiKey: false, mode: "online" }).engine).toBe("none");
    expect(chooseTranslator({ ...base, mode: "offline" })).toEqual({ engine: "offline" });
    expect(chooseTranslator({ ...base, online: false, offlineReady: false }).engine).toBe("none");
  });

  it("识别引擎：联网用浏览器识别，离线用 Whisper", () => {
    expect(chooseRecognizer(base)).toEqual({ engine: "webspeech" });
    expect(chooseRecognizer({ ...base, online: false })).toEqual({ engine: "whisper" });
    expect(chooseRecognizer({ ...base, mode: "offline", offlineReady: false }).engine).toBe("none");
    expect(chooseRecognizer({ ...base, webSpeech: false, offlineReady: false }).engine).toBe("none");
  });
});

describe("离线翻译经英语中转", () => {
  it("意→中走 it-en、en-zh", async () => {
    expect(pivotPairs("it", "zh")).toEqual(["it-en", "en-zh"]);
    const calls: string[] = [];
    const t = new OpusMtTranslator(async (pair, text) => {
      calls.push(pair);
      return `${text}>${pair}`;
    });
    const res = await t.translate(["ciao"], { from: "it", to: "zh" });
    expect(res.translations).toEqual(["ciao>it-en>en-zh"]);
    expect(calls).toEqual(["it-en", "en-zh"]);
    expect(res.costUsd).toBe(0);
  });
});

function utt(seq: number, source = `s${seq}`): Utterance {
  return { sessionId: "x", seq, lang: "it", source, status: "pending", at: 1000 + seq * 1000 };
}

function fakeTranslator(engine: string, impl?: (s: string[]) => Promise<string[]>): Translator & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    engine,
    calls,
    async translate(sentences) {
      calls.push(sentences);
      const translations = impl ? await impl(sentences) : sentences.map((s) => `${engine}:${s}`);
      return { translations, costUsd: 0.01, engine };
    },
  };
}

function deps(over: Partial<QueueDeps> = {}): QueueDeps & { notices: string[]; cost: number } {
  const d = {
    notices: [] as string[],
    cost: 0,
    route: () => ({ engine: "claude", model: "claude-haiku-5-5", downgraded: false }) as const,
    online: () => fakeTranslator("claude"),
    offline: () => null,
    context: () => ({ from: "it", to: "zh" }) as const,
    onUpdate: () => undefined,
    onCost(usd: number) {
      d.cost += usd;
    },
    onNotice(m: string) {
      d.notices.push(m);
    },
    ...over,
  };
  return d;
}

describe("翻译队列", () => {
  it("每 3 句合并成一个请求", async () => {
    const online = fakeTranslator("claude");
    const q = new TranslationQueue(deps({ online: () => online }), 3, 10_000);
    const list = [utt(0), utt(1), utt(2), utt(3)];
    list.forEach((u) => q.push(u));
    await q.idle();
    expect(online.calls).toEqual([["s0", "s1", "s2"]]);
    await q.flush();
    expect(online.calls[1]).toEqual(["s3"]);
    expect(list.every((u) => u.status === "done")).toBe(true);
    expect(list[0].translation).toBe("claude:s0");
  });

  it("等待超时后发送不满一批的句子", async () => {
    vi.useFakeTimers();
    const online = fakeTranslator("claude");
    const q = new TranslationQueue(deps({ online: () => online }), 3, 2500);
    q.push(utt(0));
    expect(online.calls.length).toBe(0);
    await vi.advanceTimersByTimeAsync(2600);
    expect(online.calls).toEqual([["s0"]]);
    vi.useRealTimers();
  });

  it("联网失败时回退离线翻译", async () => {
    const offline = fakeTranslator("offline");
    const d = deps({
      online: () => fakeTranslator("claude", () => Promise.reject(new Error("network"))),
      offline: () => offline,
    });
    const q = new TranslationQueue(d, 1);
    const u = utt(0);
    q.push(u);
    await q.idle();
    expect(u.translation).toBe("offline:s0");
    expect(u.engine).toBe("offline");
    expect(d.notices.length).toBe(1);
  });

  it("都不可用时标记待补翻，恢复后补上", async () => {
    let fail = true;
    const d = deps({
      online: () => fakeTranslator("claude", async (s) => (fail ? Promise.reject(new Error("down")) : s.map((x) => `ok:${x}`))),
    });
    const q = new TranslationQueue(d, 2);
    const a = utt(0);
    const b = utt(1);
    q.push(a);
    q.push(b);
    await q.idle();
    expect(a.status).toBe("pending");
    expect(q.pendingCount).toBe(2);
    fail = false;
    await q.retryPending();
    expect([a.translation, b.translation]).toEqual(["ok:s0", "ok:s1"]);
    expect(q.pendingCount).toBe(0);
  });

  it("累计费用", async () => {
    const d = deps();
    const q = new TranslationQueue(d, 1);
    q.push(utt(0));
    q.push(utt(1));
    await q.idle();
    expect(d.cost).toBeCloseTo(0.02);
  });
});

describe("导出", () => {
  const session = {
    id: "x",
    kind: "lecture" as const,
    title: "音乐史",
    sourceLang: "it" as const,
    startedAt: 1000,
    costUsd: 0,
    notes: "## 本课要点\n- 巴洛克",
  };

  it("双语 Markdown 带时间戳，精修译文优先", () => {
    const list = [
      { ...utt(0, "Buongiorno"), translation: "早上好" },
      { ...utt(65, "Il basso continuo"), translation: "低音", refined: "通奏低音" },
      utt(3700, "Fine"),
    ];
    const md = toMarkdown(session, list);
    expect(md).toContain("## 本课要点");
    expect(md).toContain("**[00:00]** Buongiorno\n> 早上好");
    expect(md).toContain("**[01:05]** Il basso continuo\n> 通奏低音");
    expect(md).toContain("**[1:01:40]** Fine\n> （未翻译）");
  });

  it("精修时按字数分段", () => {
    const list = Array.from({ length: 10 }, (_, i) => utt(i, "x".repeat(40)));
    const chunks = chunkForRefine(list, 100);
    expect(chunks.map((c) => c.length)).toEqual([2, 2, 2, 2, 2]);
    expect(chunkForRefine([], 100)).toEqual([]);
  });
});
