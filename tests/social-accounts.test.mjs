import test from "node:test";
import assert from "node:assert/strict";
import { SEED_ACCOUNTS, accountProblem, boardTotal, currentFollowers, followersOn, mergeSeries, readAccounts, shortCount } from "../lib/dashboard/socialAccounts.ts";
import { collectAccountStats, metricoolTimeline } from "../lib/integrations/accountStatsCollect.ts";
import { decodeFields, encodeFields } from "../lib/integrations/firestoreRest.ts";

test("accounts from Firestore: odd fields cleaned, unknown platform → other, no id or name dropped", () => {
  const list = readAccounts({ accounts: [
    { id: "a", name: " TERO ", platform: "tiktok", source: "metricool", blogId: "6487104", enabled: true },
    { id: "b", name: "Radio", platform: "line", source: "manual", manualValue: "250310", manualDate: "2026-11-05", logo: "javascript:x" },
    { id: "c", name: "Odd", platform: "myspace" },
    { id: "", name: "no id" },
  ] });
  assert.deepEqual(list, [
    { id: "a", name: "TERO", platform: "tiktok", source: "metricool", enabled: true, blogId: 6487104 },
    { id: "b", name: "Radio", platform: "line", source: "manual", enabled: true, manualValue: 250310, manualDate: "2026-11-05" },
    { id: "c", name: "Odd", platform: "other", source: "manual", enabled: true },
  ]);
  assert.equal(accountProblem(list[2]), "ใส่ตัวเลขและวันที่");
  assert.equal(accountProblem({ ...list[0], blogId: undefined }), "ใส่ Metricool brand");
  assert.match(accountProblem({ id: "l", name: "L", platform: "line", source: "metricool", blogId: 1, enabled: true }), /ไม่มีผู้ติดตาม/);
  assert.match(accountProblem({ id: "y", name: "Y", platform: "youtube", source: "youtube", channelId: "abc", enabled: true }), /UC/);
});

test("numbers on the board: synced latest or typed, growth from the series, total of shown accounts", () => {
  const stat = mergeSeries({ "2026-10-01": 100 }, [["2026-11-04", 160], ["2026-10-05", 110], ["bad", 1]]);
  assert.deepEqual(stat.latest, { date: "2026-11-04", value: 160 });
  assert.equal(followersOn(stat, "2026-10-04"), 100);
  assert.equal(followersOn(stat, "2026-09-01"), null);
  const auto = { id: "a", name: "A", platform: "facebook", source: "metricool", blogId: 1, enabled: true };
  const typed = { id: "b", name: "B", platform: "line", source: "manual", manualValue: 40, manualDate: "2026-11-01", enabled: true };
  const off = { ...typed, id: "c", enabled: false };
  assert.deepEqual(currentFollowers(typed), { value: 40, date: "2026-11-01" });
  assert.equal(boardTotal([auto, typed, off], { a: stat }), 200);
  assert.equal(shortCount(16_512_000), "16.5M");
  assert.equal(shortCount(3_000_000_000), "3B");
  // The starting list has unique ids and every account it turns on is complete once dated.
  assert.equal(new Set(SEED_ACCOUNTS.map((a) => a.id)).size, SEED_ACCOUNTS.length);
  assert.ok(SEED_ACCOUNTS.every((a) => !accountProblem(a.source === "manual" ? { ...a, manualDate: "2026-11-05" } : a)));
});

// A Firestore stand-in holding encoded documents.
function fakeDb(docs) {
  const store = new Map(Object.entries(docs).map(([k, v]) => [k, { name: `x/${k}`, fields: encodeFields(v) }]));
  return {
    store,
    get: async (p) => store.get(p) || null,
    listRaw: async (col) => [...store.entries()].filter(([k]) => k.startsWith(`${col}/`)).map(([, d]) => d),
    set: async (p, fields) => store.set(p, { name: `x/${p}`, fields }),
  };
}

