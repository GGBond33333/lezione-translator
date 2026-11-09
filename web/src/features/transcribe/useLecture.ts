import { useCallback, useEffect, useRef, useState } from "react";
import { AudioBackup } from "../../core/audioBackup";
import { describeApiError, isPermanentApiError } from "../../core/claudeTranslator";
import { diag } from "../../core/diagLog";
import { isIOS, keepAwake } from "../../core/device";
import { claudeTranslator, createRecognizer, currentTranslatorRoute, offline } from "../../core/engines";
import { other, type Lang } from "../../core/languages";
import { onMicLost } from "../../core/mic";
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
  /** 自动恢复多次失败，需要用户点一下按钮才能重新拿到麦克风 */
  const [stalled, setStalled] = useState(false);

  const sessionRef = useRef<Session | null>(null);
  const courseRef = useRef<Course | undefined>(undefined);
  const itemsRef = useRef<Utterance[]>([]);
  const seqRef = useRef(0);
  const recRef = useRef<Recognizer | null>(null);
  const queueRef = useRef<TranslationQueue | null>(null);
  const backupRef = useRef<AudioBackup | null>(null);
  const stateRef = useRef<LectureState>("idle");
  stateRef.current = state;
  const recoveringRef = useRef(false);
  const recoverFailuresRef = useRef(0);

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

    // iPhone 上 Safari 语音识别和录音备份会抢麦克风，联网识别时默认不同时录音
    const settings = getSettings();
    if (settings.audioBackup && (rec.kind === "whisper" || settings.audioBackupWithWebSpeech)) {
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
    void keepAwake(true).then((ok) => {
      if (!ok && isIOS()) {
        diag("防锁屏：不可用");
        setNotice("这台 iPhone 不支持网页防锁屏。请在 设置 → 显示与亮度 → 自动锁定 里临时改为“永不”，锁屏后转写会中断。");
      }
    });
    diag(`课堂转写：开始识别（${rec.kind}）`);
    return true;
  }, [persistSession, refresh]);

  /** 被系统打断后自动恢复识别和录音备份；连续失败 3 次就停下，等用户点按钮 */
  const recover = useCallback(async (reason: string, message?: string) => {
    if (stateRef.current !== "running" || recoveringRef.current || !recRef.current) return;
    recoveringRef.current = true;
    diag(`课堂转写：自动恢复（${reason}）`);
    try {
      await recRef.current.restart(reason);
      await backupRef.current?.restart();
      recoverFailuresRef.current = 0;
      if (message) setNotice(message);
    } catch (e) {
      recoverFailuresRef.current++;
      diag(`课堂转写：自动恢复失败 ${recoverFailuresRef.current} 次：${e instanceof Error ? e.message : e}`);
      if (recoverFailuresRef.current >= 3) {
        setStalled(true);
        setNotice("麦克风一直被系统占用，自动恢复失败。请点下面的“重新开始识别”。");
      } else {
        setTimeout(() => void recover(reason, message), 3_000);
      }
    } finally {
      recoveringRef.current = false;
    }
  }, []);

  // 切到后台或锁屏时 iOS 会停掉录音；回到前台时自动恢复
  useEffect(() => {
    let hiddenAt = 0;
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        hiddenAt = Date.now();
        diag("页面：切到后台");
        return;
      }
      const seconds = hiddenAt ? Math.round((Date.now() - hiddenAt) / 1000) : 0;
      hiddenAt = 0;
      diag(`页面：回到前台（离开 ${seconds} 秒）`);
      if (stateRef.current !== "running") return;
      const away = seconds >= 60 ? `约 ${Math.round(seconds / 60)} 分钟` : `${seconds} 秒`;
      void recover("回到前台", `刚才切到后台或锁屏了 ${away}，识别已自动恢复（这段时间的内容没有记录）。`);
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [recover]);

  // 来电、通知、耳机插拔会让麦克风音轨被静音或结束
  useEffect(
    () =>
      onMicLost(() => {
        if (stateRef.current !== "running" || document.visibilityState === "hidden") return;
        // 稍等一下：系统打断常常很短，紧接着就恢复了
        setTimeout(() => {
          if (recRef.current?.kind === "webspeech") void backupRef.current?.restart();
          else void recover("麦克风被打断", "麦克风被系统打断（来电、通知或耳机切换），已自动恢复。");
        }, 1_000);
      }),
    [recover],
  );

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

  /** 用户点“重新开始识别”：在点击里重新申请麦克风，iOS 更容易成功 */
  const restartManually = useCallback(async () => {
    diag("课堂转写：用户手动重新开始识别");
    await stopListening();
    setStalled(false);
    recoverFailuresRef.current = 0;
    setNotice("");
    if (await startListening()) setState("running");
    else setState("paused");
  }, [startListening, stopListening]);

  const pause = useCallback(async () => {
    await stopListening();
    await queueRef.current?.flush();
    setStalled(false);
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
    setStalled(false);
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

  return {
    state,
    session,
    items,
    partial,
    status,
    notice,
    pendingCount,
    stalled,
    start,
    pause,
    resume,
    finish,
    reset,
    restartManually,
    setNotice,
  };
}
