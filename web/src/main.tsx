import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { registerSW } from "virtual:pwa-register";
import { App } from "./App";
import { getSettings } from "./core/settings";
import { purgeOldConversations } from "./storage/db";
import "./styles.css";

registerSW({ immediate: true });

// 请求持久化存储，减少 iOS 清理离线模型和上课记录的概率
void navigator.storage?.persist?.();

// 启动时清理超过保存期限的对话记录
void purgeOldConversations(getSettings().conversationRetentionDays).catch(() => undefined);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
