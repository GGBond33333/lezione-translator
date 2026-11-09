import { afterEach, describe, expect, it, vi } from "vitest";
import { clearDiag, DIAG_MAX, diag, getDiag } from "./diagLog";
import { END_TIMEOUT_MS, looksReplaced, WATCHDOG_MS, WebSpeechRecognizer } from "./webSpeechRecognizer";
import { SegmentQueue } from "./whisperRecognizer";

/** 模拟 Safari 的语音识别；silentEnd = true 时 abort/stop 后不触发 onend（Safari 偶尔会这样） */
class FakeRec {
  static instances: FakeRec[] = [];
  static silentEnd = false;
  lang = "";
  continuous = false;
  interimResults = false;
  onresult: ((e: unknown) => void) | null = null;
  onerror: ((e: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;
  started = false;
  aborted = false;
  constructor() {
    FakeRec.instances.push(this);
  }
  start() {
    this.started = true;
  }
  stop() {
    if (!FakeRec.silentEnd) this.onend?.();
  }
  abort() {
    this.aborted = true;
    if (!FakeRec.silentEnd) this.onend?.();
  }
  say(text: string, isFinal = true) {
    this.onresult?.({ resultIndex: 0, results: [{ isFinal, 0: { transcript: text } }] });
  }
}

function setup() {
  FakeRec.instances = [];
  FakeRec.silentEnd = false;
  vi.useFakeTimers();
  vi.stubGlobal("webkitSpeechRecognition", FakeRec);
  const finals: string[] = [];
  const errors: string[] = [];
  const rec = new WebSpeechRecognizer();
  const handlers = {
    onPartial: () => undefined,
    onFinal: (t: string) => finals.push(t),
    onError: (m: string) => errors.push(m),
  };
  return { rec, handlers, finals, errors };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("联网识别自动恢复", () => {
  it("看门狗超时后即使旧实例不触发 onend，也会换一个新实例继续识别", async () => {
    const { rec, handlers, finals } = setup();
    FakeRec.silentEnd = true;
    await rec.start("it", handlers);
    expect(FakeRec.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(WATCHDOG_MS + 5_000);
    expect(FakeRec.instances.length).toBeGreaterThanOrEqual(2);
    expect(FakeRec.instances[0].aborted).toBe(true);
    const latest = FakeRec.instances.at(-1)!;
    expect(latest.started).toBe(true);
    latest.say("buongiorno");
    // 旧实例的迟到结果不应再出现
    FakeRec.instances[0].onresult?.({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: "vecchio" } }] });
    expect(finals).toEqual(["buongiorno"]);
    FakeRec.silentEnd = false;
    await rec.stop();
  });

  it("麦克风被占用（audio-capture）且没有 onend 时，超时后自动重启并提示", async () => {
    const { rec, handlers, errors } = setup();
    FakeRec.silentEnd = true;
    await rec.start("it", handlers);
    FakeRec.instances[0].onerror?.({ error: "audio-capture" });
    expect(errors[0]).toContain("麦克风被系统占用");
    await vi.advanceTimersByTimeAsync(END_TIMEOUT_MS + 1_000);
    expect(FakeRec.instances).toHaveLength(2);
    expect(FakeRec.instances[1].started).toBe(true);
    FakeRec.silentEnd = false;
    await rec.stop();
  });

  it("restart() 保存没说完的半句，并立即换新实例", async () => {
    const { rec, handlers, finals } = setup();
    await rec.start("it", handlers);
    FakeRec.instances[0].say("la musica barocca", false);
    await rec.restart("回到前台");
    expect(finals).toEqual(["la musica barocca"]);
    expect(FakeRec.instances).toHaveLength(2);
    await rec.stop();
    // 停止后不再重启
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeRec.instances).toHaveLength(2);
  });
});

describe("离线识别积压上限", () => {
  it("识别比说话慢时，排队的段落不超过上限，多出来的被跳过", async () => {
    const resolvers: (() => void)[] = [];
    const done: number[] = [];
    const q = new SegmentQueue<number>(
      (n) =>
        new Promise<void>((resolve) =>
          resolvers.push(() => {
            done.push(n);
            resolve();
          }),
        ),
      2,
    );
    expect(q.push(1)).toBe(true);
    expect(q.push(2)).toBe(true);
    expect(q.push(3)).toBe(false);
    expect(q.size).toBe(2);
    await Promise.resolve();
    resolvers.shift()!();
    await vi.waitFor(() => expect(q.size).toBe(1));
    expect(q.push(4)).toBe(true);
    while (done.length < 3) {
      await vi.waitFor(() => expect(resolvers.length).toBeGreaterThan(0));
      resolvers.shift()!();
    }
    await q.idle();
    expect(done).toEqual([1, 2, 4]);
  });

  it("某一段识别失败不影响后面的段落", async () => {
    const done: number[] = [];
    const q = new SegmentQueue<number>(async (n) => {
      if (n === 1) throw new Error("worker 崩溃");
      done.push(n);
    });
    q.push(1);
    await q.idle().catch(() => undefined);
    q.push(2);
    await q.idle().catch(() => undefined);
    expect(done).toEqual([2]);
  });
});

describe("诊断日志", () => {
  it(`最多保留最近 ${DIAG_MAX} 条`, () => {
    clearDiag();
    for (let i = 0; i < DIAG_MAX + 50; i++) diag(`事件 ${i}`);
    const list = getDiag();
    expect(list).toHaveLength(DIAG_MAX);
    expect(list[0].event).toBe("事件 50");
    expect(list.at(-1)!.event).toBe(`事件 ${DIAG_MAX + 49}`);
  });
});

describe("漏句诊断", () => {
  it("新结果是旧半句的延续时不算漏句，开头完全不同才算", () => {
    expect(looksReplaced("oggi parliamo", "oggi parliamo del Barocco")).toBe(false);
    expect(looksReplaced("Oggi parliamo", "oggi, parliamo di")).toBe(false);
    expect(looksReplaced("oggi parliamo del Barocco", "Monteverdi nacque")).toBe(true);
    expect(looksReplaced("sì", "Monteverdi")).toBe(false); // 太短不判断
    expect(looksReplaced("今天我们讲巴洛克", "蒙特威尔第出生于")).toBe(true);
  });
});
