import { useCallback, useEffect, useRef, useState } from "react";
import { AudioBackup } from "../../core/audioBackup";
import { describeApiError, isPermanentApiError } from "../../core/claudeTranslator";
import { keepAwake } from "../../core/device";
import { claudeTranslator, createRecognizer, currentTranslatorRoute, offline } from "../../core/engines";
import { other, type Lang } from "../../core/languages";
import { onNetworkChange } from "../../core/network";
import type { Recognizer, RecognizerStatus } from "../../core/recognizer";
import { getSettings } from "../../core/settings";
import { TranslationQueue } from "../../core/translationQueue";
import {
  getCourse,
  getSession,
  listUtterances,
  newId,
  saveSession,
  saveUtterance,
  saveUtterances,
  type Course,
  type Session,
  type Utterance,
} from "../../storage/db";

export type LectureState = "idle" | "running" | "paused";

/** 课堂转写会话：识别 → 保存 → 合并翻译 → 保存；支持暂停、断点续录 */
export function useLecture() {
  const [state, setState] = useState<LectureState>("idle");
  const [session, setSession] = useState<Session | null>(null);
  const [items, setItems] = useState<Utterance[]>([]);
  const [partial, setPartial] = useState("");
  const [status, setStatus] = useState<RecognizerStatus>("idle");
  const [notice, setNotice] = useState("");
  const [pendingCount, setPendingCount] = useState(0);

  const sessionRef = useRef<Session | null>(null);
  const courseRef = useRef<Course | undefined>(undefined);
  const itemsRef = useRef<Utterance[]>([]);
  const seqRef = useRef(0);
  const recRef = useRef<Recognizer | null>(null);
  const queueRef = useRef<TranslationQueue | null>(null);
  const backupRef = useRef<AudioBackup | null>(null);

  const refresh = useCallback(() => {
    setItems([...itemsRef.current]);
    setPendingCount(itemsRef.current.filter((u) => u.status !== "done").length);
  }, []);

  const persistSession = useCallback((patch: Partial<Session>) => {
    const s = sessionRef.current;
    if (!s) return;
    const next = { ...s, ...patch };
    sessionRef.current = next;
    setSession(next);
    void saveSession(next);
  }, []);

  const makeQueue = useCallback(
    (s: Session) =>
      new TranslationQueue({
        route: () => currentTranslatorRoute(sessionRef.current?.costUsd ?? 0),
        online: (model) => claudeTranslator(model as Parameters<typeof claudeTranslator>[0]),
        offline,
        context: () => ({
          from: s.sourceLang,
          to: other(s.sourceLang),
          course: courseRef.current?.name,
          glossary: courseRef.current?.glossary,
        }),
        onUpdate: (list) => {
          void saveUtterances(list);
          refresh();
        },
        onCost: (usd) => persistSession({ costUsd: (sessionRef.current?.costUsd ?? 0) + usd }),
        onNotice: setNotice,
        isPermanentError: isPermanentApiError,
        describeError: describeApiError,
      }),
    [persistSession, refresh],
  );

  // 网络恢复时、以及每 30 秒，补翻译待处理的句子
  useEffect(() => {
    const retry = () => void queueRef.current?.retryPending();
    const off = onNetworkChange(retry);
    const timer = setInterval(retry, 30_000);
    return () => {
      off();
      clearInterval(timer);
    };
  }, []);

  const startListening = useCallback(async () => {
    const s = sessionRef.current!;
    const rec = createRecognizer(15);
    if (typeof rec === "string") {
      setNotice(rec);
      return false;
    }
    recRef.current = rec;
    try {
      await rec.start(s.sourceLang, {
        onPartial: setPartial,
        onFinal: (text) => {
          const u: Utterance = {
            sessionId: s.id,
            seq: seqRef.current++,
            lang: s.sourceLang,
            source: text,
            status: "pending",
            at: Date.now(),
          };
          itemsRef.current.push(u);
          refresh();
          void saveUtterance(u); // 先保存原文，翻译完成后再更新
          queueRef.current?.push(u);
        },
        onStatus: setStatus,
        onError: setNotice,
      });
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
      recRef.current = null;
      return false;
    }

    if (getSettings().audioBackup) {
      const b = new AudioBackup();
      try {
        if (await b.start(s.id)) {
          backupRef.current = b;
          if (!s.audioMime) persistSession({ audioMime: b.mime });
        }
      } catch {
        setNotice("录音备份启动失败，识别不受影响");
      }
    }
    void keepAwake(true);
    return true;
  }, [persistSession, refresh]);

  const stopListening = useCallback(async () => {
    await recRef.current?.stop();
    recRef.current = null;
    await backupRef.current?.stop();
    backupRef.current = null;
    setPartial("");
    void keepAwake(false);
  }, []);

  /** 开始新课，或传入 resumeId 继续上次没结束的课 */
  const start = useCallback(
    async (opts: { courseId?: string; sourceLang: Lang; resumeId?: string }) => {
      setNotice("");
      let s: Session | undefined;
      let existing: Utterance[] = [];
      if (opts.resumeId) {
        s = await getSession(opts.resumeId);
        existing = s ? await listUtterances(s.id) : [];
      }
      courseRef.current = await getCourse(s?.courseId ?? opts.courseId);
      if (!s) {
        const now = new Date();
        s = {
          id: newId(),
          kind: "lecture",
          title: `${courseRef.current?.name ?? "课堂"} ${now.toLocaleDateString("zh-CN")} ${now.toTimeString().slice(0, 5)}`,
          courseId: opts.courseId,
          sourceLang: opts.sourceLang,
          startedAt: Date.now(),
          costUsd: 0,
        };
        await saveSession(s);
      }
      sessionRef.current = s;
      setSession(s);
      itemsRef.current = existing;
      seqRef.current = existing.reduce((m, u) => Math.max(m, u.seq + 1), 0);
      queueRef.current?.dispose();
      queueRef.current = makeQueue(s);
      const untranslated = existing.filter((u) => u.status !== "done");
      if (untranslated.length) {
        queueRef.current.addPending(untranslated);
        void queueRef.current.retryPending();
      }
      refresh();
      if (await startListening()) setState("running");
      else setState("paused");
    },
    [makeQueue, refresh, startListening],
  );

  const pause = useCallback(async () => {
    await stopListening();
    await queueRef.current?.flush();
    setState("paused");
  }, [stopListening]);

  const resume = useCallback(async () => {
    setNotice("");
    if (await startListening()) setState("running");
  }, [startListening]);

  const finish = useCallback(async () => {
    await stopListening();
    await queueRef.current?.flush();
    persistSession({ endedAt: Date.now() });
    queueRef.current?.dispose();
    queueRef.current = null;
    setState("idle");
    setStatus("idle");
  }, [persistSession, stopListening]);

  const reset = useCallback(() => {
    sessionRef.current = null;
    setSession(null);
    itemsRef.current = [];
    setItems([]);
    setNotice("");
  }, []);

  // 离开页面时停止录音，但不结束课程（下次可以继续）
  useEffect(
    () => () => {
      void recRef.current?.stop();
      void backupRef.current?.stop();
      void keepAwake(false);
    },
    [],
  );

  return { state, session, items, partial, status, notice, pendingCount, start, pause, resume, finish, reset, setNotice };
}
