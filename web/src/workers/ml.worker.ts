/// <reference lib="webworker" />
// 离线模型推理（Transformers.js）放在 Worker 里，不卡界面。
// 模型文件由 Transformers.js 自动缓存在浏览器的 Cache Storage 里，下载一次后离线可用。
import { pipeline, env } from "@huggingface/transformers";

env.allowLocalModels = false;

export const WHISPER_MODEL = "onnx-community/whisper-base";
export const MT_MODELS: Record<string, string> = {
  "it-en": "Xenova/opus-mt-it-en",
  "en-zh": "Xenova/opus-mt-en-zh",
  "zh-en": "Xenova/opus-mt-zh-en",
  "en-it": "Xenova/opus-mt-en-it",
};

type Req =
  | { id: number; type: "load" }
  | { id: number; type: "transcribe"; audio: Float32Array; language: string }
  | { id: number; type: "translate"; pair: string; text: string };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyPipe = (...args: any[]) => Promise<any>;
const pipes = new Map<string, Promise<AnyPipe>>();

const hasWebGPU = typeof navigator !== "undefined" && "gpu" in navigator;

function progress(id: number, file: string) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (p: any) => {
    if (p.status === "progress") {
      self.postMessage({ id, type: "progress", file: `${file}/${p.file}`, loaded: p.loaded, total: p.total });
    }
  };
}

function getPipe(task: "asr" | string, id: number): Promise<AnyPipe> {
  let p = pipes.get(task);
  if (!p) {
    p = (async () => {
      if (task === "asr") {
        const load = (device: "webgpu" | "wasm") =>
          pipeline("automatic-speech-recognition", WHISPER_MODEL, {
            device,
            dtype: device === "webgpu" ? { encoder_model: "fp32", decoder_model_merged: "q4" } : "q8",
            progress_callback: progress(id, WHISPER_MODEL),
          });
        try {
          return (await load(hasWebGPU ? "webgpu" : "wasm")) as unknown as AnyPipe;
        } catch {
          return (await load("wasm")) as unknown as AnyPipe;
        }
      }
      const model = MT_MODELS[task];
      return (await pipeline("translation", model, {
        dtype: "q8",
        progress_callback: progress(id, model),
      })) as unknown as AnyPipe;
    })();
    pipes.set(task, p);
    p.catch(() => pipes.delete(task));
  }
  return p;
}

self.onmessage = async (e: MessageEvent<Req>) => {
  const req = e.data;
  try {
    if (req.type === "load") {
      await getPipe("asr", req.id);
      for (const pair of Object.keys(MT_MODELS)) await getPipe(pair, req.id);
      self.postMessage({ id: req.id, type: "done", result: true });
    } else if (req.type === "transcribe") {
      const asr = await getPipe("asr", req.id);
      const out = await asr(req.audio, {
        language: req.language,
        task: "transcribe",
        chunk_length_s: 30,
        stride_length_s: 5,
      });
      self.postMessage({ id: req.id, type: "done", result: String(out.text ?? "").trim() });
    } else if (req.type === "translate") {
      const mt = await getPipe(req.pair, req.id);
      const out = await mt(req.text, { max_new_tokens: 512 });
      const first = Array.isArray(out) ? out[0] : out;
      self.postMessage({ id: req.id, type: "done", result: String(first?.translation_text ?? "").trim() });
    }
  } catch (err) {
    self.postMessage({ id: req.id, type: "error", error: err instanceof Error ? err.message : String(err) });
  }
};
