import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudRecognizer } from "./cloudRecognizer";
import { encodeWav, MAX_GAIN, normalizeSegment, Segmenter, TARGET_RMS, frameRms } from "./farField";
import { ASR_MODEL, asrCost, buildTranscribeForm, cleanKeywords } from "./openaiAsr";
import { chooseRecognizer } from "./router";
import type { SegmentInfo } from "./segmentRecognizer";
import { SegmentQueue } from "./segmentRecognizer";

const RATE = 48_000;
const FRAME = 4096; // 约 85 毫秒

/** 合成一帧：底噪 + 可选的"说话声"（正弦波） */
let seed = 1;
function noise() {
  seed = (seed * 16807) % 2147483647;
  return (seed / 2147483647) * 2 - 1;
}
function frame(noiseAmp: number, speechAmp = 0, offset = 0): Float32Array {
  const f = new Float32Array(FRAME);
  for (let i = 0; i < FRAME; i++) f[i] = noise() * noiseAmp + speechAmp * Math.sin(((offset + i) * 2 * Math.PI * 220) / RATE);
  return f;
}
/** 生成 seconds 秒的帧 */
function frames(seconds: number, noiseAmp: number, speechAmp = 0): Float32Array[] {
  return Array.from({ length: Math.round((seconds * RATE) / FRAME) }, (_, k) => frame(noiseAmp, speechAmp, k * FRAME));
}

describe("按停顿切段", () => {
  it("老师离得远、声音很小，也能和底噪区分开，在停顿处切段", () => {
    const seg = new Segmenter(RATE);
    const out = [
      ...frames(2, 0.001), // 安静教室，学会底噪
      ...frames(3, 0.001, 0.006), // 远处的小声讲话（只比底噪高几倍）
      ...frames(1, 0.001), // 停顿
      ...frames(4, 0.001, 0.006),
      ...frames(1, 0.001),
    ].flatMap((f) => seg.push(f));
    expect(out).toHaveLength(2);
    expect(out[0].samples.length / RATE).toBeGreaterThan(2.9);
    expect(out[0].samples.length / RATE).toBeLessThan(4);
    expect(out[1].samples.length / RATE).toBeGreaterThan(3.9);
    // 说话部分音量接近 0.006 的正弦波（有效值约 0.0042）
    expect(out[0].speechRms).toBeGreaterThan(0.003);
  });

  it("一直不停地讲（只有字与字之间的短暂空隙）时，每段不超过 25 秒，也不会漏掉内容", () => {
    const seg = new Segmenter(RATE);
    // 每 2 秒话之间只停 0.17 秒，比切段需要的停顿短
    const talk = Array.from({ length: 28 }, () => [...frames(2, 0.001, 0.02), ...frames(0.17, 0.001)]).flat();
    const out = [...frames(1, 0.001), ...talk].flatMap((f) => seg.push(f));
    const last = seg.flush();
    const all = last ? [...out, last] : out;
    expect(all.length).toBeGreaterThanOrEqual(2);
    for (const s of all) expect(s.samples.length / RATE).toBeLessThanOrEqual(25.1);
    const total = all.reduce((n, s) => n + s.samples.length, 0) / RATE;
    expect(total).toBeGreaterThan(59);
    // 连续讲很久后，底噪仍然停在真正的底噪附近
    expect(seg.floor).toBeLessThan(0.003);
  });

  it("只有底噪（空调、翻书声很小）时不产生段落", () => {
    const seg = new Segmenter(RATE);
    const out = frames(30, 0.002).flatMap((f) => seg.push(f));
    expect(out).toHaveLength(0);
    expect(seg.flush()).toBeNull();
  });

  it("很短的一声（咳嗽）被丢掉，不送去识别", () => {
    const seg = new Segmenter(RATE);
    const out = [...frames(2, 0.001), ...frames(0.17, 0.001, 0.05), ...frames(3, 0.001)].flatMap((f) => seg.push(f));
    expect(out).toHaveLength(0);
  });

  it("开头保留一小段，避免吃掉第一个字", () => {
    const seg = new Segmenter(RATE);
    const out = [...frames(2, 0.001), ...frames(3, 0.001, 0.01), ...frames(1, 0.001)].flatMap((f) => seg.push(f));
    expect(out).toHaveLength(1);
    // 3 秒说话 + 约 0.3 秒开头 + 约 0.6 秒停顿
    expect(out[0].samples.length / RATE).toBeGreaterThan(3.5);
  });
});

