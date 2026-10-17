import { useRef, useState } from "react";
import { describeApiError } from "../../core/claudeTranslator";
import { speak, unlockSpeech } from "../../core/device";
import { claudeTranslator, createRecognizer, currentTranslatorRoute, offline } from "../../core/engines";
import { other, type Lang } from "../../core/languages";
import { formatUsd } from "../../core/models-catalog";
import type { Recognizer } from "../../core/recognizer";
import { newId, saveSession, saveUtterance, type Session } from "../../storage/db";

interface Msg {
  id: number;
  from: Lang;
  source: string;
  translation: string;
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

export function ConversationPage() {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [talking, setTalking] = useState<Lang | null>(null);
  const [busy, setBusy] = useState(false);
  const [live, setLive] = useState("");
  const [notice, setNotice] = useState("");
  const [faceToFace, setFaceToFace] = useState(true);
  const [cost, setCost] = useState(0);
  const recRef = useRef<Recognizer | null>(null);
  const finals = useRef<string[]>([]);
  const sessionRef = useRef<Session | null>(null);
  const seq = useRef(0);

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
    const route = currentTranslatorRoute(cost);
    let translation = "";
    let engine = "";
    let usd = 0;
    const ctx = { from, to };
    try {
      if (route.engine === "claude") {
        const r = await claudeTranslator(route.model).translate([text], ctx);
        translation = r.translations[0];
        engine = r.engine;
        usd = r.costUsd;
      } else if (route.engine === "offline") {
        const r = await offline()!.translate([text], ctx);
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
          const r = await off.translate([text], ctx);
          translation = r.translations[0];
          engine = r.engine;
          setNotice("联网翻译失败，已用离线模型翻译");
        } catch {
          // 离线也失败，保留上面的错误提示
        }
      }
    }

    const msg: Msg = { id: seq.current++, from, source: text, translation: translation || "（翻译失败）" };
    setMsgs((m) => [...m.slice(-20), msg]);
    if (translation) speak(translation, to);
    setCost((c) => c + usd);

    // 保存到历史
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
    const s = sessionRef.current;
    s.costUsd += usd;
    s.endedAt = Date.now();
    await saveSession(s);
    await saveUtterance({
      sessionId: s.id,
      seq: msg.id,
      lang: from,
      source: text,
      translation,
      engine,
      status: translation ? "done" : "failed",
      at: Date.now(),
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
                {m.translation}
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

  return (
    <div className="convo" style={{ paddingTop: "env(safe-area-inset-top)" }}>
      {half("it")}
      <div className="row" style={{ padding: "6px 16px", background: "#0b1222" }}>
        <button className="chip" onClick={() => setFaceToFace((v) => !v)}>
          {faceToFace ? "面对面（上半屏倒置）" : "同向显示"}
        </button>
        <span className="chip">本次 {formatUsd(cost)}</span>
        <span className="spacer" />
        <button
          className="chip"
          onClick={() => {
            setMsgs([]);
            sessionRef.current = null;
            setCost(0);
          }}
        >
          新对话
        </button>
      </div>
      {notice && (
        <div className="notice" style={{ margin: "0 16px" }}>
          {notice}
        </div>
      )}
      {half("zh")}
    </div>
  );
}
