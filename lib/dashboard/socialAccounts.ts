// ผู้ติดตาม: the company's social accounts and their follower counts, shown as one board
// (as the sales deck shows it). Admins keep the list in Firestore socialAccounts/config
// (name, platform, logo, where the number comes from); the daily sync stores each account's
// daily followers in accountStats/{id}. Accounts with no API (LINE OA, X, pages outside
// Metricool) carry a number typed by an admin, with its date.
//
// Relative imports only: the sync runs this file directly with Node.

export const SOCIAL_PLATFORMS = ["facebook", "instagram", "tiktok", "youtube", "x", "line", "other"] as const;
export type SocialPlatform = (typeof SOCIAL_PLATFORMS)[number];
export type SocialSource = "metricool" | "youtube" | "manual";

export const PLATFORM_LABEL: Record<SocialPlatform, string> = {
  facebook: "Facebook",
  instagram: "Instagram",
  tiktok: "TikTok",
  youtube: "YouTube",
  x: "X",
  line: "LINE",
  other: "อื่นๆ",
};

export interface SocialAccount {
  id: string;
  name: string;
  /** The show / brand the account belongs to (the board groups by it); the name when blank. */
  group?: string;
  platform: SocialPlatform;
  source: SocialSource;
  /** Metricool brand id (source "metricool"). */
  blogId?: number;
  /** YouTube channel id (source "youtube"). */
  channelId?: string;
  /** Typed by an admin (source "manual"), with the day it was read. */
  manualValue?: number;
  manualDate?: string;
  /** The account's page on its platform (https://…), opened from the board. */
  url?: string;
  /** Small image as a data URL (resized in the browser). */
  logo?: string;
  /** Counted in the total and shown on the board. */
  enabled: boolean;
}

export interface AccountStat {
  /** Daily followers, "YYYY-MM-DD" → count. */
  series: Record<string, number>;
  latest?: { date: string; value: number };
  error?: string;
  updatedAt?: string;
}

/** Metricool's account metric per network (v2/analytics/timelines, subject=account). */
export const METRICOOL_FOLLOWERS: Partial<Record<SocialPlatform, string>> = {
  facebook: "pageFollows",
  instagram: "followers",
  tiktok: "followers_count",
  youtube: "totalSubscribers",
};

const isDay = (v: unknown) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);

/** Firestore → accounts, tolerating missing or odd fields. */
export function readAccounts(data: unknown): SocialAccount[] {
  const list = (data as { accounts?: unknown })?.accounts;
  return (Array.isArray(list) ? list : [])
    .map((a: Record<string, unknown>) => {
      const platform = (SOCIAL_PLATFORMS as readonly string[]).includes(String(a.platform)) ? (a.platform as SocialPlatform) : "other";
      const source: SocialSource = a.source === "metricool" || a.source === "youtube" ? a.source : "manual";
      const out: SocialAccount = { id: String(a.id ?? ""), name: String(a.name ?? "").trim(), platform, source, enabled: a.enabled !== false };
      if (String(a.group ?? "").trim()) out.group = String(a.group).trim();
      if (Number(a.blogId) > 0) out.blogId = Number(a.blogId);
      if (a.channelId) out.channelId = String(a.channelId).trim();
      if (Number.isFinite(Number(a.manualValue)) && a.manualValue !== "" && a.manualValue !== null && a.manualValue !== undefined) out.manualValue = Number(a.manualValue);
      if (isDay(a.manualDate)) out.manualDate = String(a.manualDate);
      if (typeof a.url === "string" && /^https:\/\/\S+$/.test(a.url.trim())) out.url = a.url.trim();
      if (typeof a.logo === "string" && a.logo.startsWith("data:image/")) out.logo = a.logo;
      return out;
    })
    .filter((a) => a.id && a.name);
}

