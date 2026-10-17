# 意中课堂翻译（网页版 PWA）

给在意大利留学的同学用的语音翻译工具，在 iPhone 的 Safari 里就能用，不需要 Mac，也不需要上架 App Store。

- **课堂转写**：老师讲意大利语，屏幕上实时显示原文和中文译文；支持 2–3 小时的长课
- **双语对话**：手机放在两人中间，上半屏给意大利人看（倒置），下半屏给自己看，按住按钮说话，译文自动朗读
- **课后精修**：下课后一键用 Sonnet 重新翻译全文，并生成课堂笔记（要点、时间线、人名/作品/术语表）
- **离线备用**：下载约 300MB 的离线模型后，没网也能识别和翻译（质量一般）

## 费用

联网翻译调用的是 **Claude API**，**不占用 Claude.ai 订阅（Pro/Max）的额度**。需要在 [console.anthropic.com](https://console.anthropic.com) 单独充值、创建 API Key，按实际用量扣费。

| 模型 | 优势 | 实时翻译 / 小时 | 3 小时课实时 | 3 小时课课后精修 |
|---|---|---|---|---|
| 离线模型 | 免费、没网也能用；翻译生硬 | 0 | 0 | 不提供 |
| Claude Haiku 5.5（实时推荐） | 最快、最便宜，看懂大意足够 | 约 $0.05 | 约 $0.15 | 约 $0.04 |
| Claude Sonnet 5.5（精修推荐） | 术语、人名更准，中文更通顺 | 约 $0.8 | 约 $2.4 | 约 $0.8 |
| Claude Opus 5.5 | 质量最高，最擅长复杂学术论述 | 约 $2 | 约 $6 | 约 $1.6 |

默认组合（实时 Haiku + 课后 Sonnet）一节 3 小时的课约 **1 美元**。实际花费会显示在每节课上，也可以在设置里设单节课费用上限。

价格写在 [web/src/core/models-catalog.ts](web/src/core/models-catalog.ts)，价格变动时只改这个文件。

## 在 iPhone 上使用

1. 用 Safari 打开部署好的网址（见下方"部署"）
2. 点底部的"分享"→"添加到主屏幕"，之后从主屏幕图标打开
3. 在"设置"里填 API Key；可选下载离线模型（用 Wi-Fi）
4. 第一次开始识别时允许麦克风和语音识别

长课提示：保持屏幕亮着（可以用"省电黑屏"），iOS 锁屏后网页无法继续录音；3 小时大约耗电 30–40%，建议带充电宝。页面崩溃或刷新后，打开"课堂转写"可以继续上次的课。

## 部署（免费，GitHub Pages）

麦克风只能在 HTTPS 下使用，所以需要部署到网上：

1. 在 GitHub 新建一个仓库，把这个项目推上去
2. 仓库 Settings → Pages → Source 选 **GitHub Actions**
3. 推送后 [.github/workflows/deploy.yml](.github/workflows/deploy.yml) 会自动测试、构建并部署，网址是 `https://<你的用户名>.github.io/<仓库名>/`

## 本地开发

```bash
cd web
npm install
npm run dev      # 开发服务器
npm test         # 单元测试
npm run build    # 生产构建，输出到 web/dist
```

## 技术说明

| 环节 | 联网 | 离线 |
|---|---|---|
| 语音识别 | Safari 自带的 Web Speech API（it-IT / zh-CN），断开后自动重连 | Whisper base（Transformers.js，WebGPU / WASM） |
| 翻译 | Claude API（每 2–3 句合并一个请求，带课程术语表） | Opus-MT，经英语中转（it→en→zh） |
| 朗读 | 系统 speechSynthesis | 同左 |
| 存储 | IndexedDB（课程、上课记录、每分钟一段的录音备份），只存在本机 | 同左 |

代码结构：

- `web/src/core/`：识别、翻译、引擎选择（[router.ts](web/src/core/router.ts)）、翻译队列（[translationQueue.ts](web/src/core/translationQueue.ts)）、课后精修（[refine.ts](web/src/core/refine.ts)）
- `web/src/features/`：课堂转写、双语对话、历史、设置四个页面
- `web/src/workers/ml.worker.ts`：离线模型推理
- `web/src/storage/db.ts`：本机数据库

API Key 只保存在手机浏览器的本地存储里，翻译请求直接从手机发到 Anthropic，没有经过其他服务器。
