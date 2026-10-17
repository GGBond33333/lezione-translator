import { useSyncExternalStore } from "react";

// navigator.onLine 在 iOS 上不总是准确：连着没网的 Wi-Fi 也会显示在线。
// 所以在线时再探测一次 API 域名，失败则视为离线。
let online = typeof navigator === "undefined" ? true : navigator.onLine;
const listeners = new Set<() => void>();

function set(v: boolean) {
  if (v === online) return;
  online = v;
  listeners.forEach((l) => l());
}

export async function probe(): Promise<boolean> {
  if (!navigator.onLine) {
    set(false);
    return false;
  }
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    await fetch("https://api.anthropic.com/", { method: "HEAD", mode: "no-cors", cache: "no-store", signal: ctrl.signal });
    clearTimeout(t);
    set(true);
    return true;
  } catch {
    set(false);
    return false;
  }
}

if (typeof window !== "undefined") {
  window.addEventListener("online", () => void probe());
  window.addEventListener("offline", () => set(false));
  setInterval(() => void probe(), 30_000);
  void probe();
}

export function isOnline(): boolean {
  return online;
}

export function onNetworkChange(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useOnline(): boolean {
  return useSyncExternalStore(onNetworkChange, isOnline);
}
