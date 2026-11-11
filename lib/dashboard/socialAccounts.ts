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
  /** Each source's newest reading; `chosen` is the one the board shows. */
  sources?: Partial<Record<FollowerSource, { date: string; value: number }>>;
  chosen?: FollowerSource;
  /** Why the sources disagree, for a person to check (e.g. "Metricool 2,869 ต่างจาก API 113,000"). */
  check?: string;
  /** The account the history belongs to (accountKey); a row turned into another account starts again. */
  account?: string;
  error?: string;
  updatedAt?: string;
}

export type FollowerSource = "api" | "metricool" | "manual";

export interface Reading {
  date: string;
  value: number;
}

const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);

/**
 * Which reading the board shows. The platform's own API first; Metricool when the API gave
 * nothing, gave 0, fell more than 20% below the last shown number, or is 2+ days older
 * than Metricool. When both are recent and differ by more than 2%, say so.
 */
export function chooseFollowers(api: Reading | undefined, metricool: Reading | undefined, previous: number | undefined): { chosen?: FollowerSource; reading?: Reading; check?: string } {
  const sane = (r?: Reading) => !!r && r.value > 0 && !(previous && r.value < previous * 0.8);
  let chosen: FollowerSource | undefined;
  if (sane(api) && !(metricool && sane(metricool) && daysBetween(api!.date, metricool.date) >= 2)) chosen = "api";
  else if (sane(metricool)) chosen = "metricool";
  else if (api && api.value > 0) chosen = "api";
  else if (metricool && metricool.value > 0) chosen = "metricool";
  const reading = chosen === "api" ? api : chosen === "metricool" ? metricool : undefined;
  let check: string | undefined;
  if (api && metricool && api.value > 0 && Math.abs(daysBetween(api.date, metricool.date)) <= 2) {
    const diff = Math.abs(metricool.value - api.value) / api.value;
    if (diff > 0.02) check = `Metricool ${metricool.value.toLocaleString("en-US")} ต่างจาก API ${api.value.toLocaleString("en-US")} (${Math.round(diff * 100)}%)`;
  }
  return { chosen, reading, check };
}

/** Drop recent points far from a trusted reading (a source that went wrong for a few days). */
export function dropOutliers(series: Record<string, number>, trusted: Reading, days = 30, tolerance = 0.2): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [d, v] of Object.entries(series)) {
    const recent = daysBetween(d, trusted.date) <= days && daysBetween(d, trusted.date) >= 0;
    if (recent && Math.abs(v - trusted.value) / trusted.value > tolerance) continue;
    out[d] = v;
  }
  return out;
}

