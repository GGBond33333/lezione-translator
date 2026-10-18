/// <reference lib="webworker" />
// 离线模型推理（Transformers.js）放在 Worker 里，不卡界面。
// 模型文件由 Transformers.js 自动缓存在浏览器的 Cache Storage 里，下载一次后离线可用。
import { pipeline, env } from "@huggingface/transformers";

env.allowLocalModels = false;

const WHISPER_MODEL = "onnx-community/whisper-base";
const MT_MODELS: Record<string, string> = {
  "it-en": "Xenova/opus-mt-it-en",
  "en-zh": "Xenova/opus-mt-en-zh",
  "zh-en": "Xenova/opus-mt-zh-en",
  "en-it": "Xenova/opus-mt-en-it",
};

const STEPS: { key: string; label: string }[] = [
  { key: "asr", label: "语音识别（Whisper）" },
  { key: "it-en", label: "翻译：意大利语→英语" },
  { key: "en-zh", label: "翻译：英语→中文" },
  { key: "zh-en", label: "翻译：中文→英语" },
  { key: "en-it", label: "翻译：英语→意大利语" },
];

type Req =
  | { id: number; type: "load" }
  | { id: number; type: "transcribe"; audio: Float32Array; language: string }
  | { id: number; type: "translate"; pair: string; text: string };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyPipe = ((...args: any[]) => Promise<any>) & { dispose?: () => Promise<void> };
const pipes = new Map<string, Promise<AnyPipe>>();

// iPhone / Safari 给网页的内存很少：不用 WebGPU，并且同一时间最多只在内存里保留 2 个翻译模型。
// 之前一次性把 5 个模型都加载进内存，iPhone 会直接把页面重置。
const ua = navigator.userAgent;
const constrained = /iPhone|iPad|iPod/.test(ua) || (/Safari/.test(ua) && !/Chrome|Chromium|CriOS|Edg|Firefox|FxiOS/.test(ua));
const useWebGPU = !constrained && "gpu" in navigator;
const MAX_MT_IN_MEMORY = constrained ? 2 : 4;
const mtOrder: string[] = [];

type ProgressFn = (file: string, loaded: number, total: number) => void;

function createPipe(task: string, onProgress?: ProgressFn): Promise<AnyPipe> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const progress_callback = (p: any) => {
    if (p.status === "progress") onProgress?.(String(p.file ?? ""), p.loaded ?? 0, p.total ?? 0);
  };
  if (task === "asr") {
    const load = (device: "webgpu" | "wasm") =>
      pipeline("automatic-speech-recognition", WHISPER_MODEL, {
        device,
        dtype: device === "webgpu" ? { encoder_model: "fp32", decoder_model_merged: "q4" } : "q8",
        progress_callback,
      }) as unknown as Promise<AnyPipe>;
    return useWebGPU ? load("webgpu").catch(() => load("wasm")) : load("wasm");
  }
  return pipeline("translation", MT_MODELS[task], { dtype: "q8", progress_callback }) as unknown as Promise<AnyPipe>;
}

async function release(task: string) {
  const p = pipes.get(task);
  pipes.delete(task);
  const i = mtOrder.indexOf(task);
  if (i >= 0) mtOrder.splice(i, 1);
  try {
    await (await p)?.dispose?.();
  } catch {
    // 释放失败不影响后续使用
  }
}

/** 取得已加载的模型；翻译模型超过上限时释放最久没用的那个 */
async function getPipe(task: string): Promise<AnyPipe> {
  if (task !== "asr") {
    const i = mtOrder.indexOf(task);
    if (i >= 0) mtOrder.splice(i, 1);
    mtOrder.push(task);
    while (mtOrder.length > MAX_MT_IN_MEMORY) await release(mtOrder[0]);
  }
  let p = pipes.get(task);
  if (!p) {
    p = createPipe(task);
    pipes.set(task, p);
    p.catch(() => pipes.delete(task));
  }
  return p;
}

self.onmessage = async (e: MessageEvent<Req>) => {
  const req = e.data;
  try {
    if (req.type === "load") {
      // 逐个下载：每个模型下载完、确认能加载后立即释放内存，再下载下一个
      for (let i = 0; i < STEPS.length; i++) {
        const step = STEPS[i];
        self.postMessage({ id: req.id, type: "step", index: i, total: STEPS.length, label: step.label });
        await release(step.key);
        try {
          const pipe = await createPipe(step.key, (file, loaded, total) =>
            self.postMessage({ id: req.id, type: "progress", index: i, file, loaded, total }),
          );
          await pipe.dispose?.();
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          throw new Error(`第 ${i + 1}/${STEPS.length} 步「${step.label}」失败：${msg}`);
        }
      }
      self.postMessage({ id: req.id, type: "done", result: true });
    } else if (req.type === "transcribe") {
      const asr = await getPipe("asr");
      const out = await asr(req.audio, {
        language: req.language,
        task: "transcribe",
        chunk_length_s: 30,
        stride_length_s: 5,
      });
      self.postMessage({ id: req.id, type: "done", result: String(out.text ?? "").trim() });
    } else if (req.type === "translate") {
      const mt = await getPipe(req.pair);
      const out = await mt(req.text, { max_new_tokens: 512 });
      const first = Array.isArray(out) ? out[0] : out;
      self.postMessage({ id: req.id, type: "done", result: String(first?.translation_text ?? "").trim() });
    }
  } catch (err) {
    self.postMessage({ id: req.id, type: "error", error: err instanceof Error ? err.message : String(err) });
  }
};
