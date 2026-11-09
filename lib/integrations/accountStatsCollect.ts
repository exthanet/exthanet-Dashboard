// Daily followers of every account on the ผู้ติดตาม board (lib/dashboard/socialAccounts.ts):
// Metricool's account timeline for connected networks, the YouTube Data API for a channel
// id, and the admin's typed number for the rest. Each account's series is kept in
// accountStats/{id}; the first run fetches as far back as Metricool keeps (2025-01-01).
// A problem with one account is noted on it and never fails the sync.
//
// Relative imports only: the sync runs this file directly with Node.
import { decodeFields, encodeFields, type Firestore } from "./firestoreRest.ts";
import { BRAND_PAGES, METRICOOL_FOLLOWERS, chooseFollowers, dropOutliers, mergeSeries, readAccounts, type AccountStat, type Reading, type SocialAccount } from "../dashboard/socialAccounts.ts";

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
    existing.set(String(d.name).split("/").pop()!, { series: (x.series || {}) as Record<string, number>, ...(x.latest ? { latest: x.latest } : {}) });
  }
  // The platform's own API, where there is one: YouTube subscribers for every YouTube account
  // with a channel id (its own, or its Metricool brand's).
  const channelOf = (a: SocialAccount) => (a.platform === "youtube" ? a.channelId || (a.blogId ? BRAND_PAGES[a.blogId]?.youtube : undefined) : undefined);
  const channels = [...new Set(accounts.map(channelOf).filter((c): c is string => !!c))];
  let subs = new Map<string, number>();
  let ytError = "";
  if (channels.length) {
    if (!opts.youtubeKey) ytError = "ยังไม่ได้ตั้ง YOUTUBE_API_KEY";
    else subs = await youtubeSubscribers(opts.youtubeKey, channels, opts.fetcher).catch((e) => ((ytError = String(e.message || e)), new Map()));
  }
  const weekAgo = new Date(Date.parse(`${today}T00:00:00Z`) - 7 * 86400000).toISOString().slice(0, 10);

  for (const a of accounts) {
    const prev = existing.get(a.id);
    let series = prev?.series || {};
    const errors: string[] = [];
    let mcAdd: [string, number][] = [];
    let api: Reading | undefined;
    if (a.source === "manual") {
      if (a.manualValue !== undefined && a.manualDate) series = mergeSeries(series, [[a.manualDate, a.manualValue]]).series;
    } else {
      const channel = channelOf(a);
      if (channel) {
        if (ytError) errors.push(`YouTube API: ${ytError}`);
        else if (subs.has(channel)) api = { date: today, value: subs.get(channel)! };
        else errors.push("YouTube API: ไม่พบช่อง หรือช่องซ่อนจำนวนผู้ติดตาม");
      }
      const metric = METRICOOL_FOLLOWERS[a.platform];
      if (a.blogId && metric) {
        if (!opts.timeline) errors.push("ยังไม่ได้ตั้ง METRICOOL_USER_ID / METRICOOL_API_TOKEN");
        else {
          const known = Object.keys(series).sort();
          const from = known.length ? (known[known.length - 1] < weekAgo ? known[known.length - 1] : weekAgo) : HISTORY_FROM;
          try {
            mcAdd = await opts.timeline(a.blogId, a.platform === "x" ? "twitter" : a.platform, metric, from, today);
            if (!mcAdd.length && !known.length && !api) errors.push(`Metricool ไม่มีข้อมูล (เพจนี้อาจไม่ได้เชื่อม ${a.platform} ใน Metricool)`);
          } catch (e) {
            errors.push(`Metricool: ${String((e as Error).message || e).slice(0, 120)}`);
          }
        }
      } else if (a.source === "metricool") errors.push("ไม่มี Metricool brand หรือแพลตฟอร์มนี้ไม่มีผู้ติดตามใน Metricool");
    }
    const mcLast = [...mcAdd].sort((x, y) => x[0].localeCompare(y[0])).pop();
    const metricool: Reading | undefined = mcLast ? { date: mcLast[0], value: mcLast[1] } : undefined;
    const pick = a.source === "manual" ? { chosen: "manual" as const } : chooseFollowers(api, metricool, prev?.latest?.value);
    // History from Metricool; the chosen reading wins its day, and when the API is chosen,
    // recent Metricool points far from it (Metricool gone wrong) are left out.
    series = mergeSeries(series, mcAdd).series;
    if (pick.chosen === "api" && api) series = mergeSeries(dropOutliers(series, api), [[api.date, api.value]]).series;
    const stat: AccountStat = {
      ...mergeSeries(series, []),
      sources: { ...(api ? { api } : {}), ...(metricool ? { metricool } : {}) },
      ...(pick.chosen ? { chosen: pick.chosen } : {}),
      ...("check" in pick && pick.check ? { check: pick.check } : {}),
    };
    // Errors only matter when nothing gave a number.
    const error = !stat.latest || (!api && !metricool && a.source !== "manual") ? errors.join(" · ") : "";
    if (error) result.problems.push(`${a.name} (${a.platform}): ${error}`);
    if (stat.check) result.problems.push(`${a.name} (${a.platform}): ${stat.check}`);
    await db.set(`accountStats/${a.id}`, encodeFields({ ...stat, ...(error ? { error } : {}), updatedAt: new Date().toISOString() } as unknown as Record<string, unknown>));
    result.updated++;
  }
  return result;
}