/** What is missing for an account to have a number. */
export function accountProblem(a: SocialAccount): string {
  if (!a.name) return "ใส่ชื่อ";
  if (a.url && !/^https:\/\/\S+$/.test(a.url)) return "ลิงก์ต้องขึ้นต้นด้วย https://";
  if (a.source === "metricool" && !a.blogId) return "ใส่ Metricool brand";
  if (a.source === "metricool" && !METRICOOL_FOLLOWERS[a.platform]) return `Metricool ไม่มีผู้ติดตามของ ${PLATFORM_LABEL[a.platform]}`;
  if (a.source === "youtube" && !/^UC[\w-]{22}$/.test(a.channelId || "")) return "Channel ID ต้องขึ้นต้นด้วย UC (24 ตัวอักษร)";
  if (a.source === "manual" && !(Number(a.manualValue) >= 0 && isDay(a.manualDate))) return "ใส่ตัวเลขและวันที่";
  return "";
}

/** The number on the board: the newest synced day, or the typed one. */
export function currentFollowers(a: SocialAccount, stat?: AccountStat): { value: number; date: string } | null {
  if (a.source === "manual") return a.manualValue !== undefined && a.manualDate ? { value: a.manualValue, date: a.manualDate } : null;
  return stat?.latest ? { ...stat.latest } : null;
}

/** Followers on or before `day` (the last known value), for growth over a period. */
export function followersOn(stat: AccountStat | undefined, day: string): number | null {
  if (!stat) return null;
  let best: [string, number] | null = null;
  for (const [d, v] of Object.entries(stat.series)) if (d <= day && (!best || d > best[0])) best = [d, v];
  return best ? best[1] : null;
}

/** Add days to a series; a newer reading of the same day replaces the old one. */
export function mergeSeries(series: Record<string, number>, add: [string, number][]): AccountStat {
  const out = { ...series };
  for (const [d, v] of add) if (isDay(d) && Number.isFinite(v)) out[d] = v;
  const days = Object.keys(out).sort();
  const last = days[days.length - 1];
  return { series: out, ...(last ? { latest: { date: last, value: out[last] } } : {}) };
}

/** Total of the enabled accounts that have a number. */
export function boardTotal(accounts: SocialAccount[], stats: Record<string, AccountStat>): number {
  return accounts.filter((a) => a.enabled).reduce((sum, a) => sum + (currentFollowers(a, stats[a.id])?.value || 0), 0);
}

export const groupOf = (a: SocialAccount) => a.group || a.name;

/** The link to open: the admin's, else the starting list's for the same account, else a channel id's page. */
export function accountUrl(a: SocialAccount): string {
  if (a.url) return a.url;
  const seed = SEED_ACCOUNTS.find((x) => x.id === a.id)?.url;
  if (seed) return seed;
  return a.channelId ? `https://www.youtube.com/channel/${a.channelId}` : "";
}

/** "16.5M", "850K". */
export function shortCount(v: number): string {
  if (v >= 1e9) return `${(v / 1e9).toFixed(1).replace(/\.0$/, "")}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1).replace(/\.0$/, "")}M`;
  if (v >= 1e3) return `${Math.round(v / 1e3)}K`;
  return String(v);
}

/**
 * The starting list, as the sales deck shows it: every account a Metricool brand or the
 * deck names. Numbers for accounts without an API are the deck's (an admin updates them).
 */
