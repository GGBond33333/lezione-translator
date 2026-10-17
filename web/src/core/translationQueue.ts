import type { Utterance } from "../storage/db";
import type { TranslatorRoute } from "./router";
import type { TranslateContext, Translator } from "./translator";

export interface QueueDeps {
  /** 每次发送前重新选择引擎（网络状态、费用上限可能已经变化） */
  route(): TranslatorRoute;
  online(model: string): Translator;
  /** 离线翻译器；没有下载离线模型时为 null */
  offline(): Translator | null;
  context(): Omit<TranslateContext, "previous">;
  /** 句子状态变化（已翻译 / 待补翻），调用方负责保存和刷新界面 */
  onUpdate(list: Utterance[]): void;
  onCost(usd: number): void;
  onNotice(message: string): void;
  isPermanentError?(e: unknown): boolean;
  describeError?(e: unknown): string;
}

/**
 * 实时翻译队列：每 batchSize 句合并成一个请求（或等待 maxWaitMs 后发送不满的一批），
 * 联网失败时回退到离线翻译；都不可用时标记为待补翻，网络恢复后自动补上。
 */
export class TranslationQueue {
  private waiting: Utterance[] = [];
  private pending: Utterance[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private chain: Promise<void> = Promise.resolve();
  private previous: string | undefined;
  private lastNotice = "";

  constructor(
    private deps: QueueDeps,
    private batchSize = 3,
    private maxWaitMs = 2500,
  ) {}

  push(u: Utterance): void {
    this.waiting.push(u);
    if (this.waiting.length >= this.batchSize) this.flush();
    else if (!this.timer) this.timer = setTimeout(() => this.flush(), this.maxWaitMs);
  }

  /** 立即发送所有等待中的句子 */
  flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    while (this.waiting.length) {
      const batch = this.waiting.splice(0, this.batchSize);
      this.chain = this.chain.then(() => this.process(batch));
    }
    return this.chain;
  }

  /** 网络恢复或定时调用：重新翻译待补翻的句子 */
  retryPending(): Promise<void> {
    if (!this.pending.length) return this.chain;
    const items = this.pending.splice(0);
    for (let i = 0; i < items.length; i += this.batchSize) {
      const batch = items.slice(i, i + this.batchSize);
      this.chain = this.chain.then(() => this.process(batch));
    }
    return this.chain;
  }

  /** 恢复续录时把之前没翻译的句子加入待补翻 */
  addPending(list: Utterance[]): void {
    this.pending.push(...list);
  }

  get pendingCount(): number {
    return this.pending.length + this.waiting.length;
  }

  idle(): Promise<void> {
    return this.chain;
  }

  private notice(msg: string) {
    if (msg !== this.lastNotice) this.deps.onNotice(msg);
    this.lastNotice = msg;
  }

  private async process(batch: Utterance[]): Promise<void> {
    const ctx: TranslateContext = { ...this.deps.context(), previous: this.previous };
    const sentences = batch.map((u) => u.source);
    const route = this.deps.route();

    if (route.engine === "claude") {
      try {
        const res = await this.deps.online(route.model).translate(sentences, ctx);
        this.deps.onCost(res.costUsd);
        this.finish(batch, res.translations, res.engine);
        if (route.downgraded) this.notice("已超过费用上限，已自动切换到 Haiku");
        else this.lastNotice = "";
        return;
      } catch (e) {
        const msg = this.deps.describeError?.(e) ?? String(e);
        this.notice(this.deps.isPermanentError?.(e) ? msg : `${msg}，稍后自动重试`);
      }
    } else if (route.engine === "none") {
      this.notice(route.reason);
    }

    const offline = this.deps.offline();
    if (offline && route.engine !== "none") {
      try {
        const res = await offline.translate(sentences, ctx);
        this.finish(batch, res.translations, res.engine);
        return;
      } catch (e) {
        this.notice(`离线翻译失败：${e instanceof Error ? e.message : e}`);
      }
    }

    batch.forEach((u) => (u.status = "pending"));
    this.pending.push(...batch);
    this.deps.onUpdate(batch);
  }

  private finish(batch: Utterance[], translations: string[], engine: string) {
    batch.forEach((u, i) => {
      u.translation = translations[i] || u.translation;
      u.status = translations[i] ? "done" : "failed";
      u.engine = engine;
    });
    this.previous = batch[batch.length - 1]?.source;
    this.deps.onUpdate(batch);
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
