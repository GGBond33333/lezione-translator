// 本机 IndexedDB 存储：课程、会话、每句话、录音备份。数据只保存在用户自己的手机上。
import type { Lang } from "../core/languages";
import type { GlossaryEntry } from "../core/translator";

export interface Course {
  id: string;
  name: string;
  glossary: GlossaryEntry[];
}

export interface Session {
  id: string;
  kind: "lecture" | "conversation";
  title: string;
  courseId?: string;
  sourceLang: Lang;
  startedAt: number;
  endedAt?: number;
  costUsd: number;
  notes?: string;
  refinedAt?: number;
  audioMime?: string;
}

export interface Utterance {
  sessionId: string;
  seq: number;
  lang: Lang;
  source: string;
  translation?: string;
  refined?: string;
  engine?: string;
  status: "pending" | "done" | "failed";
  at: number;
}

const DB_NAME = "lezione-translator";
const VERSION = 1;
let dbPromise: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore("courses", { keyPath: "id" });
        db.createObjectStore("sessions", { keyPath: "id" });
        db.createObjectStore("utterances", { keyPath: ["sessionId", "seq"] });
        db.createObjectStore("audio"); // key: [sessionId, index]
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function wrap<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function store(name: string, mode: IDBTransactionMode = "readonly"): Promise<IDBObjectStore> {
  const db = await open();
  return db.transaction(name, mode).objectStore(name);
}

const sessionRange = (id: string) => IDBKeyRange.bound([id, -Infinity], [id, Infinity]);

export function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// —— 课程 ——
export async function listCourses(): Promise<Course[]> {
  const all = await wrap((await store("courses")).getAll() as IDBRequest<Course[]>);
  return all.sort((a, b) => a.name.localeCompare(b.name));
}
export async function saveCourse(c: Course): Promise<void> {
  await wrap((await store("courses", "readwrite")).put(c));
}
export async function deleteCourse(id: string): Promise<void> {
  await wrap((await store("courses", "readwrite")).delete(id));
}
export async function getCourse(id?: string): Promise<Course | undefined> {
  if (!id) return undefined;
  return wrap((await store("courses")).get(id) as IDBRequest<Course | undefined>);
}

// —— 会话 ——
export async function saveSession(s: Session): Promise<void> {
  await wrap((await store("sessions", "readwrite")).put(s));
}
export async function getSession(id: string): Promise<Session | undefined> {
  return wrap((await store("sessions")).get(id) as IDBRequest<Session | undefined>);
}
export async function listSessions(): Promise<Session[]> {
  const all = await wrap((await store("sessions")).getAll() as IDBRequest<Session[]>);
  return all.sort((a, b) => b.startedAt - a.startedAt);
}
/** 最近一节没有正常结束的课（页面崩溃或刷新），用于断点续录 */
export async function findUnfinishedLecture(): Promise<Session | undefined> {
  return (await listSessions()).find((s) => s.kind === "lecture" && !s.endedAt);
}
export async function deleteSession(id: string): Promise<void> {
  const db = await open();
  const tx = db.transaction(["sessions", "utterances", "audio"], "readwrite");
  tx.objectStore("sessions").delete(id);
  tx.objectStore("utterances").delete(sessionRange(id));
  tx.objectStore("audio").delete(sessionRange(id));
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function listConversations(): Promise<Session[]> {
  return (await listSessions()).filter((s) => s.kind === "conversation");
}

/** 删除超过保存期限的对话记录（按最后一次说话的时间算），返回删除的数量。days = 0 表示永久保存 */
export async function purgeOldConversations(days: number, now = Date.now()): Promise<number> {
  if (!days || days <= 0) return 0;
  const cutoff = now - days * 86_400_000;
  const old = (await listConversations()).filter((s) => (s.endedAt ?? s.startedAt) < cutoff);
  for (const s of old) await deleteSession(s.id);
  return old.length;
}

// —— 句子 ——
export async function saveUtterance(u: Utterance): Promise<void> {
  await wrap((await store("utterances", "readwrite")).put(u));
}
export async function saveUtterances(list: Utterance[]): Promise<void> {
  if (!list.length) return;
  const db = await open();
  const tx = db.transaction("utterances", "readwrite");
  list.forEach((u) => tx.objectStore("utterances").put(u));
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
export async function listUtterances(sessionId: string): Promise<Utterance[]> {
  return wrap((await store("utterances")).getAll(sessionRange(sessionId)) as IDBRequest<Utterance[]>);
}

// —— 录音备份 ——
export async function saveAudioChunk(sessionId: string, index: number, blob: Blob): Promise<void> {
  await wrap((await store("audio", "readwrite")).put(blob, [sessionId, index]));
}
export async function listAudioChunks(sessionId: string): Promise<Blob[]> {
  return wrap((await store("audio")).getAll(sessionRange(sessionId)) as IDBRequest<Blob[]>);
}
export async function countAudioChunks(sessionId: string): Promise<number> {
  return wrap((await store("audio")).count(sessionRange(sessionId)));
}