export type { SocialAccount };

// ---------- audience (กลุ่มผู้ชม) ----------

export interface AudienceStat {
  platform: string;
  /** Percent of viewers / followers. */
  gender: Record<string, number>;
  age: Record<string, number>;
  from: string;
  to: string;
  source: string;
}

export interface Distribution {
  (blogId: number, network: string, metric: string, from: string, to: string): Promise<{ key: string; value: number }[]>;
}

/** Metricool v2/analytics/distribution (Instagram followers by gender / age). */
export function metricoolDistribution(userId: string, token: string, fetcher: typeof fetch = fetch): Distribution {
  return async (blogId, network, metric, from, to) => {
    const u = new URL("https://app.metricool.com/api/v2/analytics/distribution");
    const params = { userId, blogId: String(blogId), from: `${from}T00:00:00`, to: `${to}T23:59:59`, timezone: "Asia/Bangkok", network, metric, subject: "account" };
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    const res = await fetcher(u, { headers: { "X-Mc-Auth": token, Accept: "application/json" }, signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`Metricool ${res.status}`);
    const body = (await res.json()) as { data?: { key?: string; value?: number }[] };
    return (body.data || []).filter((d) => d.key && Number.isFinite(d.value)).map((d) => ({ key: String(d.key), value: Number(d.value) }));
  };
}

const GENDER: Record<string, string> = { M: "male", F: "female", U: "other", male: "male", female: "female", genderUserSpecified: "other" };

/**
 * Who follows / watches each account, for the Media Kit: YouTube viewers by age and gender
 * over 90 days through the CMS (the platform's own numbers), Instagram followers through
 * Metricool. Facebook gives none (Meta closed it) and TikTok only for Business accounts.
 * One document per account in audienceStats/{id}; a failure is noted, never fatal.
 */
export async function collectAudience(
  db: Firestore,
  today: string,
  opts: { distribution?: Distribution; youtube?: (channelId: string, from: string, to: string) => Promise<(string | number)[][]> },
): Promise<{ written: number; problems: string[] }> {
  const cfg = await db.get("socialAccounts/config");
  const accounts = readAccounts(cfg ? decodeFields(cfg.fields || {}) : null);
  const from = new Date(Date.parse(`${today}T00:00:00Z`) - 90 * 86400000).toISOString().slice(0, 10);
  const out = { written: 0, problems: [] as string[] };
  for (const a of accounts) {
    try {
      let stat: AudienceStat | null = null;
      if (a.platform === "youtube" && opts.youtube) {
        const channel = a.channelId || (a.blogId ? BRAND_PAGES[a.blogId]?.youtube : undefined);
        if (!channel) continue;
        const rows = await opts.youtube(channel, from, today);
        if (!rows.length) continue;
        const gender: Record<string, number> = {};
        const age: Record<string, number> = {};
        for (const [ageGroup, g, pct] of rows) {
          const gk = GENDER[String(g)] || "other";
          const ak = String(ageGroup).replace(/^age/, "").replace(/-$/, "+");
          gender[gk] = (gender[gk] || 0) + Number(pct);
          age[ak] = (age[ak] || 0) + Number(pct);
        }
        stat = { platform: "youtube", gender, age, from, to: today, source: "YouTube Analytics (CMS)" };
      } else if (a.platform === "instagram" && a.blogId && opts.distribution) {
        const [g, ag] = await Promise.all([opts.distribution(a.blogId, "instagram", "gender", from, today), opts.distribution(a.blogId, "instagram", "age", from, today)]);
        if (!g.length && !ag.length) continue;
        stat = {
          platform: "instagram",
          gender: Object.fromEntries(g.map((d) => [GENDER[d.key] || "other", d.value])),
          age: Object.fromEntries(ag.map((d) => [d.key, d.value])),
          from,
          to: today,
          source: "Metricool (Instagram)",
        };
      }
      if (!stat) continue;
      await db.set(`audienceStats/${a.id}`, encodeFields({ ...stat, updatedAt: new Date().toISOString() } as unknown as Record<string, unknown>));
      out.written++;
    } catch (e) {
      out.problems.push(`${a.name} (${a.platform}): ${String((e as Error).message || e).slice(0, 120)}`);
    }
  }
  return out;
}
