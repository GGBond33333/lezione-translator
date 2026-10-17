// 主线程和离线模型 Worker 之间的通信封装
type Pending = {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  onProgress?: (file: string, loaded: number, total: number) => void;
};

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, Pending>();

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL("../workers/ml.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e: MessageEvent) => {
      const msg = e.data as { id: number; type: string; result?: unknown; error?: string; file?: string; loaded?: number; total?: number };
      const p = pending.get(msg.id);
      if (!p) return;
      if (msg.type === "progress") p.onProgress?.(msg.file!, msg.loaded ?? 0, msg.total ?? 0);
      else if (msg.type === "done") {
        pending.delete(msg.id);
        p.resolve(msg.result);
      } else if (msg.type === "error") {
        pending.delete(msg.id);
        p.reject(new Error(msg.error));
      }
    };
  }
  return worker;
}

function call<T>(payload: Record<string, unknown>, transfer: Transferable[] = [], onProgress?: Pending["onProgress"]): Promise<T> {
  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject, onProgress });
    getWorker().postMessage({ id, ...payload }, transfer);
  });
}

/** 下载并加载全部离线模型；onProgress 汇总所有文件的下载进度（0–1） */
export function loadOfflineModels(onProgress?: (fraction: number, file: string) => void): Promise<boolean> {
  const files = new Map<string, { loaded: number; total: number }>();
  return call<boolean>({ type: "load" }, [], (file, loaded, total) => {
    files.set(file, { loaded, total });
    let l = 0;
    let t = 0;
    files.forEach((f) => {
      l += f.loaded;
      t += f.total;
    });
    onProgress?.(t ? l / t : 0, file);
  });
}

export function transcribeOffline(audio: Float32Array, language: string): Promise<string> {
  return call<string>({ type: "transcribe", audio, language }, [audio.buffer]);
}

export function translatePair(pair: string, text: string): Promise<string> {
  return call<string>({ type: "translate", pair, text });
}
