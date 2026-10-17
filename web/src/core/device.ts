import { LANGS, type Lang } from "./languages";

// —— 朗读（speechSynthesis，iOS 系统语音，离线也能用）——
let unlocked = false;

/** iOS 要求第一次发声必须在用户点击里触发，按下按钮时调用一次 */
export function unlockSpeech(): void {
  if (unlocked || typeof speechSynthesis === "undefined") return;
  const u = new SpeechSynthesisUtterance(" ");
  u.volume = 0;
  speechSynthesis.speak(u);
  unlocked = true;
}

function pickVoice(locale: string): SpeechSynthesisVoice | undefined {
  const voices = speechSynthesis.getVoices();
  const prefix = locale.slice(0, 2);
  return voices.find((v) => v.lang === locale) ?? voices.find((v) => v.lang.startsWith(prefix));
}

export function speak(text: string, lang: Lang): void {
  if (typeof speechSynthesis === "undefined" || !text) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = LANGS[lang].locale;
  const voice = pickVoice(u.lang);
  if (voice) u.voice = voice;
  u.rate = 0.95;
  speechSynthesis.speak(u);
}

// —— 防止锁屏（Wake Lock）——
let lock: WakeLockSentinel | null = null;
let wanted = false;

export async function keepAwake(on: boolean): Promise<boolean> {
  wanted = on;
  if (!("wakeLock" in navigator)) return false;
  try {
    if (on && !lock) {
      lock = await navigator.wakeLock.request("screen");
      lock.addEventListener("release", () => (lock = null));
    } else if (!on && lock) {
      await lock.release();
      lock = null;
    }
    return true;
  } catch {
    return false;
  }
}

if (typeof document !== "undefined") {
  // 切到后台再回来时系统会释放 Wake Lock，需要重新申请
  document.addEventListener("visibilitychange", () => {
    if (wanted && document.visibilityState === "visible") void keepAwake(true);
  });
}

export function isStandalone(): boolean {
  return (
    window.matchMedia?.("(display-mode: standalone)").matches ||
    (navigator as unknown as { standalone?: boolean }).standalone === true
  );
}

export function isIOS(): boolean {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}
