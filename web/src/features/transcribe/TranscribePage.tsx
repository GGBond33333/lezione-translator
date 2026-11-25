import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Dots, Icon } from "../../components/Icon";
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
    <div style={{ marginTop: 10 }}>
      <div className="meter" role="meter" aria-label="收音音量" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
        <div style={{ width: `${pct}%` }} />
      </div>
      {startedLongAgo && loudest < 0.003 && (
        <div className="meter-hint">
          <span>🎙️</span>
          <span>收音很弱：老师说话时音量条几乎不动。请把手机往讲台方向放、离近一点，或外接夹领麦克风。</span>
        </div>
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
          <div style={{ flex: 1, minHeight: 0, overflowY: "auto", margin: "0 -16px", padding: "0 16px" }}>
            <h1>课堂转写</h1>
            {unfinished && (
              <div className="card" style={{ background: "var(--accent-tint)", boxShadow: "none" }}>
                <div style={{ fontWeight: 600 }}>上次的课还没结束</div>
                <div className="muted small" style={{ marginTop: 2 }}>
                  「{unfinished.title}」
                </div>
                <div className="row" style={{ marginTop: 12, flexWrap: "nowrap" }}>
                  <button
                    className="btn primary"
                    style={{ flex: 1 }}
                    onClick={() => lec.start({ sourceLang: unfinished.sourceLang, resumeId: unfinished.id })}
                  >
                    继续上次的课
                  </button>
                  <button className="btn gray" onClick={() => onOpenHistory(unfinished.id)}>
                    查看
                  </button>
                </div>
              </div>
            )}

            <div className="group-title">这节课</div>
            <div className="group">
              <label className="cell">
                <span className="label">课程</span>
                <select value={courseId} onChange={(e) => setCourseId(e.target.value)} aria-label="选择课程">
                  <option value="">不选课程</option>
                  {courses.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}（{c.glossary.length} 个术语）
                    </option>
                  ))}
                </select>
                <span className="chev">
                  <Icon name="chevron" size={16} />
                </span>
              </label>
              <button className="cell" onClick={addCourse}>
                <span className="label" style={{ color: "var(--accent)" }}>
                  新建课程
                </span>
                <span className="chev" style={{ color: "var(--accent)" }}>
                  <Icon name="plus" size={18} />
                </span>
              </button>
              <div className="cell-block">
                <div className="label">老师讲的语言</div>
                <div className="seg">
                  {(["it", "zh"] as Lang[]).map((l) => (
                    <button key={l} className={lang === l ? "on" : ""} onClick={() => setLang(l)}>
                      {LANGS[l].flag} {l === "it" ? "意大利语 → 中文" : "中文 → 意大利语"}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <div className="group-foot">选择课程后，会用它的术语表统一专业词汇的译法。</div>

            <div className="group-title">识别与翻译</div>
            <div className="group">
              <button className="cell" onClick={() => setPicker(true)}>
                <span className="label">实时翻译</span>
                <span className="value">
                  {modelName.replace("Claude ", "")} · 约 {formatUsd(estimateLivePerHour(settings.liveModel))}/时
                </span>
                <span className="chev">
                  <Icon name="chevron" size={16} />
                </span>
              </button>
              <div className="cell">
                <span className="label">语音识别</span>
                <span className="value">
                  {settings.liveRecognizer === "cloud" && settings.openaiKey
                    ? `云端远场 · 约 ${formatUsd(ASR_USD_PER_HOUR)}/时`
                    : "Safari 自带 · 免费"}
                </span>
              </div>
            </div>
            <div className="group-foot">语音识别方式可在"设置 → 语音识别"里更换。</div>

            <div className="card tip" style={{ marginTop: 20 }}>
              <span className="tile orange">💡</span>
              <span>
                长课建议：把手机插上充电宝，开始后可以打开"省电黑屏"。课后在"历史"里点"课后精修"，用 Sonnet 生成准确的全文译文和课堂笔记。
              </span>
            </div>
          </div>
          <div className="start-bar">
            <button className="btn primary big block" onClick={() => lec.start({ courseId: courseId || undefined, sourceLang: lang })}>
              <Icon name="mic" filled /> 开始上课
            </button>
          </div>
        </>
      )}

      {lec.session && (
        <>
          <div className="lecture-head">
            <span className="title">{lec.session.title}</span>
            <button className="chip blue" onClick={() => setPicker(true)}>
              {settings.liveModel === "offline" ? "离线" : MODELS[settings.liveModel].name.replace("Claude ", "")}
            </button>
          </div>
          <div className="status-row">
            <span className={`chip ${offlineMode ? "amber" : "green"}`}>{offlineMode ? "离线" : "联网"}</span>
            <span
              className={`chip ${
                lec.state === "paused" ? "" : lec.status === "reconnecting" ? "amber" : lec.status === "idle" ? "" : "green live"
              }`}
            >
              {lec.state === "paused" ? "已暂停" : STATUS_LABEL[lec.status]}
            </span>
            <span className="chip">本节 {formatUsd(lec.session.costUsd)}</span>
            <span className="chip">{elapsed} 分钟</span>
            {lec.pendingCount > 0 && <span className="chip amber">待翻译 {lec.pendingCount}</span>}
            {lec.recKind && lec.state === "running" && <span className="chip blue">{KIND_LABEL[lec.recKind]}</span>}
          </div>
          {lec.level !== null && lec.state === "running" && <LevelMeter level={lec.level} />}
          {lec.notice && (
            <div className="notice">
              <span className="notice-body">{lec.notice}</span>
            </div>
          )}
          {lec.stalled && lec.state === "running" && (
            <button className="btn primary big block" style={{ marginTop: 8 }} onClick={() => void lec.restartManually()}>
              <Icon name="mic" filled /> 重新开始识别
            </button>
          )}

          <div className="transcript" ref={listRef} onScroll={onScroll}>
            {lec.items.length > VISIBLE && (
              <div className="utt more">前面还有 {lec.items.length - VISIBLE} 句，结束后可在"历史"里查看全文</div>
            )}
            {visible.map((u) => (
              <div className="utt" key={u.seq}>
                <div className="src">{u.source}</div>
                {u.translation ? (
                  <div className="tr">{u.refined || u.translation}</div>
                ) : (
                  u.status === "pending" ? (
                    <div className="tr pending">
                      <Dots /> 翻译中
                    </div>
                  ) : (
                    <div className="tr failed">翻译失败，稍后自动重试</div>
                  )
                )}
              </div>
            ))}
          </div>
          <div className="partial">{lec.partial}</div>

          <div className="controls">
            {lec.state === "running" && (
              <>
                <button className="btn gray" onClick={() => setPowerSave(true)}>
                  <Icon name="moon" /> 省电黑屏
                </button>
                <button className="btn gray" onClick={lec.pause}>
                  <Icon name="pause" /> 暂停
                </button>
              </>
            )}
            {lec.state === "paused" && (
              <button className="btn primary" onClick={lec.resume}>
                <Icon name="play" filled /> 继续
              </button>
            )}
            {lec.state !== "idle" && (
              <button
                className="btn danger"
                onClick={() => {
                  if (window.confirm("结束这节课？结束后可以在历史里导出和精修。")) void lec.finish();
                }}
              >
                <Icon name="stop" filled /> 结束
              </button>
            )}
            {lec.state === "idle" && (
              <>
                <button className="btn primary" onClick={() => onOpenHistory(lec.session!.id)}>
                  导出 / 课后精修
                </button>
                <button className="btn gray" onClick={lec.reset}>
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
          <div className="live">{lec.partial}</div>
          <div className="bar">
            <span>
              {STATUS_LABEL[lec.status]} · {formatUsd(lec.session?.costUsd ?? 0)} · 双击屏幕退出
            </span>
            <button onClick={() => setPowerSave(false)}>退出黑屏</button>
          </div>
        </div>
      )}
    </div>
  );
}