describe("自动增益", () => {
  it("远处的小声放大到目标音量，但最多放大 20 倍", () => {
    const quiet = frame(0, 0.02);
    const { samples, gain } = normalizeSegment(quiet, frameRms(quiet));
    expect(gain).toBeCloseTo(TARGET_RMS / frameRms(quiet), 1);
    expect(frameRms(samples)).toBeGreaterThan(0.08);
    const veryQuiet = frame(0, 0.0005);
    expect(normalizeSegment(veryQuiet, frameRms(veryQuiet)).gain).toBe(MAX_GAIN);
  });

  it("本来就够响的声音不放大，也不会超过 ±1（不爆音）", () => {
    const loud = frame(0, 0.9);
    const { samples, gain } = normalizeSegment(loud, frameRms(loud));
    expect(gain).toBe(1);
    expect(Math.max(...samples.map(Math.abs))).toBeLessThan(1);
  });
});

describe("WAV 编码", () => {
  it("文件头和数据长度正确", () => {
    const buf = encodeWav(new Float32Array([0, 0.5, -0.5, 1, -1]), 16_000);
    const v = new DataView(buf);
    const str = (o: number) => String.fromCharCode(...new Uint8Array(buf, o, 4));
    expect(str(0)).toBe("RIFF");
    expect(str(8)).toBe("WAVE");
    expect(str(36)).toBe("data");
    expect(v.getUint32(24, true)).toBe(16_000);
    expect(v.getUint32(40, true)).toBe(10);
    expect(buf.byteLength).toBe(54);
    expect(v.getInt16(44 + 2 * 3, true)).toBe(32767);
    expect(v.getInt16(44 + 2 * 4, true)).toBe(-32768);
  });
});

describe("云端识别请求", () => {
  it("关键词去掉换行和尖括号、去重、最多 50 个", () => {
    expect(cleanKeywords(["basso\ncontinuo", "<Monteverdi>", "monteverdi", "  ", "Risorgimento"])).toEqual([
      "basso continuo",
      "Monteverdi",
      "Risorgimento",
    ]);
    expect(cleanKeywords(Array.from({ length: 80 }, (_, i) => `t${i}`))).toHaveLength(50);
  });

  it("表单包含模型、语言、关键词和提示词", () => {
    const fd = buildTranscribeForm({ wav: encodeWav(new Float32Array(10)), lang: "it", keywords: ["Monteverdi", "a\nb"], prompt: "课程：音乐史。" });
    expect(fd.get("model")).toBe(ASR_MODEL);
    expect(fd.getAll("languages[]")).toEqual(["it"]);
    expect(fd.getAll("keywords[]")).toEqual(["Monteverdi", "a b"]);
    expect(fd.get("prompt")).toBe("课程：音乐史。");
    expect(fd.get("language")).toBeNull(); // 新模型不能同时发 language
    expect(buildTranscribeForm({ wav: new ArrayBuffer(44), lang: "zh", keywords: [], prompt: "" }).getAll("languages[]")).toEqual(["zh"]);
  });

  it("费用按音频时长计算：1 小时约 $0.27", () => {
    expect(asrCost(3600)).toBeCloseTo(0.27, 5);
  });
});

