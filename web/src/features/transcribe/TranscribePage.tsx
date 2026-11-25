import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ModelPicker, Sheet } from "../../components/ModelPicker";
import { LANGS, type Lang } from "../../core/languages";
import { estimateLivePerHour, formatUsd, MODELS, OFFLINE_INFO } from "../../core/models-catalog";
import { ASR_USD_PER_HOUR } from "../../core/openaiAsr";
import { useOnline } from "../../core/network";
import { updateSettings, useSettings } from "../../core/settings";
import { findUnfinishedLecture, listCourses, newId, saveCourse, type Course, type Session } from "../../storage/db";
import { useLecture } from "./useLecture";

const VISIBLE = 300;
const STATUS_LABEL = { idle: "未开始", listening: "收音中", reconnecting: "重连中", processing: "识别中" } as const;
const KIND_LABEL = { webspeech: "Safari 识别", whisper: "离线识别", cloud: "云端远场识别" } as const;

/** 实时音量条：-60 dB 到 -10 dB 映射为 0–100%；最近 15 秒都很弱时提示靠近或外接麦克风 */
function LevelMeter({ level }: { level: number }) {
  const peaks = useRef<{ at: number; v: number }[]>([]);
  const now = Date.now();
  peaks.current.push({ at: now, v: level });
  peaks.current = peaks.current.filter((p) => now - p.at < 15_000);
  const loudest = Math.max(...peaks.current.map((p) => p.v));
  const startedLongAgo = now - peaks.current[0].at > 10_000;
  const db = 20 * Math.log10(Math.max(level, 1e-6));
  const pct = Math.min(100, Math.max(0, ((db + 60) / 50) * 100));
  return (
    <div style={{ marginTop: 6 }}>
      <div className="meter" aria-label="收音音量">
        <div style={{ width: `${pct}%` }} />
      </div>
      {startedLongAgo && loudest < 0.003 && (
        <p className="muted small" style={{ margin: "4px 0 0" }}>
          收音很弱：老师说话时音量条几乎不动。请把手机往讲台方向放、离近一点，或外接夹领麦克风。
        </p>
      )}
    </div>
  );
}

