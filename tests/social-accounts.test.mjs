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
