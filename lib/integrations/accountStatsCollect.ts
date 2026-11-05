// Daily followers of every account on the ผู้ติดตาม board (lib/dashboard/socialAccounts.ts):
// Metricool's account timeline for connected networks, the YouTube Data API for a channel
// id, and the admin's typed number for the rest. Each account's series is kept in
// accountStats/{id}; the first run fetches as far back as Metricool keeps (2025-01-01).
// A problem with one account is noted on it and never fails the sync.
//
// Relative imports only: the sync runs this file directly with Node.
import { decodeFields, encodeFields, type Firestore } from "./firestoreRest.ts";
import { METRICOOL_FOLLOWERS, mergeSeries, readAccounts, type AccountStat, type SocialAccount } from "../dashboard/socialAccounts.ts";

export const HISTORY_FROM = "2025-01-01";

export interface Timeline {
  (blogId: number, network: string, metric: string, from: string, to: string): Promise<[string, number][]>;
}

/** Metricool v2/analytics/timelines → [day, value] (its days are noon CET; the date part is the day). */
export function metricoolTimeline(userId: string, token: string, fetcher: typeof fetch = fetch): Timeline {
  return async (blogId, network, metric, from, to) => {
    const u = new URL("https://app.metricool.com/api/v2/analytics/timelines");
    const params = { userId, blogId: String(blogId), from: `${from}T00:00:00`, to: `${to}T23:59:59`, timezone: "Asia/Bangkok", network, metric, subject: "account" };
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    const res = await fetcher(u, { headers: { "X-Mc-Auth": token, Accept: "application/json" }, signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`Metricool ${res.status}`);
    const body = (await res.json()) as { data?: { values?: { dateTime?: string; value?: number }[] }[] };
    return (body.data?.[0]?.values || []).filter((v) => v.dateTime && Number.isFinite(v.value)).map((v) => [String(v.dateTime).slice(0, 10), Number(v.value)]);
  };
}

/** Subscriber counts of YouTube channels (public, rounded by YouTube), one request for all. */
export async function youtubeSubscribers(apiKey: string, ids: string[], fetcher: typeof fetch = fetch): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (let i = 0; i < ids.length; i += 50) {
    const u = `https://www.googleapis.com/youtube/v3/channels?part=statistics&id=${ids.slice(i, i + 50).join(",")}&key=${apiKey}`;
    const res = await fetcher(u, { signal: AbortSignal.timeout(60_000) });
    // The key is in the URL: report the status only.
    if (!res.ok) throw new Error(`YouTube Data API ${res.status}`);
    const body = (await res.json()) as { items?: { id: string; statistics?: { subscriberCount?: string; hiddenSubscriberCount?: boolean } }[] };
    for (const it of body.items || []) if (!it.statistics?.hiddenSubscriberCount) out.set(it.id, Number(it.statistics?.subscriberCount || 0));
  }
  return out;
}

export interface AccountStatsResult {
  accounts: number;
  updated: number;
  problems: string[];
}

/**
 * Read the list, fetch what is new for each account, write each account's series. `today`
 * is the Bangkok day. A Metricool account re-reads its last 7 days (late numbers settle).
 */
export async function collectAccountStats(
  db: Firestore,
  today: string,
  opts: { timeline?: Timeline; youtubeKey?: string; fetcher?: typeof fetch },
): Promise<AccountStatsResult> {
  const cfg = await db.get("socialAccounts/config");
  const accounts = readAccounts(cfg ? decodeFields(cfg.fields || {}) : null);
  const result: AccountStatsResult = { accounts: accounts.length, updated: 0, problems: [] };
  if (!accounts.length) return result;
  const existing = new Map<string, AccountStat>();
  for (const d of await db.listRaw("accountStats")) {
    const x = decodeFields(d.fields || {}) as unknown as AccountStat;
    existing.set(String(d.name).split("/").pop()!, { series: (x.series || {}) as Record<string, number> });
  }
  const channels = accounts.filter((a) => a.source === "youtube" && a.channelId).map((a) => a.channelId!);
  let subs = new Map<string, number>();
  let ytError = "";
  if (channels.length) {
    if (!opts.youtubeKey) ytError = "ยังไม่ได้ตั้ง YOUTUBE_API_KEY";
    else subs = await youtubeSubscribers(opts.youtubeKey, channels, opts.fetcher).catch((e) => ((ytError = String(e.message || e)), new Map()));
  }
  const weekAgo = new Date(Date.parse(`${today}T00:00:00Z`) - 7 * 86400000).toISOString().slice(0, 10);

  for (const a of accounts) {
    const before = existing.get(a.id)?.series || {};
    let add: [string, number][] = [];
    let error = "";
    try {
      if (a.source === "metricool") {
        const metric = METRICOOL_FOLLOWERS[a.platform];
        if (!a.blogId || !metric) throw new Error("ไม่มี Metricool brand หรือแพลตฟอร์มนี้ไม่มีผู้ติดตามใน Metricool");
        if (!opts.timeline) throw new Error("ยังไม่ได้ตั้ง METRICOOL_USER_ID / METRICOOL_API_TOKEN");
        const known = Object.keys(before).sort();
        const from = known.length ? (known[known.length - 1] < weekAgo ? known[known.length - 1] : weekAgo) : HISTORY_FROM;
        add = await opts.timeline(a.blogId, a.platform, metric, from, today);
        if (!add.length && !known.length) throw new Error("Metricool ไม่มีข้อมูล (เพจนี้อาจไม่ได้เชื่อม " + a.platform + " ใน Metricool)");
      } else if (a.source === "youtube") {
        if (ytError) throw new Error(ytError);
        const v = subs.get(a.channelId || "");
        if (v === undefined) throw new Error("ไม่พบช่อง หรือช่องซ่อนจำนวนผู้ติดตาม");
        add = [[today, v]];
      } else if (a.manualValue !== undefined && a.manualDate) {
        add = [[a.manualDate, a.manualValue]];
      }
    } catch (e) {
      error = String((e as Error).message || e).slice(0, 160);
      result.problems.push(`${a.name} (${a.platform}): ${error}`);
    }
    const stat = mergeSeries(before, add);
    await db.set(
      `accountStats/${a.id}`,
      encodeFields({ ...stat, ...(error ? { error } : {}), updatedAt: new Date().toISOString() } as unknown as Record<string, unknown>),
    );
    result.updated++;
  }
  return result;
}

export type { SocialAccount };
