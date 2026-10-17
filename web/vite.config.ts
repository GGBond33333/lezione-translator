import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

// base 用相对路径，部署到 GitHub Pages 的任意子路径（/<仓库名>/）都能用
export default defineConfig({
  base: "./",
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["icon.svg", "apple-touch-icon.png"],
      manifest: {
        name: "意中课堂翻译",
        short_name: "意中翻译",
        description: "意大利语和中文的语音转文字与双语对话",
        lang: "zh-CN",
        start_url: "./",
        scope: "./",
        display: "standalone",
        orientation: "portrait",
        background_color: "#0f172a",
        theme_color: "#0f172a",
        icons: [
          { src: "icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        // 离线引擎的 wasm 约 21MB，不预缓存；第一次下载离线模型时再缓存
        globPatterns: ["**/*.{js,css,html,svg,png}"],
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
        runtimeCaching: [
          {
            urlPattern: ({ url }: { url: URL }) => url.pathname.endsWith(".wasm"),
            handler: "CacheFirst",
            options: { cacheName: "offline-engine", expiration: { maxEntries: 5 } },
          },
          {
            // onnxruntime 的 wasm 运行时从 CDN 加载，缓存后离线可用
            urlPattern: /^https:\/\/cdn\.jsdelivr\.net\/.*/,
            handler: "CacheFirst",
            options: {
              cacheName: "cdn-runtime",
              expiration: { maxEntries: 30, maxAgeSeconds: 60 * 60 * 24 * 365 },
            },
          },
        ],
      },
    }),
  ],
  worker: { format: "es" },
  optimizeDeps: { exclude: ["@huggingface/transformers"] },
  test: {
    environment: "node",
  },
} as Parameters<typeof defineConfig>[0]);
