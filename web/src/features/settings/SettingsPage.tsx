import { useEffect, useState } from "react";
import { ModelPicker } from "../../components/ModelPicker";
import { clearDiag, formatDiag } from "../../core/diagLog";
import { loadOfflineModels, type DownloadProgress } from "../../core/mlClient";
import { updateSettings, useSettings, type NetMode } from "../../core/settings";
import { deleteCourse, listCourses, newId, saveCourse, type Course } from "../../storage/db";
import type { GlossaryEntry } from "../../core/translator";

function glossaryToText(g: GlossaryEntry[]): string {
  return g.map((x) => `${x.source} = ${x.target}`).join("\n");
}

export function parseGlossaryText(text: string): GlossaryEntry[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.split(/\s*[=＝→]\s*/))
    .filter((p) => p.length >= 2 && p[0].trim() && p[1].trim())
    .map((p) => ({ source: p[0].trim(), target: p.slice(1).join(" ").trim() }));
}

export function SettingsPage() {
  const s = useSettings();
  const [showKey, setShowKey] = useState(false);
  const [dl, setDl] = useState<DownloadProgress | null>(null);
  const [dlError, setDlError] = useState("");

  async function download() {
    setDlError("");
    setDl({ step: 0, steps: 5, label: "准备中", stepFraction: 0, overall: 0 });
    try {
      await loadOfflineModels(setDl);
      updateSettings({ offlineReady: true });
    } catch (e) {
      setDlError(
        `下载失败：${e instanceof Error ? e.message : e}。再点一次"下载离线模型"会从断点继续，已下载的部分不会重新下载。`,
      );
    } finally {
      setDl(null);
    }
  }

  return (
    <div className="page">
      <h1>设置</h1>

      <h2>Claude API Key</h2>
      <div className="card">
        <label className="field">
          <span>联网翻译需要你自己的 API Key（只保存在这台手机上）</span>
          <div className="row" style={{ flexWrap: "nowrap" }}>
            <input
              type={showKey ? "text" : "password"}
              autoComplete="off"
              placeholder="sk-ant-..."
              value={s.apiKey}
              onChange={(e) => updateSettings({ apiKey: e.target.value.trim() })}
            />
            <button className="btn" onClick={() => setShowKey((v) => !v)}>
              {showKey ? "隐藏" : "显示"}
            </button>
          </div>
        </label>
        <div className="notice info" style={{ margin: 0 }}>
          计费说明：联网翻译调用的是 Claude API，<b>不占用 Claude.ai 订阅（Pro/Max）的额度</b>。需要在 console.anthropic.com
          单独充值、创建 API Key，按实际用量扣费。默认组合下，一节 3 小时的课约 1 美元。
        </div>
      </div>

      <h2>联网 / 离线</h2>
      <div className="seg">
        {(
          [
            ["auto", "自动"],
            ["online", "仅联网"],
            ["offline", "仅离线"],
          ] as [NetMode, string][]
        ).map(([v, label]) => (
          <button key={v} className={s.mode === v ? "on" : ""} onClick={() => updateSettings({ mode: v })}>
            {label}
          </button>
        ))}
      </div>
      <p className="muted small">自动：有网时用 Claude 翻译，没网或出错时用离线模型。</p>

      <h2>实时翻译模型</h2>
      <ModelPicker kind="live" value={s.liveModel} onChange={(v) => updateSettings({ liveModel: v })} />

      <h2>课后精修默认模型</h2>
      <ModelPicker kind="refine" value={s.refineModel} onChange={(v) => updateSettings({ refineModel: v })} />

      <h2>双语对话模型</h2>
      <ModelPicker kind="conversation" value={s.conversationModel} onChange={(v) => updateSettings({ conversationModel: v })} />

      <h2>对话记录保存时间</h2>
      <div className="seg">
        {(
          [
            [7, "7 天"],
            [30, "30 天"],
            [90, "90 天"],
            [0, "永久"],
          ] as [number, string][]
        ).map(([v, label]) => (
          <button
            key={v}
            className={s.conversationRetentionDays === v ? "on" : ""}
            onClick={() => updateSettings({ conversationRetentionDays: v })}
          >
            {label}
          </button>
        ))}
      </div>
      <p className="muted small">对话记录只保存在这台手机上，超过时间后自动删除。课堂记录不会自动删除。</p>

      <h2>费用上限</h2>
      <div className="card">
        <label className="field">
          <span>单节课实时翻译最多花费（美元，0 = 不限）</span>
          <input
            type="number"
            inputMode="decimal"
            min={0}
            step={0.5}
            value={s.costCapUsd}
            onChange={(e) => updateSettings({ costCapUsd: Math.max(0, Number(e.target.value) || 0) })}
          />
        </label>
        <p className="muted small" style={{ margin: 0 }}>
          超过后自动切换到 Haiku；已经是 Haiku 的话切换到离线模型（没下载离线模型则暂停翻译，只记录原文）。
        </p>
      </div>

      <h2>长课</h2>
      <label className="card check">
        <input type="checkbox" checked={s.audioBackup} onChange={(e) => updateSettings({ audioBackup: e.target.checked })} />
        <span>
          上课时同时录音备份（3 小时约 40MB，存在本机）
          <br />
          <span className="muted small">离线识别时一直有效。</span>
        </span>
      </label>
      {s.audioBackup && (
        <label className="card check">
          <input
            type="checkbox"
            checked={s.audioBackupWithWebSpeech}
            onChange={(e) => updateSettings({ audioBackupWithWebSpeech: e.target.checked })}
          />
          <span>
            联网识别时也录音备份
            <br />
            <span className="muted small">
              iPhone 上录音和 Safari 语音识别会抢麦克风，可能导致识别突然不出字，所以默认关闭。
            </span>
          </span>
        </label>
      )}

      <h2>离线模型</h2>
      <div className="card">
        <p style={{ marginTop: 0 }}>
          状态：{s.offlineReady ? <span className="chip green">已下载</span> : <span className="chip">未下载</span>}
        </p>
        <p className="muted small">
          Whisper 语音识别 + Opus-MT 翻译，约 300MB，请用 Wi-Fi 下载。添加到主屏幕后打开，模型才会长期保留。离线翻译质量明显不如 Claude，只作没网时的备用。
        </p>
        {dl ? (
          <>
            <div className="progress">
              <div style={{ width: `${Math.round(dl.overall * 100)}%` }} />
            </div>
            <p className="muted small">
              总进度 {Math.round(dl.overall * 100)}% · 第 {dl.step + 1}/{dl.steps} 步：{dl.label}{" "}
              {Math.round(dl.stepFraction * 100)}%
              <br />
              下载期间请保持页面打开、屏幕亮着。
            </p>
          </>
        ) : (
          <div className="row">
            <button className="btn primary" onClick={download}>
              {s.offlineReady ? "重新检查 / 更新" : "下载离线模型"}
            </button>
            {s.offlineReady && (
              <button className="btn" onClick={() => updateSettings({ offlineReady: false })}>
                停用离线模型
              </button>
            )}
          </div>
        )}
        {dlError && <div className="notice">{dlError}</div>}
      </div>

      <h2>课程与术语表</h2>
      <Courses />

      <h2>使用说明</h2>
      <div className="card small">
        <ol style={{ margin: 0, paddingLeft: 20 }}>
          <li>在 iPhone 的 Safari 里点"分享"→"添加到主屏幕"，之后从主屏幕图标打开。</li>
          <li>第一次开始识别时允许使用麦克风和语音识别。</li>
          <li>上课时保持屏幕亮着（可以用省电黑屏），iOS 锁屏后网页无法继续录音。</li>
          <li>3 小时课大约耗电 30–40%，建议带充电宝。</li>
          <li>如果屏幕还是会自动变暗锁屏：iPhone 设置 → 显示与亮度 → 自动锁定，上课时临时改为"永不"。</li>
        </ol>
      </div>

      <h2>诊断日志</h2>
      <DiagPanel />
    </div>
  );
}

