import { useSyncExternalStore } from "react";
import type { LiveModelChoice, OnlineModelId } from "./models-catalog";

export type NetMode = "auto" | "offline" | "online";

export interface Settings {
  apiKey: string;
  mode: NetMode;
  liveModel: LiveModelChoice;
  refineModel: OnlineModelId;
  /** 双语对话单独选择的翻译模型 */
  conversationModel: LiveModelChoice;
  /** 对话记录保存天数，0 表示永久 */
  conversationRetentionDays: number;
  /** 单节课费用上限（美元），0 表示不限 */
  costCapUsd: number;
  audioBackup: boolean;
  offlineReady: boolean;
  onboarded: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  apiKey: "",
  mode: "auto",
  liveModel: "claude-haiku-5-5",
  refineModel: "claude-sonnet-5-5",
  conversationModel: "claude-haiku-5-5",
  conversationRetentionDays: 30,
  costCapUsd: 3,
  audioBackup: true,
  offlineReady: false,
  onboarded: false,
};

const KEY = "lt.settings.v1";
const listeners = new Set<() => void>();

function load(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    // 隐私模式等情况下 localStorage 不可用，用默认值
  }
  return { ...DEFAULT_SETTINGS };
}

let current: Settings = typeof localStorage === "undefined" ? { ...DEFAULT_SETTINGS } : load();

export function getSettings(): Settings {
  return current;
}

export function updateSettings(patch: Partial<Settings>): void {
  current = { ...current, ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    // 忽略：设置只在本次打开期间生效
  }
  listeners.forEach((l) => l());
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useSettings(): Settings {
  return useSyncExternalStore(subscribe, getSettings);
}
