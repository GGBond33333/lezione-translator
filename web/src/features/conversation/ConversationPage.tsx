import { useEffect, useRef, useState } from "react";
import { ModelPicker, Sheet } from "../../components/ModelPicker";
import { describeApiError } from "../../core/claudeTranslator";
import { speak, unlockSpeech } from "../../core/device";
import { claudeTranslator, createRecognizer, currentTranslatorRoute, offline } from "../../core/engines";
import { other, type Lang } from "../../core/languages";
import { formatUsd, MODELS } from "../../core/models-catalog";
import type { ConversationTurn } from "../../core/prompts";
import type { Recognizer } from "../../core/recognizer";
import { updateSettings, useSettings } from "../../core/settings";
import {
  getSession,
  listConversations,
  listUtterances,
  newId,
  purgeOldConversations,
  saveSession,
  saveUtterance,
  type Session,
} from "../../storage/db";

interface Msg extends ConversationTurn {
  id: number;
  at: number;
}

const TEXT = {
  zh: { hold: "🇨🇳 按住说中文", release: "松开结束", empty: "按住下面的按钮说中文，松开后翻译成意大利语", busy: "翻译中…" },
  it: {
    hold: "🇮🇹 Tieni premuto e parla",
    release: "Rilascia per tradurre",
    empty: "Tieni premuto il pulsante e parla in italiano: tradurrò in cinese",
    busy: "Traduzione…",
  },
};

function time(ts: number) {
  return new Date(ts).toTimeString().slice(0, 5);
}