function DiagPanel() {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const text = open ? formatDiag() : "";
  return (
    <div className="card">
      <p className="muted small" style={{ marginTop: 0 }}>
        记录识别启动、中断、自动恢复等事件，只保存在这台手机上。转写出问题时，复制日志发给开发者帮助定位。
      </p>
      <div className="row">
        <button className="btn" onClick={() => setOpen((v) => !v)}>
          {open ? "收起" : "查看日志"}
        </button>
        <button
          className="btn"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(formatDiag());
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            } catch {
              setOpen(true);
              alert("无法自动复制，请在下方长按选择全部文字后复制");
            }
          }}
        >
          {copied ? "已复制" : "复制日志"}
        </button>
        <button
          className="btn"
          onClick={() => {
            clearDiag();
            setOpen(false);
          }}
        >
          清空
        </button>
      </div>
      {open && <textarea readOnly value={text} style={{ marginTop: 8, minHeight: 200, fontSize: 12 }} />}
    </div>
  );
}

function Courses() {
  const [courses, setCourses] = useState<Course[]>([]);
  const [editing, setEditing] = useState<Course | null>(null);
  const [text, setText] = useState("");

  useEffect(() => {
    void listCourses().then(setCourses);
  }, [editing]);

  if (editing) {
    return (
      <div className="card">
        <label className="field">
          <span>课程名称</span>
          <input type="text" value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
        </label>
        <label className="field">
          <span>术语表：每行一个，格式"原文 = 译文"</span>
          <textarea
            value={text}
            placeholder={"basso continuo = 通奏低音\nRisorgimento = 意大利复兴运动"}
            onChange={(e) => setText(e.target.value)}
          />
        </label>
        <div className="row">
          <button
            className="btn primary"
            onClick={async () => {
              if (!editing.name.trim()) return;
              await saveCourse({ ...editing, name: editing.name.trim(), glossary: parseGlossaryText(text) });
              setEditing(null);
            }}
          >
            保存
          </button>
          <button className="btn" onClick={() => setEditing(null)}>
            取消
          </button>
          <span className="spacer" />
          <button
            className="btn danger"
            onClick={async () => {
              if (!window.confirm(`删除课程「${editing.name}」？已有的上课记录不受影响。`)) return;
              await deleteCourse(editing.id);
              setEditing(null);
            }}
          >
            删除
          </button>
        </div>
      </div>
    );
  }

  return (
    <div>
      {courses.map((c) => (
        <button
          key={c.id}
          className="card session-item"
          onClick={() => {
            setEditing(c);
            setText(glossaryToText(c.glossary));
          }}
        >
          <strong>{c.name}</strong>
          <span className="muted small"> · {c.glossary.length} 个术语 ›</span>
        </button>
      ))}
      <button
        className="btn block"
        onClick={() => {
          setEditing({ id: newId(), name: "", glossary: [] });
          setText("");
        }}
      >
        + 新建课程
      </button>
    </div>
  );
}