/** Metricool's account metric per network (v2/analytics/timelines, subject=account; X is "twitter" there). */
export const METRICOOL_FOLLOWERS: Partial<Record<SocialPlatform, string>> = {
  facebook: "pageFollows",
  instagram: "followers",
  tiktok: "followers_count",
  youtube: "totalSubscribers",
  x: "followers",
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

/**
 * Public ids of each Metricool brand's accounts (from Metricool's brand list; page ids and
 * handles are public). They give every Metricool account its link and its brand's logo.
 */
export const BRAND_PAGES: Record<number, { facebook?: string; instagram?: string; tiktok?: string; youtube?: string; x?: string }> = {
  6487104: { facebook: "330339053719456", instagram: "terodigital_official", tiktok: "terodigital", youtube: "UCq2_AaNWBd0kxzR1HL2yhsw" },
  6499952: { facebook: "1781278698822805", instagram: "thok.mai.thiang", tiktok: "thokmaithiang_official", youtube: "UCLZd__C13KacoUKip4I5cJw" },
  6499961: { facebook: "125506360642301" },
  6499969: { facebook: "510477698991751" },
  6499994: { facebook: "208795545878718", tiktok: "kidsfunth", youtube: "UCrMym6dFPiXrRfzTvgs5WnQ" },
  6500109: { facebook: "977114682345581" },
  6500128: { facebook: "96473393997", instagram: "hitz.th", tiktok: "hitzthailand", youtube: "UCNcZ9a94asv8TOP435PaCiA" },
  7916751: { facebook: "1277806728756997", instagram: "offscript.offrecord", tiktok: "offscript.offrecord", youtube: "UCz-Lx4K3bFPeQzc8GT3tvuw", x: "offscriptoffrec" },
};

/** The brand's name in masterData's Channel column (config/metricool-brands.json labels), for its posts. */
export const BRAND_CHANNEL: Record<number, string> = {
  6487104: "TERO Digital",
  6499952: "ถกไม่เถียง",
  6499961: "เงินทองของจริง",
  6499969: "TERO News",
  6499994: "Kids Fun คิดฝัน",
  6500128: "HITZ Thailand",
  7916751: "Off Script Off Record",
};

/** masterData Program → the board's รายการ group, where the names differ. */
export const PROGRAM_GROUP: Record<string, string> = { Hitzradio: "HITZ Thailand", Kidsfun: "Kids Fun คิดฝัน" };

export interface PostTotals {
  posts: number;
  views: number;
  likes: number;
  comments: number;
  shares: number;
  /** (likes + comments + shares) ÷ views, 0–1; null without views. */
  er: number | null;
}

type PostRow = { platform: string; channel: string; date: string; views: number; likes: number; comments: number; shares: number };
const POST_PLATFORM: Partial<Record<SocialPlatform, string>> = { facebook: "Facebook", instagram: "Instagram", tiktok: "TikTok", youtube: "YouTube" };

/** The account's posts from `from` to `to` in masterData (its brand's Channel on its platform); null when its posts are not synced. */
export function accountPosts(a: SocialAccount, rows: PostRow[], from: string, to: string): PostTotals | null {
  const channel = a.blogId ? BRAND_CHANNEL[a.blogId] : undefined;
  const platform = POST_PLATFORM[a.platform];
  if (!channel || !platform) return null;
  const t = { posts: 0, views: 0, likes: 0, comments: 0, shares: 0 };
  for (const r of rows) {
    if (r.platform !== platform || r.channel !== channel || r.date < from || r.date > to) continue;
    t.posts++;
    t.views += r.views || 0;
    t.likes += r.likes || 0;
    t.comments += r.comments || 0;
    t.shares += r.shares || 0;
  }
  return { ...t, er: t.views ? (t.likes + t.comments + t.shares) / t.views : null };
}

export interface YearRow extends PostTotals {
  year: number;
  /** Months of that year that have posts (a year the system started part-way is short). */
  months: number;
  /** Followers on the year's last day (or the latest day of the running year). */
  followersEnd: number | null;
}

/** Calendar years, newest first: the account's post totals and its followers at the year's end. */
export function accountYears(a: SocialAccount, rows: PostRow[], stat: AccountStat | undefined, today: string): YearRow[] {
  const channel = a.blogId ? BRAND_CHANNEL[a.blogId] : undefined;
  const platform = POST_PLATFORM[a.platform];
  const mine = channel && platform ? rows.filter((r) => r.platform === platform && r.channel === channel) : [];
  const years = new Set<number>(mine.map((r) => Number(r.date.slice(0, 4))));
  for (const d of Object.keys(stat?.series || {})) years.add(Number(d.slice(0, 4)));
  return [...years]
    .filter((y) => y > 2000)
    .sort((x, y) => y - x)
    .map((y) => {
      const end = `${y}-12-31` < today ? `${y}-12-31` : today;
      const t = accountPosts(a, mine, `${y}-01-01`, end) || { posts: 0, views: 0, likes: 0, comments: 0, shares: 0, er: null };
      const months = new Set(mine.filter((r) => r.date.startsWith(`${y}-`)).map((r) => r.date.slice(0, 7))).size;
      return { year: y, ...t, months, followersEnd: followersOn(stat, end) };
    });
}

const PAGE_URL: Partial<Record<SocialPlatform, (id: string) => string>> = {
  facebook: (id) => `https://www.facebook.com/${id}`,
  instagram: (id) => `https://www.instagram.com/${id}`,
  tiktok: (id) => `https://www.tiktok.com/@${id}`,
  youtube: (id) => `https://www.youtube.com/channel/${id}`,
  x: (id) => `https://x.com/${id}`,
};

/** The link to open: the admin's, else the starting list's, else the brand's page on that platform, else a channel id's page. */
export function accountUrl(a: SocialAccount): string {
  if (a.url) return a.url;
  const seed = SEED_ACCOUNTS.find((x) => x.id === a.id)?.url;
  if (seed) return seed;
  const page = a.blogId ? BRAND_PAGES[a.blogId]?.[a.platform as keyof (typeof BRAND_PAGES)[number]] : undefined;
  if (page && PAGE_URL[a.platform]) return PAGE_URL[a.platform]!(page);
  return a.channelId ? `https://www.youtube.com/channel/${a.channelId}` : "";
}

/**
 * The logo: the uploaded one, else the Facebook profile picture of the account's brand page
 * (public, no sign-in), else of a Facebook page the account links to.
 */
export function accountLogo(a: SocialAccount): string {
  if (a.logo) return a.logo;
  const page = (a.blogId && BRAND_PAGES[a.blogId]?.facebook) || (a.url || "").match(/^https:\/\/(?:www\.|m\.)?facebook\.com\/(?:profile\.php\?id=)?([\w.-]+)/i)?.[1];
  return page ? `https://graph.facebook.com/${page}/picture?width=200&height=200` : "";
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
  { id: "offscript-tiktok", name: "Off Script Off Record", group: "Off Script Off Record", platform: "tiktok", source: "metricool", blogId: 7916751, enabled: false },
  { id: "offscript-fb", name: "Off Script Off Record", group: "Off Script Off Record", platform: "facebook", source: "metricool", blogId: 7916751, enabled: false },
  { id: "offscript-ig", name: "Off Script Off Record", group: "Off Script Off Record", platform: "instagram", source: "metricool", blogId: 7916751, enabled: false },
  { id: "offscript-yt", name: "Off Script Off Record", group: "Off Script Off Record", platform: "youtube", source: "metricool", blogId: 7916751, enabled: false },
  { id: "offscript-x", name: "Off Script Off Record", group: "Off Script Off Record", platform: "x", source: "metricool", blogId: 7916751, enabled: false },
];