describe("云端识别容错", () => {
  const info: SegmentInfo = { seg: 1, seconds: 10, speechRms: 0.01, gain: 10 };
  const audio = new Float32Array(16_000);
  afterEach(() => vi.useRealTimers());

  function make(fetchImpl: typeof fetch, offlineFallback = false, offline = vi.fn(async () => "离线结果")) {
    const errors: string[] = [];
    const costs: number[] = [];
    const rec = new CloudRecognizer({ apiKey: "k", keywords: ["Monteverdi"], courseName: "音乐史", offlineFallback, fetchImpl, transcribeOfflineImpl: offline });
    (rec as unknown as { handlers: unknown }).handlers = {
      onPartial: () => undefined,
      onFinal: () => undefined,
      onError: (m: string) => errors.push(m),
      onCost: (c: number) => costs.push(c),
    };
    const run = () => (rec as unknown as { transcribe(a: Float32Array, i: SegmentInfo, l: string): Promise<string> }).transcribe(audio, info, "it");
    return { run, errors, costs, offline };
  }

  it("成功时返回文字并按时长计费", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ text: " Buongiorno " }), { status: 200 }));
    const { run, costs } = make(fetchImpl as unknown as typeof fetch);
    expect(await run()).toBe("Buongiorno");
    expect(costs[0]).toBeCloseTo(asrCost(10), 8);
    const body = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as FormData;
    expect(body.get("prompt")).toContain("音乐史");
  });

  it("网络错误重试一次，仍失败时改用离线识别", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    const { run, errors, offline } = make(fetchImpl as unknown as typeof fetch, true);
    const p = run();
    await vi.advanceTimersByTimeAsync(1_500);
    expect(await p).toBe("离线结果");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(offline).toHaveBeenCalledTimes(1);
    expect(errors[0]).toContain("改用离线识别");
  });

  it("Key 无效时不再重试，后面的段落也不再上传", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: { message: "bad key" } }), { status: 401 }));
    const { run, errors } = make(fetchImpl as unknown as typeof fetch, false);
    expect(await run()).toBe("");
    expect(await run()).toBe("");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(errors[0]).toContain("OpenAI Key 无效");
  });
});

describe("同时识别多段时按顺序输出", () => {
  it("后面的段落先识别完，也要等前面的段落", async () => {
    const results: string[] = [];
    const resolvers = new Map<number, () => void>();
    const q = new SegmentQueue<number, string>(
      (n) => new Promise((resolve) => resolvers.set(n, () => resolve(`句子${n}`))),
      { maxBacklog: 6, concurrency: 2, onResult: (r) => results.push(r) },
    );
    q.push(1);
    q.push(2);
    q.push(3);
    await vi.waitFor(() => expect(resolvers.size).toBe(2)); // 同时最多 2 段
    resolvers.get(2)!();
    await new Promise((r) => setTimeout(r, 0));
    expect(results).toEqual([]);
    resolvers.get(1)!();
    await vi.waitFor(() => expect(resolvers.size).toBe(3));
    resolvers.get(3)!();
    await q.idle();
    expect(results).toEqual(["句子1", "句子2", "句子3"]);
  });
});

describe("识别方式选择", () => {
  const base = { mode: "auto" as const, online: true, offlineReady: true, webSpeech: true };
  it("课堂选了云端并填了 Key 才用云端识别", () => {
    const cloud = { ...base, purpose: "lecture" as const, cloud: true, hasOpenaiKey: true };
    expect(chooseRecognizer(cloud)).toEqual({ engine: "cloud" });
    expect(chooseRecognizer({ ...cloud, hasOpenaiKey: false })).toEqual({ engine: "webspeech" });
    expect(chooseRecognizer({ ...cloud, purpose: "conversation" })).toEqual({ engine: "webspeech" });
    expect(chooseRecognizer({ ...cloud, online: false })).toEqual({ engine: "whisper" });
    expect(chooseRecognizer({ ...cloud, overCap: true })).toEqual({ engine: "webspeech" });
    expect(chooseRecognizer({ ...cloud, mode: "offline" })).toEqual({ engine: "whisper" });
  });
});
