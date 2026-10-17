import { useEffect, useState } from "react";
import { ModelPicker } from "../../components/ModelPicker";
import { describeApiError } from "../../core/claudeTranslator";
import { bestTranslation, shareFile, toMarkdown, toPlainText } from "../../core/export";
import { formatUsd, MODELS, type OnlineModelId } from "../../core/models-catalog";
import { useOnline } from "../../core/network";
import { refineSession, type RefineProgress } from "../../core/refine";
import { useSettings } from "../../core/settings";
import type { GlossaryEntry } from "../../core/translator";
import {
  deleteSession,
  getCourse,
  getSession,
  listAudioChunks,
  listSessions,
  listUtterances,
  saveCourse,
  type Session,
  type Utterance,
} from "../../storage/db";

function duration(s: Session): string {
  const min = Math.round(((s.endedAt ?? Date.now()) - s.startedAt) / 60000);
  return min >= 60 ? `${Math.floor(min / 60)} 小时 ${min % 60} 分` : `${min} 分钟`;
}

export function HistoryPage({ openId, onClearOpen }: { openId: string | null; onClearOpen(): void }) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    if (openId) {
      setSelected(openId);
      onClearOpen();
    }
  }, [openId, onClearOpen]);

  useEffect(() => {
    if (!selected) void listSessions().then(setSessions);
  }, [selected]);

  if (selected) return <SessionDetail id={selected} onBack={() => setSelected(null)} />;

  return (
    <div className="page">
      <h1>历史记录</h1>
      {sessions.length === 0 && <p className="muted">还没有记录。上课转写或对话后会自动保存在这台手机上。</p>}
      {sessions.map((s) => (
        <button key={s.id} className="card session-item" onClick={() => setSelected(s.id)}>
          <div className="row">
            <strong style={{ flex: 1 }}>
              {s.kind === "lecture" ? "📚" : "💬"} {s.title}
            </strong>
          </div>
          <div className="row small muted" style={{ marginTop: 4 }}>
            <span>{duration(s)}</span>
            <span>花费 {formatUsd(s.costUsd)}</span>
            {s.refinedAt && <span className="chip green">已精修</span>}
            {!s.endedAt && s.kind === "lecture" && <span className="chip amber">未结束</span>}
          </div>
        </button>
      ))}
    </div>
  );
}

