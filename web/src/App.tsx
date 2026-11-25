import { useCallback, useState } from "react";
import { Icon, type IconName } from "./components/Icon";
import { isIOS, isStandalone } from "./core/device";
import { updateSettings, useSettings } from "./core/settings";
import { ConversationPage } from "./features/conversation/ConversationPage";
import { HistoryPage } from "./features/history/HistoryPage";
import { SettingsPage } from "./features/settings/SettingsPage";
import { TranscribePage } from "./features/transcribe/TranscribePage";

type Tab = "transcribe" | "conversation" | "history" | "settings";

const TABS: { id: Tab; label: string; icon: IconName }[] = [
  { id: "transcribe", label: "课堂转写", icon: "mic" },
  { id: "conversation", label: "双语对话", icon: "chat" },
  { id: "history", label: "历史", icon: "clock" },
  { id: "settings", label: "设置", icon: "gear" },
];

export function App() {
  const [tab, setTab] = useState<Tab>("transcribe");
  const [openId, setOpenId] = useState<string | null>(null);
  const settings = useSettings();

  const openHistory = useCallback((id: string) => {
    setOpenId(id);
    setTab("history");
  }, []);
  const clearOpen = useCallback(() => setOpenId(null), []);
  const [resumeConvoId, setResumeConvoId] = useState<string | null>(null);
  const continueConversation = useCallback((id: string) => {
    setResumeConvoId(id);
    setTab("conversation");
  }, []);
  const clearResume = useCallback(() => setResumeConvoId(null), []);

  return (
    <div className="app">
      {!settings.onboarded && <Onboarding onDone={(goSettings) => {
        updateSettings({ onboarded: true });
        if (goSettings) setTab("settings");
      }} />}
      {/* 页面都保持挂载：上课录音时切到其他页面也不会中断 */}
      <div style={{ display: tab === "transcribe" ? "contents" : "none" }}>
        <TranscribePage onOpenHistory={openHistory} />
      </div>
      <div style={{ display: tab === "conversation" ? "contents" : "none" }}>
        <div className="page fill" style={{ padding: 0 }}>
          <ConversationPage resumeId={resumeConvoId} onResumed={clearResume} />
        </div>
      </div>
      {tab === "history" && (
        <HistoryPage openId={openId} onClearOpen={clearOpen} onContinueConversation={continueConversation} />
      )}
      {tab === "settings" && <SettingsPage />}
      <nav className="tabbar">
        {TABS.map((t) => (
          <button key={t.id} className={tab === t.id ? "active" : ""} onClick={() => setTab(t.id)} aria-current={tab === t.id}>
            <Icon name={t.icon} filled={tab === t.id} />
            {t.label}
          </button>
        ))}
      </nav>
    </div>
  );
}

function Onboarding({ onDone }: { onDone(goSettings: boolean): void }) {
  const needInstall = isIOS() && !isStandalone();
  return (
    <div className="sheet-backdrop">
      <div className="sheet">
        <div className="empty" style={{ padding: "8px 0 0" }}>
          <div className="emoji">🇮🇹🇨🇳</div>
        </div>
        <h1 style={{ textAlign: "center", fontSize: 26 }}>欢迎使用意中课堂翻译</h1>
        <ol className="card" style={{ paddingLeft: 36, lineHeight: 1.55, fontSize: 15 }}>
          {needInstall && (
            <li>
              <b>添加到主屏幕</b>：点 Safari 底部的"分享"按钮 →"添加到主屏幕"，之后从主屏幕图标打开，用起来和 App 一样。
            </li>
          )}
          <li>
            <b>填写 Claude API Key</b>（设置页）：联网翻译需要。它<b>不占用 Claude.ai 订阅的额度</b>，需要在 console.anthropic.com
            单独充值，按用量计费；默认组合下一节 3 小时的课约 1 美元。
          </li>
          <li>
            <b>可选：下载离线模型</b>（约 300MB，用 Wi-Fi）：没网时也能识别和翻译，但质量一般。
          </li>
          <li>第一次开始识别时，请允许使用麦克风和语音识别。</li>
        </ol>
        <div className="row" style={{ flexWrap: "nowrap" }}>
          <button className="btn primary big" style={{ flex: 1 }} onClick={() => onDone(true)}>
            去设置
          </button>
          <button className="btn gray big" style={{ flex: 1 }} onClick={() => onDone(false)}>
            先看看
          </button>
        </div>
      </div>
    </div>
  );
}
