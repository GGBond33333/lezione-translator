// 主线程和离线模型 Worker 之间的通信封装
type WorkerMsg = {
  id: number;
  type: "step" | "progress" | "done" | "error";
  result?: unknown;
  error?: string;
  index?: number;
  total?: number;
  label?: string;
  file?: string;
  loaded?: number;
};

type Pending = {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  onMessage?: (msg: WorkerMsg) => void;
};

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, Pending>();

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL("../workers/ml.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e: MessageEvent<WorkerMsg>) => {
      const msg = e.data;
      const p = pending.get(msg.id);
      if (!p) return;
      if (msg.type === "done") {
        pending.delete(msg.id);
        p.resolve(msg.result);
      } else if (msg.type === "error") {
        pending.delete(msg.id);
        p.reject(new Error(msg.error));
      } else {
        p.onMessage?.(msg);
      }
    };
    // Worker 崩溃（例如手机内存不足被系统结束）时，让等待中的请求都失败，下次自动重建
    worker.onerror = (e) => {
      const err = new Error(e.message || "离线模型进程意外退出，可能是手机内存不足");
      pending.forEach((p) => p.reject(err));
      pending.clear();
      worker?.terminate();
      worker = null;
    };
  }
  return worker;
}

function call<T>(payload: Record<string, unknown>, transfer: Transferable[] = [], onMessage?: Pending["onMessage"]): Promise<T> {
  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject, onMessage });
    getWorker().postMessage({ id, ...payload }, transfer);
  });
}

export interface DownloadProgress {
  /** 第几步（从 0 开始） */
  step: number;
  steps: number;
  label: string;
  /** 当前这一步的进度 0–1 */
  stepFraction: number;
  /** 总进度 0–1，只增不减 */
  overall: number;
}

/**
 * 逐个下载离线模型。已经下载过的文件会直接从缓存读取，所以失败后再点一次就是断点续传。
 */
export function loadOfflineModels(onProgress?: (p: DownloadProgress) => void): Promise<boolean> {
  let step = 0;
  let steps = 1;
  let label = "";
  let files = new Map<string, { loaded: number; total: number }>();
  const emit = () => {
    let l = 0;
    let t = 0;
    files.forEach((f) => {
      l += f.loaded;
      t += f.total;
    });
    const stepFraction = t ? Math.min(1, l / t) : 0;
    onProgress?.({ step, steps, label, stepFraction, overall: (step + stepFraction) / steps });
  };
  return call<boolean>({ type: "load" }, [], (msg) => {
    if (msg.type === "step") {
      step = msg.index ?? 0;
      steps = msg.total ?? 1;
      label = msg.label ?? "";
      files = new Map();
    } else if (msg.type === "progress" && msg.file) {
      files.set(msg.file, { loaded: msg.loaded ?? 0, total: msg.total ?? 0 });
    }
    emit();
  });
}

export function transcribeOffline(audio: Float32Array, language: string): Promise<string> {
  return call<string>({ type: "transcribe", audio, language }, [audio.buffer]);
}

export function translatePair(pair: string, text: string): Promise<string> {
  return call<string>({ type: "translate", pair, text });
}
