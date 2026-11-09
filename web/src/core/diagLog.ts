// 诊断日志：记录识别启动、错误、麦克风被打断、前后台切换等事件。
// 只保存在本机，最多保留最近 MAX 条；用户可以在设置页复制出来，用于定位"转写突然中断"一类问题。

export const DIAG_MAX = 200;
const KEY = "lt.diag.v1";

export interface DiagEntry {
  at: number;
  event: string;
}

let entries: DiagEntry[] | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function load(): DiagEntry[] {
  if (entries) return entries;
  try {
    const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(KEY);
    entries = raw ? (JSON.parse(raw) as DiagEntry[]) : [];
  } catch {
    entries = [];
  }
  return entries;
}

function save() {
  if (saveTimer) return;
  // 合并短时间内的多次写入，避免频繁写 localStorage
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      localStorage.setItem(KEY, JSON.stringify(entries));
    } catch {
      // 存不下就只保留在内存里
    }
  }, 1000);
}

export function diag(event: string): void {
  const list = load();
  list.push({ at: Date.now(), event });
  if (list.length > DIAG_MAX) list.splice(0, list.length - DIAG_MAX);
  save();
}

export function getDiag(): DiagEntry[] {
  return [...load()];
}

export function clearDiag(): void {
  entries = [];
  save();
}

export function formatDiag(list = getDiag()): string {
  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
  const lines = list.map((e) => {
    const d = new Date(e.at);
    const t = `${d.toLocaleDateString("zh-CN")} ${d.toTimeString().slice(0, 8)}`;
    return `${t}  ${e.event}`;
  });
  return [`设备：${ua}`, ...lines].join("\n");
}