export function TranscribePage({ onOpenHistory }: { onOpenHistory(id: string): void }) {
  const lec = useLecture();
  const settings = useSettings();
  const online = useOnline();
  const [courses, setCourses] = useState<Course[]>([]);
  const [courseId, setCourseId] = useState<string>("");
  const [lang, setLang] = useState<Lang>("it");
  const [picker, setPicker] = useState(false);
  const [powerSave, setPowerSave] = useState(false);
  const [unfinished, setUnfinished] = useState<Session | undefined>();

  useEffect(() => {
    void listCourses().then(setCourses);
    void findUnfinishedLecture().then(setUnfinished);
  }, [lec.state]);

  const modelName = settings.liveModel === "offline" ? OFFLINE_INFO.name : MODELS[settings.liveModel].name;
  const offlineMode = settings.mode === "offline" || !online || settings.liveModel === "offline";

  async function addCourse() {
    const name = window.prompt("课程名称（如：Storia della musica）")?.trim();
    if (!name) return;
    const c: Course = { id: newId(), name, glossary: [] };
    await saveCourse(c);
    setCourses(await listCourses());
    setCourseId(c.id);
  }

  const last = useMemo(() => lec.items.slice(-3), [lec.items]);
  // 3 小时约 1,800 句：实时页面只显示最近 VISIBLE 句，保持流畅
  const visible = useMemo(() => lec.items.slice(-VISIBLE), [lec.items]);

  // 停在底部时自动跟随新句子；手动往上翻看时不打扰
  const listRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const onScroll = () => {
    const el = listRef.current;
    if (el) atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };
  useLayoutEffect(() => {
    const el = listRef.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [lec.items]);
  const elapsed = lec.session ? Math.floor((Date.now() - lec.session.startedAt) / 60000) : 0;

  return (
    <div className="page fill">
      {lec.state === "idle" && !lec.session && (
        <>
          <h1>课堂转写</h1>
          {unfinished && (
            <div className="notice info">
              上次的「{unfinished.title}」没有结束。
              <div className="row" style={{ marginTop: 8 }}>
                <button className="btn primary" onClick={() => lec.start({ sourceLang: unfinished.sourceLang, resumeId: unfinished.id })}>
                  继续上次的课
                </button>
                <button className="btn" onClick={() => onOpenHistory(unfinished.id)}>
                  查看
                </button>
              </div>
            </div>
          )}
          <label className="field">
            <span>课程（用于统一专业术语的译法）</span>
            <div className="row" style={{ flexWrap: "nowrap" }}>
              <select value={courseId} onChange={(e) => setCourseId(e.target.value)}>
                <option value="">不选课程</option>
                {courses.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}（{c.glossary.length} 个术语）
                  </option>
                ))}
              </select>
              <button className="btn" onClick={addCourse}>
                新建
              </button>
            </div>
          </label>
          <div className="field">
            <span>老师讲的语言</span>
            <div className="seg">
              {(["it", "zh"] as Lang[]).map((l) => (
                <button key={l} className={lang === l ? "on" : ""} onClick={() => setLang(l)}>
                  {LANGS[l].flag} {l === "it" ? "意大利语 → 中文" : "中文 → 意大利语"}
                </button>
              ))}
            </div>
          </div>
          <div className="field">
            <span>实时翻译模型</span>
            <button className="btn block" style={{ textAlign: "left" }} onClick={() => setPicker(true)}>
              {modelName} · 每小时约 {formatUsd(estimateLivePerHour(settings.liveModel))} ›
            </button>
            <span className="muted small">
              语音识别：
              {settings.liveRecognizer === "cloud" && settings.openaiKey
                ? `云端远场识别，每小时约 ${formatUsd(ASR_USD_PER_HOUR)}`
                : "Safari 自带（免费）"}
              ，可在"设置 → 语音识别"里更换
            </span>
          </div>
          <p className="muted small">
            长课建议：把手机插上充电宝，开始后可以打开"省电黑屏"。课后在"历史"里点"课后精修"，用 Sonnet 生成准确的全文译文和课堂笔记。
          </p>
          <div className="spacer" />
          <button className="btn primary big block" onClick={() => lec.start({ courseId: courseId || undefined, sourceLang: lang })}>
            🎙️ 开始上课
          </button>
        </>
      )}

      {lec.session && (
        <>
          <div className="row">
            <strong style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {lec.session.title}
            </strong>
            <button className="chip blue" onClick={() => setPicker(true)}>
              {settings.liveModel === "offline" ? "离线" : MODELS[settings.liveModel].name.replace("Claude ", "")}
            </button>
          </div>
          <div className="row" style={{ marginTop: 6 }}>
            <span className={`chip ${offlineMode ? "amber" : "green"}`}>{offlineMode ? "离线" : "联网"}</span>
            <span className={`chip ${lec.status === "reconnecting" ? "amber" : lec.status === "listening" ? "green" : ""}`}>
              {lec.state === "paused" ? "已暂停" : STATUS_LABEL[lec.status]}
            </span>
            <span className="chip">本节 {formatUsd(lec.session.costUsd)}</span>
            <span className="chip">{elapsed} 分钟</span>
            {lec.pendingCount > 0 && <span className="chip amber">待翻译 {lec.pendingCount}</span>}
            {lec.recKind && lec.state === "running" && <span className="chip">{KIND_LABEL[lec.recKind]}</span>}
          </div>
          {lec.level !== null && lec.state === "running" && <LevelMeter level={lec.level} />}
          {lec.notice && <div className="notice">{lec.notice}</div>}
          {lec.stalled && lec.state === "running" && (
            <button className="btn primary big block" style={{ marginTop: 8 }} onClick={() => void lec.restartManually()}>
              🎙️ 重新开始识别
            </button>
          )}

          <div className="transcript" ref={listRef} onScroll={onScroll}>
            {lec.items.length > VISIBLE && (
              <div className="utt muted small">前面还有 {lec.items.length - VISIBLE} 句，结束后可在"历史"里查看全文</div>
            )}
            {visible.map((u) => (
              <div className="utt" key={u.seq}>
                <div className="src">{u.source}</div>
                {u.translation ? (
                  <div className="tr">{u.refined || u.translation}</div>
                ) : (
                  <div className="tr pending">{u.status === "pending" ? "翻译中…" : "翻译失败，稍后重试"}</div>
                )}
              </div>
            ))}
          </div>
          <div className="partial">{lec.partial}</div>

          <div className="controls">
            {lec.state === "running" && (
              <>
                <button className="btn" onClick={() => setPowerSave(true)}>
                  🌙 省电黑屏
                </button>
                <button className="btn" onClick={lec.pause}>
                  ⏸ 暂停
                </button>
              </>
            )}
            {lec.state === "paused" && (
              <button className="btn primary" onClick={lec.resume}>
                ▶ 继续
              </button>
            )}
            {lec.state !== "idle" && (
              <button
                className="btn danger"
                onClick={() => {
                  if (window.confirm("结束这节课？结束后可以在历史里导出和精修。")) void lec.finish();
                }}
              >
                ⏹ 结束
              </button>
            )}
            {lec.state === "idle" && (
              <>
                <button className="btn primary" onClick={() => onOpenHistory(lec.session!.id)}>
                  导出 / 课后精修
                </button>
                <button className="btn" onClick={lec.reset}>
                  新的一节课
                </button>
              </>
            )}
          </div>
        </>
      )}

      {picker && (
        <Sheet onClose={() => setPicker(false)}>
          <h2>实时翻译模型</h2>
          <ModelPicker kind="live" value={settings.liveModel} onChange={(v) => updateSettings({ liveModel: v })} />
        </Sheet>
      )}

      {powerSave && (
        <div className="powersave" onDoubleClick={() => setPowerSave(false)}>
          {last.map((u) => (
            <div className="line" key={u.seq}>
              <div className="src">{u.source}</div>
              <div className="tr">{u.refined || u.translation || "…"}</div>
            </div>
          ))}
          <div className="src" style={{ color: "#38bdf8", opacity: 0.5 }}>
            {lec.partial}
          </div>
          <div className="bar">
            <span>
              {STATUS_LABEL[lec.status]} · {formatUsd(lec.session?.costUsd ?? 0)}
            </span>
            <button onClick={() => setPowerSave(false)}>退出黑屏</button>
          </div>
        </div>
      )}
    </div>
  );
}