export function ConversationPage({ resumeId, onResumed }: { resumeId: string | null; onResumed(): void }) {
  const settings = useSettings();
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [session, setSession] = useState<Session | null>(null);
  const [talking, setTalking] = useState<Lang | null>(null);
  const [busy, setBusy] = useState(false);
  const [live, setLive] = useState("");
  const [notice, setNotice] = useState("");
  const [faceToFace, setFaceToFace] = useState(true);
  const [sheet, setSheet] = useState<"model" | "record" | null>(null);
  const [past, setPast] = useState<Session[]>([]);
  const recRef = useRef<Recognizer | null>(null);
  const finals = useRef<string[]>([]);
  const sessionRef = useRef<Session | null>(null);
  const msgsRef = useRef<Msg[]>([]);
  const seq = useRef(0);

  const model = settings.conversationModel;
  const cost = session?.costUsd ?? 0;

  function setAll(list: Msg[]) {
    msgsRef.current = list;
    setMsgs(list);
  }

  function startNew() {
    sessionRef.current = null;
    setSession(null);
    setAll([]);
    seq.current = 0;
    setNotice("");
  }

  /** 继续一段以前的对话：载入完整记录，之后翻译会参考这些前文 */
  async function resume(id: string) {
    const s = await getSession(id);
    if (!s) return;
    const list = await listUtterances(id);
    sessionRef.current = s;
    setSession(s);
    setAll(
      list.map((u) => ({ id: u.seq, from: u.lang, source: u.source, translation: u.translation ?? "", at: u.at })),
    );
    seq.current = list.reduce((m, u) => Math.max(m, u.seq + 1), 0);
    setSheet(null);
    setNotice("");
  }

  useEffect(() => {
    if (resumeId) {
      void resume(resumeId);
      onResumed();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resumeId]);

  async function openRecord() {
    await purgeOldConversations(settings.conversationRetentionDays);
    setPast((await listConversations()).filter((s) => s.id !== sessionRef.current?.id));
    setSheet("record");
  }

  async function down(lang: Lang) {
    if (talking || busy) return;
    unlockSpeech();
    setNotice("");
    const rec = createRecognizer(0);
    if (typeof rec === "string") {
      setNotice(rec);
      return;
    }
    finals.current = [];
    recRef.current = rec;
    setTalking(lang);
    try {
      await rec.start(lang, {
        onPartial: setLive,
        onFinal: (t) => finals.current.push(t),
        onError: setNotice,
      });
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
      setTalking(null);
      recRef.current = null;
    }
  }

  async function up() {
    const lang = talking;
    const rec = recRef.current;
    if (!lang || !rec) return;
    recRef.current = null;
    setTalking(null);
    setBusy(true);
    try {
      await rec.stop();
      setLive("");
      const text = finals.current.join(" ").trim();
      if (!text) return;
      await translateAndShow(lang, text);
    } finally {
      setBusy(false);
    }
  }

  async function translateAndShow(from: Lang, text: string) {
    const to = other(from);
    const route = currentTranslatorRoute(sessionRef.current?.costUsd ?? 0, model);
    const history: ConversationTurn[] = msgsRef.current;
    let translation = "";
    let engine = "";
    let usd = 0;
    try {
      if (route.engine === "claude") {
        const r = await claudeTranslator(route.model).translateTurn(text, from, to, history);
        translation = r.translations[0];
        engine = r.engine;
        usd = r.costUsd;
        if (route.downgraded) setNotice("已超过费用上限，已自动切换到 Haiku");
      } else if (route.engine === "offline") {
        const r = await offline()!.translate([text], { from, to });
        translation = r.translations[0];
        engine = r.engine;
      } else {
        setNotice(route.reason);
      }
    } catch (e) {
      setNotice(describeApiError(e));
      const off = route.engine === "claude" ? offline() : null;
      if (off) {
        try {
          const r = await off.translate([text], { from, to });
          translation = r.translations[0];
          engine = r.engine;
          setNotice("联网翻译失败，已用离线模型翻译");
        } catch {
          // 离线也失败，保留上面的错误提示
        }
      }
    }

    const msg: Msg = { id: seq.current++, from, source: text, translation, at: Date.now() };
    setAll([...msgsRef.current, msg]);
    if (translation) speak(translation, to);

    // 每句话都立即保存，作为对话记录和下次翻译的前文
    if (!sessionRef.current) {
      const now = new Date();
      sessionRef.current = {
        id: newId(),
        kind: "conversation",
        title: `对话 ${now.toLocaleDateString("zh-CN")} ${now.toTimeString().slice(0, 5)}`,
        sourceLang: "zh",
        startedAt: Date.now(),
        costUsd: 0,
      };
    }
    const s = { ...sessionRef.current, costUsd: sessionRef.current.costUsd + usd, endedAt: Date.now() };
    sessionRef.current = s;
    setSession(s);
    await saveSession(s);
    await saveUtterance({
      sessionId: s.id,
      seq: msg.id,
      lang: from,
      source: text,
      translation,
      engine,
      status: translation ? "done" : "failed",
      at: msg.at,
    });
  }

  function half(lang: Lang) {
    const t = TEXT[lang];
    const mine = msgs.filter((m) => m.from === lang).slice(-1);
    const theirs = msgs.filter((m) => m.from !== lang).slice(-2);
    const shown = msgs.filter((m) => mine.includes(m) || theirs.includes(m));
    const isTop = lang === "it";
    return (
      <div className={`half${isTop ? " top" : ""}${isTop && !faceToFace ? " flat" : ""}`}>
        <div className="msgs">
          {shown.length === 0 && <div className="muted">{t.empty}</div>}
          {shown.map((m) =>
            m.from === lang ? (
              <div key={m.id} className="bubble mine">
                {m.source}
              </div>
            ) : (
              <div key={m.id} className="bubble theirs">
                {m.translation || "（翻译失败）"}
                <span className="orig">{m.source}</span>
              </div>
            ),
          )}
        </div>
        <div className="live">{talking === lang ? live || "…" : busy && !talking ? t.busy : ""}</div>
        <button
          className={`talk ${lang}${talking === lang ? " active" : ""}`}
          disabled={busy || (talking !== null && talking !== lang)}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            void down(lang);
          }}
          onPointerUp={() => void up()}
          onPointerCancel={() => void up()}
          onContextMenu={(e) => e.preventDefault()}
        >
          {talking === lang ? t.release : t.hold}
        </button>
      </div>
    );
  }

  const retention = settings.conversationRetentionDays;

  return (
    <div className="convo" style={{ paddingTop: "env(safe-area-inset-top)" }}>
      {half("it")}
      <div className="row" style={{ padding: "6px 16px", background: "#0b1222", gap: 6 }}>
        <button className="chip blue" onClick={() => setSheet("model")}>
          {model === "offline" ? "离线" : MODELS[model].name.replace("Claude ", "")}
        </button>
        <button className="chip" onClick={openRecord}>
          📜 记录{msgs.length ? ` ${msgs.length}` : ""}
        </button>
        <button className="chip" onClick={() => setFaceToFace((v) => !v)}>
          {faceToFace ? "面对面" : "同向"}
        </button>
        <span className="chip">{formatUsd(cost)}</span>
        <span className="spacer" />
        <button className="chip" onClick={startNew}>
          新对话
        </button>
      </div>
      {notice && (
        <div className="notice" style={{ margin: "0 16px" }}>
          {notice}
        </div>
      )}
      {half("zh")}

      {sheet === "model" && (
        <Sheet onClose={() => setSheet(null)}>
          <h2>双语对话翻译模型</h2>
          <ModelPicker kind="conversation" value={model} onChange={(v) => updateSettings({ conversationModel: v })} />
        </Sheet>
      )}

      {sheet === "record" && (
        <Sheet onClose={() => setSheet(null)}>
          <h2>本次对话记录</h2>
          {msgs.length === 0 ? (
            <p className="muted">还没有内容。</p>
          ) : (
            <div className="card" style={{ maxHeight: "40vh", overflowY: "auto" }}>
              {msgs.map((m) => (
                <div key={m.id} style={{ marginBottom: 10 }}>
                  <div className="small muted">
                    {m.from === "zh" ? "🇨🇳 我" : "🇮🇹 对方"} · {time(m.at)}
                  </div>
                  <div>{m.source}</div>
                  <div style={{ color: "#38bdf8" }}>{m.translation || "（翻译失败）"}</div>
                </div>
              ))}
            </div>
          )}
          <p className="muted small">
            翻译每句话时会参考最近 12 句聊天内容，代词、人名、文件名会翻得更准确。对话记录只保存在这台手机上，
            {retention ? `超过 ${retention} 天自动删除` : "永久保存"}（可在设置里修改），也可以在"历史"里导出。
          </p>

          <h2>以前的对话</h2>
          {past.length === 0 && <p className="muted small">没有其他对话记录。</p>}
          {past.map((s) => (
            <div key={s.id} className="card row" style={{ flexWrap: "nowrap" }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div>{s.title}</div>
                <div className="small muted">
                  最后：{new Date(s.endedAt ?? s.startedAt).toLocaleString("zh-CN")} · {formatUsd(s.costUsd)}
                </div>
              </div>
              <button className="btn" onClick={() => resume(s.id)}>
                继续
              </button>
            </div>
          ))}
        </Sheet>
      )}
    </div>
  );
}
