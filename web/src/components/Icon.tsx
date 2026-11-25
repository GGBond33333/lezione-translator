// 内联 SVG 图标（线条风格，颜色跟随 currentColor），不依赖外部图标库

const PATHS = {
  mic: "M12 15a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v6a3 3 0 0 0 3 3Zm-6-3a6 6 0 0 0 12 0M12 18v3m-3.5 0h7",
  micFill: "M12 15a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v6a3 3 0 0 0 3 3Z",
  chat: "M21 12c0 4.4-4 8-9 8a10 10 0 0 1-3.4-.6L4 20.5l1.2-3.7A7.5 7.5 0 0 1 3 12c0-4.4 4-8 9-8s9 3.6 9 8Z",
  clock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-13.5V12l3 2",
  gear: "M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm7.4-2.1.1-1.4-.1-1.4 2-1.6-2-3.4-2.4 1a7.7 7.7 0 0 0-2.4-1.4L14.2 2h-4l-.4 2.6a7.7 7.7 0 0 0-2.4 1.4l-2.4-1-2 3.4 2 1.6L5 12l.1 1.4-2 1.6 2 3.4 2.4-1a7.7 7.7 0 0 0 2.4 1.4l.4 2.6h4l.4-2.6a7.7 7.7 0 0 0 2.4-1.4l2.4 1 2-3.4-2.1-1.6Z",
  chevron: "m9 5 7 7-7 7",
  back: "m15 5-7 7 7 7",
  check: "m5 12.5 4.5 4.5L19 7",
  pause: "M8 5v14m8-14v14",
  play: "M7 4.5v15L19.5 12 7 4.5Z",
  stop: "M6.5 6.5h11v11h-11z",
  moon: "M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z",
  plus: "M12 5v14M5 12h14",
  share: "M12 3v12m0-12-4 4m4-4 4 4M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6",
  sparkle: "M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3Zm6.5 11 .8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8.8-2.2Z",
  trash: "M4 7h16M10 11v6m4-6v6M6 7l1 13h10l1-13M9 7V4h6v3",
} as const;

export type IconName = keyof typeof PATHS;

/** filled：选中状态用实心（Tab 栏），其余用线条 */
export function Icon({ name, filled = false, size }: { name: IconName; filled?: boolean; size?: number }) {
  const fill = filled && name !== "chevron" && name !== "back" && name !== "check" && name !== "pause";
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill={fill ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth={fill ? 1.2 : 1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={PATHS[name]} />
      {name === "mic" && filled && <path d={PATHS.micFill} fill="currentColor" />}
    </svg>
  );
}

/** 跳动的三个小点：翻译中 / 识别中 */
export function Dots() {
  return (
    <span className="dots" aria-hidden="true">
      <i />
      <i />
      <i />
    </span>
  );
}

export function Empty({ emoji, title, desc }: { emoji: string; title: string; desc?: string }) {
  return (
    <div className="empty">
      <div className="emoji">{emoji}</div>
      <div className="title">{title}</div>
      {desc && <div className="desc">{desc}</div>}
    </div>
  );
}