test("the sync: Metricool history on the first run, then the last week; YouTube today; typed numbers; problems noted", async () => {
  const db = fakeDb({
    "socialAccounts/config": { accounts: [
      { id: "fb", name: "TERO", platform: "facebook", source: "metricool", blogId: 1, enabled: true },
      { id: "tt", name: "TERO", platform: "tiktok", source: "metricool", blogId: 1, enabled: true },
      { id: "yt", name: "AI", platform: "youtube", source: "youtube", channelId: "UCaaaaaaaaaaaaaaaaaaaaaa", enabled: true },
      { id: "line", name: "Radio", platform: "line", source: "manual", manualValue: 250310, manualDate: "2026-11-01", enabled: true },
      { id: "x", name: "HITZ", platform: "x", source: "metricool", blogId: 2, enabled: true },
    ] },
    "accountStats/tt": { series: { "2026-10-01": 5 } },
  });
  const asked = [];
  const timeline = async (blog, network, metric, from, to) => {
    asked.push([network, metric, from, to]);
    if (network === "tiktok") throw new Error("Metricool 403");
    if (network === "twitter") return [["2026-11-05", 213]];
    return [["2025-01-02", 10], ["2026-11-04", 20]];
  };
  const fetcher = async () => ({ ok: true, json: async () => ({ items: [{ id: "UCaaaaaaaaaaaaaaaaaaaaaa", statistics: { subscriberCount: "9240" } }] }) });
  const r = await collectAccountStats(db, "2026-11-05", { timeline, youtubeKey: "k", fetcher });
  assert.equal(r.updated, 5);
  // X is "twitter" in Metricool.
  assert.deepEqual(asked, [["facebook", "pageFollows", "2025-01-01", "2026-11-05"], ["tiktok", "followers_count", "2026-10-01", "2026-11-05"], ["twitter", "followers", "2025-01-01", "2026-11-05"]]);
  assert.deepEqual(decodeFields(db.store.get("accountStats/x").fields).latest, { date: "2026-11-05", value: 213 });
  assert.equal(r.problems.length, 1);
  const read = (id) => decodeFields(db.store.get(`accountStats/${id}`).fields);
  assert.deepEqual(read("fb").latest, { date: "2026-11-04", value: 20 });
  assert.deepEqual(read("tt").series, { "2026-10-01": 5 });
  assert.match(read("tt").error, /403/);
  assert.deepEqual(read("yt").latest, { date: "2026-11-05", value: 9240 });
  assert.deepEqual(read("line").latest, { date: "2026-11-01", value: 250310 });
});

test("Metricool timeline: the day of each point, in order of the reply", async () => {
  let url = "";
  const fetcher = async (u) => {
    url = String(u);
    return { ok: true, json: async () => ({ data: [{ values: [{ dateTime: "2026-11-04T12:00:00+0100", value: 1223100 }, { dateTime: "2026-11-03T12:00:00+0100", value: 1222000 }] }] }) };
  };
  const t = metricoolTimeline("u", "secret", fetcher);
  assert.deepEqual(await t(6499952, "facebook", "pageFollows", "2026-11-01", "2026-11-05"), [["2026-11-04", 1223100], ["2026-11-03", 1222000]]);
  assert.match(url, /metric=pageFollows/);
  assert.doesNotMatch(url, /secret/);
});

test("logo and link: uploaded first, else the brand page's Facebook picture and the brand's page on that platform", async () => {
  const { accountLogo, accountUrl } = await import("../lib/dashboard/socialAccounts.ts");
  const ig = { id: "z", name: "HITZ", platform: "instagram", source: "metricool", blogId: 6500128, enabled: true };
  assert.equal(accountLogo(ig), "https://graph.facebook.com/96473393997/picture?width=200&height=200");
  assert.equal(accountUrl(ig), "https://www.instagram.com/hitz.th");
  assert.equal(accountUrl({ ...ig, platform: "x", blogId: 7916751 }), "https://x.com/offscriptoffrec");
  assert.equal(accountLogo({ ...ig, logo: "data:image/png;base64,AA" }), "data:image/png;base64,AA");
  const typed = { id: "w", name: "Thaiwave", platform: "facebook", source: "manual", url: "https://www.facebook.com/thaiwaveclub", enabled: true };
  assert.equal(accountLogo(typed), "https://graph.facebook.com/thaiwaveclub/picture?width=200&height=200");
  assert.equal(accountLogo({ ...typed, url: "https://line.me/R/ti/p/@x" }), "");
});

test("which number to show: the API first, Metricool when the API is missing, zero, falling or stale; disagreement noted", async () => {
  const { chooseFollowers, dropOutliers } = await import("../lib/dashboard/socialAccounts.ts");
  const api = { date: "2026-11-09", value: 113000 };
  const mcBad = { date: "2026-11-08", value: 2869 };
  const r = chooseFollowers(api, mcBad, 112000);
  assert.equal(r.chosen, "api");
  assert.match(r.check, /Metricool 2,869 ต่างจาก API 113,000/);
  assert.equal(chooseFollowers(undefined, { date: "2026-11-09", value: 500 }, 490).chosen, "metricool");
  assert.equal(chooseFollowers({ date: "2026-11-09", value: 0 }, { date: "2026-11-09", value: 500 }, 490).chosen, "metricool");
  // The API fell 30% overnight while Metricool did not: Metricool.
  assert.equal(chooseFollowers({ date: "2026-11-09", value: 700 }, { date: "2026-11-09", value: 1000 }, 1000).chosen, "metricool");
  // Within 2%: no note.
  assert.equal(chooseFollowers({ date: "2026-11-09", value: 2170 }, { date: "2026-11-08", value: 2150 }, 2100).check, undefined);
  // Recent points far from the trusted reading go; older history stays.
  assert.deepEqual(dropOutliers({ "2026-08-01": 100000, "2026-11-07": 2869, "2026-11-08": 112000 }, api), { "2026-08-01": 100000, "2026-11-08": 112000 });
});

