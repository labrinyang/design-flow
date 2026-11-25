import type { Locale } from "./i18n.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** "刚刚", "3 分钟前", "昨天", "11月20日"; "just now", "3 minutes ago", "yesterday", "Nov 20". */
export function relativeTime(iso: string, now: number, locale: Locale): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "";
  const zh = locale === "zh";
  const ago = Math.max(0, now - at);
  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  if (ago < MINUTE) return zh ? "刚刚" : "just now";
  if (ago < HOUR) {
    const n = Math.floor(ago / MINUTE);
    return zh ? `${n} 分钟前` : rtf.format(-n, "minute");
  }
  const then = new Date(at);
  const today = new Date(now);
  if (ago < DAY && sameDay(then, today)) {
    const n = Math.floor(ago / HOUR);
    return zh ? `${n} 小时前` : rtf.format(-n, "hour");
  }
  if (sameDay(then, new Date(now - DAY))) return zh ? "昨天" : "yesterday";
  if (ago < 7 * DAY) {
    const n = Math.max(2, Math.round(ago / DAY));
    return zh ? `${n} 天前` : rtf.format(-n, "day");
  }
  const sameYear = then.getFullYear() === today.getFullYear();
  return new Intl.DateTimeFormat(zh ? "zh-CN" : "en", { month: zh ? "long" : "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) }).format(then);
}

/** The full date and time, for a tooltip. */
export function exactTime(iso: string, locale: Locale): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "";
  return new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en", { dateStyle: "medium", timeStyle: "short" }).format(at);
}