export const SEED_ACCOUNTS: SocialAccount[] = [
  { id: "tero-tiktok", url: "https://www.tiktok.com/@terodigital", name: "terodigital", group: "TERO Digital", platform: "tiktok", source: "metricool", blogId: 6487104, enabled: true },
  { id: "boxoffice-fb", name: "Thailand Box office and Entertainment", group: "Thailand Box Office", platform: "facebook", source: "manual", manualValue: 81000, enabled: true },
  { id: "hitz-fb", name: "HITZ Thailand", group: "HITZ Thailand", platform: "facebook", source: "metricool", blogId: 6500128, enabled: true },
  { id: "tero-yt", url: "https://www.youtube.com/channel/UCq2_AaNWBd0kxzR1HL2yhsw", name: "Tero Digital", group: "TERO Digital", platform: "youtube", source: "metricool", blogId: 6487104, enabled: true },
  { id: "popolay-fb", name: "Popolay Myanmar", group: "Popolay", platform: "facebook", source: "metricool", blogId: 6500109, enabled: true },
  { id: "teroradio-line", name: "TERO Radio", group: "TERO Radio", platform: "line", source: "manual", manualValue: 250310, enabled: true },
  { id: "tero-fb", name: "TERO Digital", group: "TERO Digital", platform: "facebook", source: "metricool", blogId: 6487104, enabled: true },
  { id: "chipao-line", name: "ชี้เป้าเติมโปร", group: "ชี้เป้าเติมโปร", platform: "line", source: "manual", manualValue: 260500, enabled: true },
  { id: "hitz-yt", url: "https://www.youtube.com/channel/UCNcZ9a94asv8TOP435PaCiA", name: "HITZ Thailand", group: "HITZ Thailand", platform: "youtube", source: "metricool", blogId: 6500128, enabled: true },
  { id: "tin-fb", name: "TinDiscussion", group: "ถกไม่เถียง", platform: "facebook", source: "metricool", blogId: 6499952, enabled: true },
  { id: "thaiwave-fb", name: "Thaiwaveclub", group: "Thaiwave", platform: "facebook", source: "manual", manualValue: 7200, enabled: true },
  { id: "hitz-x", name: "HITZ Thailand", group: "HITZ Thailand", platform: "x", source: "manual", manualValue: 47900, enabled: true },
  { id: "ngt-fb", name: "เงินทองของจริง", group: "เงินทองของจริง", platform: "facebook", source: "metricool", blogId: 6499961, enabled: true },
  { id: "letsplay-fb", name: "Let's Play AI", group: "Let's Play AI", platform: "facebook", source: "manual", manualValue: 11000, enabled: true },
  { id: "hitz-tiktok", url: "https://www.tiktok.com/@hitzthailand", name: "hitzthailand", group: "HITZ Thailand", platform: "tiktok", source: "metricool", blogId: 6500128, enabled: true },
  { id: "teronews-fb", name: "TERO News", group: "TERO News", platform: "facebook", source: "metricool", blogId: 6499969, enabled: true },
  { id: "letsplay-yt", name: "Let's Play AI", group: "Let's Play AI", platform: "youtube", source: "manual", manualValue: 9240, enabled: true },
  { id: "hitz-ig", name: "HITZ Thailand", group: "HITZ Thailand", platform: "instagram", source: "metricool", blogId: 6500128, enabled: true },
  // In Metricool but not on the deck: off until an admin turns them on.
  { id: "tin-ig", name: "ถกไม่เถียง", group: "ถกไม่เถียง", platform: "instagram", source: "metricool", blogId: 6499952, enabled: false },
  { id: "tin-tiktok", name: "ถกไม่เถียง", group: "ถกไม่เถียง", platform: "tiktok", source: "metricool", blogId: 6499952, enabled: false },
  { id: "tin-yt", url: "https://www.youtube.com/channel/UCLZd__C13KacoUKip4I5cJw", name: "ถกไม่เถียง กับ ทิน", group: "ถกไม่เถียง", platform: "youtube", source: "metricool", blogId: 6499952, enabled: false },
  { id: "tero-ig", name: "TERO Digital", group: "TERO Digital", platform: "instagram", source: "metricool", blogId: 6487104, enabled: false },
  { id: "kids-fb", name: "Kids Fun คิดฝัน", group: "Kids Fun คิดฝัน", platform: "facebook", source: "metricool", blogId: 6499994, enabled: false },
  { id: "kids-tiktok", name: "Kids Fun คิดฝัน", group: "Kids Fun คิดฝัน", platform: "tiktok", source: "metricool", blogId: 6499994, enabled: false },
  { id: "kids-yt", url: "https://www.youtube.com/channel/UCrMym6dFPiXrRfzTvgs5WnQ", name: "Kids Fun คิดฝัน", group: "Kids Fun คิดฝัน", platform: "youtube", source: "metricool", blogId: 6499994, enabled: false },
];