test("an account's posts: its brand's Channel on its platform, in the window", async () => {
  const { accountPosts } = await import("../lib/dashboard/socialAccounts.ts");
  const rows = [
    { platform: "TikTok", channel: "TERO Digital", date: "2026-11-01", views: 1000, likes: 50, comments: 5, shares: 5 },
    { platform: "TikTok", channel: "TERO Digital", date: "2026-09-01", views: 9999, likes: 0, comments: 0, shares: 0 },
    { platform: "Facebook", channel: "TERO Digital", date: "2026-11-01", views: 7, likes: 0, comments: 0, shares: 0 },
  ];
  const a = { id: "t", name: "terodigital", platform: "tiktok", source: "metricool", blogId: 6487104, enabled: true };
  assert.deepEqual(accountPosts(a, rows, "2026-10-10", "2026-11-08"), { posts: 1, views: 1000, likes: 50, comments: 5, shares: 5, er: 0.06 });
  assert.equal(accountPosts({ ...a, blogId: 6500109 }, rows, "2026-10-10", "2026-11-08"), null);
  assert.equal(accountPosts({ ...a, platform: "line" }, rows, "2026-10-10", "2026-11-08"), null);
});

test("the sync: YouTube by its brand's channel through the API wins over a wrong Metricool number", async () => {
  const db = fakeDb({
    "socialAccounts/config": { accounts: [{ id: "tin-yt", name: "ถกไม่เถียง", platform: "youtube", source: "metricool", blogId: 6499952, enabled: true }] },
    "accountStats/tin-yt": { series: { "2026-11-01": 112000 }, latest: { date: "2026-11-01", value: 112000 } },
  });
  const timeline = async () => [["2026-11-08", 2869]];
  const fetcher = async () => ({ ok: true, json: async () => ({ items: [{ id: "UCLZd__C13KacoUKip4I5cJw", statistics: { subscriberCount: "113000" } }] }) });
  const r = await collectAccountStats(db, "2026-11-09", { timeline, youtubeKey: "k", fetcher });
  const s = decodeFields(db.store.get("accountStats/tin-yt").fields);
  assert.equal(s.chosen, "api");
  assert.deepEqual(s.latest, { date: "2026-11-09", value: 113000 });
  assert.equal(s.series["2026-11-08"], undefined);
  assert.match(s.check, /2,869/);
  assert.equal(r.problems.length, 1);
});

test("audience: YouTube age/gender from the CMS rows, Instagram from Metricool", async () => {
  const { collectAudience } = await import("../lib/integrations/accountStatsCollect.ts");
  const db = fakeDb({ "socialAccounts/config": { accounts: [
    { id: "hitz-yt", name: "HITZ", platform: "youtube", source: "metricool", blogId: 6500128, enabled: true },
    { id: "hitz-ig", name: "HITZ", platform: "instagram", source: "metricool", blogId: 6500128, enabled: true },
    { id: "hitz-fb", name: "HITZ", platform: "facebook", source: "metricool", blogId: 6500128, enabled: true },
  ] } });
  const youtube = async (ch) => (ch === "UCNcZ9a94asv8TOP435PaCiA" ? [["age25-34", "female", 30], ["age25-34", "male", 17], ["age65-", "female", 53]] : []);
  const distribution = async (blog, net, metric) => (metric === "gender" ? [{ key: "F", value: 64.6 }, { key: "M", value: 17.7 }, { key: "U", value: 17.7 }] : [{ key: "25-34", value: 34.1 }]);
  const r = await collectAudience(db, "2026-11-09", { youtube, distribution });
  assert.equal(r.written, 2);
  const yt = decodeFields(db.store.get("audienceStats/hitz-yt").fields);
  assert.deepEqual(yt.gender, { female: 83, male: 17 });
  assert.deepEqual(yt.age, { "25-34": 47, "65+": 53 });
  assert.equal(yt.from, "2026-08-11");
  assert.deepEqual(decodeFields(db.store.get("audienceStats/hitz-ig").fields).gender, { female: 64.6, male: 17.7, other: 17.7 });
});