function SessionDetail({ id, onBack }: { id: string; onBack(): void }) {
  const settings = useSettings();
  const online = useOnline();
  const [session, setSession] = useState<Session | null>(null);
  const [items, setItems] = useState<Utterance[]>([]);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [refineModel, setRefineModel] = useState<OnlineModelId>(settings.refineModel);
  const [showRefine, setShowRefine] = useState(false);
  const [progress, setProgress] = useState<RefineProgress | null>(null);
  const [error, setError] = useState("");
  const [suggested, setSuggested] = useState<GlossaryEntry[]>([]);
  const [picked, setPicked] = useState<Set<number>>(new Set());

  async function reload() {
    setSession((await getSession(id)) ?? null);
    setItems(await listUtterances(id));
  }

  useEffect(() => {
    void reload();
    let url: string | null = null;
    void (async () => {
      const s = await getSession(id);
      const chunks = await listAudioChunks(id);
      if (chunks.length) {
        url = URL.createObjectURL(new Blob(chunks, { type: s?.audioMime ?? chunks[0].type }));
        setAudioUrl(url);
      }
    })();
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  if (!session) return <div className="page">加载中…</div>;
  const hours = ((session.endedAt ?? Date.now()) - session.startedAt) / 3_600_000;
  const base = session.title.replace(/[\\/:*?"<>|]/g, "-");

  async function runRefine() {
    setError("");
    setShowRefine(false);
    try {
      const { glossary } = await refineSession(id, refineModel, setProgress);
      setSuggested(glossary);
      setPicked(new Set(glossary.map((_, i) => i)));
      await reload();
    } catch (e) {
      setError(`精修中断：${describeApiError(e)}。已完成的部分已保存，可以再点一次继续。`);
      await reload();
    } finally {
      setProgress(null);
    }
  }

  async function addGlossary() {
    const course = await getCourse(session!.courseId);
    if (!course) return;
    const existing = new Set(course.glossary.map((g) => g.source.toLowerCase()));
    const add = suggested.filter((g, i) => picked.has(i) && !existing.has(g.source.toLowerCase()));
    await saveCourse({ ...course, glossary: [...course.glossary, ...add] });
    setSuggested([]);
    alert(`已加入 ${add.length} 个术语到「${course.name}」`);
  }

  return (
    <div className="page">
      <button className="btn" onClick={onBack}>
        ‹ 返回
      </button>
      <h1 style={{ marginTop: 12 }}>{session.title}</h1>
      <div className="row small muted">
        <span>{new Date(session.startedAt).toLocaleString("zh-CN")}</span>
        <span>{duration(session)}</span>
        <span>{items.length} 句</span>
        <span>花费 {formatUsd(session.costUsd)}</span>
      </div>

      <div className="row" style={{ marginTop: 12 }}>
        <button className="btn" onClick={() => shareFile(`${base}.md`, toMarkdown(session, items))}>
          导出 Markdown
        </button>
        <button className="btn" onClick={() => shareFile(`${base}.txt`, toPlainText(session, items), "text/plain")}>
          导出 TXT
        </button>
        {session.kind === "lecture" && (
          <button className="btn primary" disabled={!!progress || !online || !settings.apiKey} onClick={() => setShowRefine((v) => !v)}>
            ✨ 课后精修
          </button>
        )}
      </div>
      {session.kind === "lecture" && (!online || !settings.apiKey) && (
        <p className="muted small">课后精修需要联网并在设置里填写 API Key。</p>
      )}

      {showRefine && (
        <div className="card" style={{ marginTop: 12 }}>
          <p className="small muted" style={{ marginTop: 0 }}>
            把整节课的原文交给大模型重新翻译，并生成课堂笔记（要点、时间线、人名/作品/术语表）。
          </p>
          <ModelPicker kind="refine" value={refineModel} onChange={setRefineModel} hours={hours} />
          <button className="btn primary block" onClick={runRefine}>
            用 {MODELS[refineModel].name} 开始精修
          </button>
        </div>
      )}

      {progress && (
        <div className="card">
          <div className="row small">
            <span>{progress.step}</span>
            <span className="spacer" />
            <span>{formatUsd(progress.costUsd)}</span>
          </div>
          <div className="progress" style={{ marginTop: 8 }}>
            <div style={{ width: `${(progress.done / progress.total) * 100}%` }} />
          </div>
          <p className="muted small">精修时请保持页面打开。</p>
        </div>
      )}
      {error && <div className="notice">{error}</div>}

      {suggested.length > 0 && session.courseId && (
        <div className="card">
          <strong>发现 {suggested.length} 个术语，加入课程术语表？</strong>
          {suggested.map((g, i) => (
            <label key={i} className="check">
              <input
                type="checkbox"
                checked={picked.has(i)}
                onChange={(e) => {
                  const next = new Set(picked);
                  if (e.target.checked) next.add(i);
                  else next.delete(i);
                  setPicked(next);
                }}
              />
              {g.source} → {g.target}
            </label>
          ))}
          <button className="btn primary block" onClick={addGlossary}>
            加入术语表
          </button>
        </div>
      )}

      {audioUrl && (
        <>
          <h2>录音备份</h2>
          <audio controls src={audioUrl} preload="metadata" />
        </>
      )}

      {session.notes && (
        <>
          <h2>课堂笔记</h2>
          <div className="card notes">{session.notes}</div>
        </>
      )}

      <h2>双语全文</h2>
      {items.map((u) => (
        <div key={u.seq} className="utt" style={{ margin: "0 -16px" }}>
          <div className="src">{u.source}</div>
          <div className={`tr${bestTranslation(u) ? "" : " pending"}`}>{bestTranslation(u) || "（未翻译）"}</div>
          {u.refined && u.translation && u.refined !== u.translation && <div className="meta">实时译文：{u.translation}</div>}
        </div>
      ))}

      <button
        className="btn danger block"
        style={{ marginTop: 24 }}
        onClick={async () => {
          if (!window.confirm("删除这条记录和录音？删除后无法恢复。")) return;
          await deleteSession(id);
          onBack();
        }}
      >
        删除这条记录
      </button>
    </div>
  );
}
