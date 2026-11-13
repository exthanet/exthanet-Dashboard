#!/usr/bin/env node
/**
 * Metricool → master data sync (multi-brand).
 *
 * Test run (default): fetch, convert and merge in memory against a baseline
 * file, then write a report. Nothing is written to Firestore.
 *
 *   node scripts/metricool-sync.mjs --since=2026-08-01
 *   node scripts/metricool-sync.mjs --since=2026-08-01 --until=2026-09-29 --baseline=data/master-data.json
 *   node scripts/metricool-sync.mjs --since=2026-08-01 --baseline=firestore
 *
 * Write (production): backup masterData, write only if every safety check
 * passes, read back, restore automatically on any failure, save the daily
 * snapshot and the run report admins see in the dashboard.
 *
 *   node scripts/metricool-sync.mjs --since=2026-07-02 --write
 *   node scripts/metricool-sync.mjs --restore-backup=<runId>
 *
 * TV ratings: the workbook tabs listed in Firestore syncConfig/tvSources (set
 * by admins in the dashboard) are downloaded from SharePoint with Microsoft
 * Graph (AZURE_TENANT_ID / AZURE_CLIENT_ID / AZURE_CLIENT_SECRET) and merged
 * in the same run. --update-only refreshes rows already in masterData and adds
 * no new ones (for backfilling a column over a long window).
 * For testing: --tv-file=<local .xlsx> reads that file
 * instead, --tv-config=<json with { sources: [...] }> replaces the Firestore list.
 *
 * Credentials: METRICOOL_API_TOKEN, METRICOOL_USER_ID (env or .env.local).
 * Brands: config/metricool-brands.json (only "enabled": true are fetched).
 */
import fs from "node:fs";
import path from "node:path";
import {
  MetricoolApi,
  NETWORKS,
  buildSnapshot,
  dedupeDigitalRows,
  chunkSnapshot,
  mapPost,
  mergeIntoMaster,
  rowKey,
} from "../lib/integrations/metricoolSync.ts";
import { YouTubeDataApi, combineYouTube, mapYouTubeVideo } from "../lib/integrations/youtubeData.ts";
import { channelUploads, collectAccMonth, writeAccMonth } from "../lib/integrations/accMonthlyCollect.ts";
import { collectRevenueMonth, listCmsChannels, writeRevenueApiMonth } from "../lib/integrations/revenueApiCollect.ts";
import { ACC_CHANNELS, programVideoIds } from "../lib/dashboard/accMonthly.ts";
import { applySplitChanges, planProgramSplits, readProgramEdits, readSplitMoved, readSplits, splitParents } from "../lib/dashboard/programSplits.ts";
import { accessTokenFor, analyticsProblem, analyticsQuery, applyVideoStats, loadCmsAccount } from "../lib/integrations/youtubeAnalytics.ts";
import { collectYtAnalytics, writeYtAnalytics } from "../lib/integrations/ytAnalyticsCollect.ts";
import { postId } from "../lib/dashboard/postKey.ts";
import { collectComments } from "../lib/integrations/commentsCollect.ts";
import { Firestore, decodeFields, docId, encodeFields, encodeValue, getAccessToken } from "../lib/integrations/firestoreRest.ts";
import {
  backupMasterData,
  cleanupOld,
  restoreMasterData,
  runIdFor,
  verifyMasterData,
  writeMasterData,
  writeRunReport,
  writeSnapshot,
} from "../lib/integrations/syncWriter.ts";
import { validateMerge, validateTv } from "../lib/integrations/syncValidation.ts";
import { invalidateDashboardCache, writeDashboardCache } from "../lib/integrations/dashboardCacheWriter.ts";
import { buildGrowth, growthDayFor, writeGrowth } from "../lib/integrations/growthWriter.ts";
import { thumbOf, writeThumbnails } from "../lib/integrations/thumbnailWriter.ts";
import { apiCoversAccount, compareSources, listVideos, loadAccounts, mapTikTokVideo, refreshAccessToken, saveAccount } from "../lib/integrations/tiktokApi.ts";
import { mergeTvEpisodes, parseTvSheet } from "../lib/integrations/tvSheet.ts";
import { nameEpisodes } from "../lib/integrations/tvEpisodeNames.ts";
import { collectAccountStats, collectAudience, metricoolDistribution, metricoolTimeline } from "../lib/integrations/accountStatsCollect.ts";
import { downloadAnonymousLink, downloadSharedFile, graphCredentials, graphToken, sharedFileModified } from "../lib/integrations/sharepoint.ts";
import { buildEmail, cleanRecipients, integrationProblems, sendEmail, shouldNotify } from "../lib/integrations/notify.ts";
import { excelDate, isPlainDay } from "../lib/dashboard/normalize.ts";

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
}
loadEnvFile(".env.local");
loadEnvFile(".env");

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...v] = a.replace(/^--/, "").split("=");
    return [k, v.join("=") || "true"];
  }),
);
const today = new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10);
const since = args.since || "2026-08-01";
const until = args.until || today;
const write = args.write === "true";
const baselineFile = write ? "firestore" : args.baseline || "data/master-data.json";
const outDir = args.out || path.join("output", "metricool-test-run");

// Same date rules as the dashboard: plain days, read as written.
const toIso = (d) => excelDate(d);

const startedAt = new Date().toISOString();
const runId = runIdFor(new Date(startedAt));
const trigger = process.env.GITHUB_EVENT_NAME === "schedule" ? "schedule" : process.env.GITHUB_EVENT_NAME ? "manual" : "local";
const githubRunUrl = process.env.GITHUB_RUN_ID
  ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
  : undefined;

let db = null;
async function firestore() {
  if (db) return db;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT || (fs.existsSync(".secrets/firebase-sync.json") && fs.readFileSync(".secrets/firebase-sync.json", "utf8"));
  if (!raw && !process.env.FIRESTORE_EMULATOR_HOST) throw new Error("No service account: set FIREBASE_SERVICE_ACCOUNT or add .secrets/firebase-sync.json");
  const sa = raw ? JSON.parse(raw) : null;
  // The dashboard's project, not the key's: a service account from another
  // project works once it is granted access here.
  const projectId = process.env.FIREBASE_PROJECT_ID || JSON.parse(fs.readFileSync(".firebaserc", "utf8")).projects.default;
  db = new Firestore(projectId, await getAccessToken(sa));
  return db;
}

if (args["notify-test"]) {
  const report = { runId: "test", status: "success", trigger, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
    window: { since: "-", until: "-" }, message: "อีเมลทดสอบจากระบบ sync (ไม่มีการเปลี่ยนข้อมูล)", platforms: {}, sources: [], totals: {}, checks: [] };
  await notifyRun(report, { force: true });
  console.log(report.notify ? JSON.stringify(report.notify) : "ไม่มีผู้รับใน syncConfig/notifications");
  if (report.notify) {
    // Show the test result in the dashboard next to the other settings.
    const db = await firestore();
    const current = await db.get("syncStatus/latest");
    await db.set("syncStatus/latest", { ...(current?.fields || {}), notify: encodeValue(report.notify) });
  }
  process.exit(report.notify?.ok ? 0 : 1);
}

if (args["restore-backup"]) {
  const n = await restoreMasterData(await firestore(), args["restore-backup"]);
  await invalidateDashboardCache(await firestore());
  console.log(`restored masterData from backup ${args["restore-backup"]} (${n} documents); dashboard copy cleared until the next sync`);
  process.exit(0);
}

const fetchStats = [];
// TikTok accounts read through the TikTok API instead of Metricool (lib/integrations/tiktokApi.ts).
let tiktokAccounts = [];
// Posts of accounts on their first API run: their first numbers set the starting point, so no growth is filed for them.
const tiktokBaselineKeys = new Set();
// Metricool TikTok rows used because the API failed: they may add posts, never
// overwrite numbers (Metricool's lag behind the API, so they would go down).
const tiktokAddOnlyKeys = new Set();
// Cover-image links per post key, for the thumbnail page (kept out of masterData).
const thumbs = new Map();
const incoming = [];
const tvStatus = [];
// Optional sources beside the platforms; a problem here is reported and e-mailed, never fails the run.
const integrations = {};
// YouTube Deep Dive data collected with the enrichment, written after masterData (write mode).
let ytDeepDive = null;
// รายได้ → Monthly ACC: this month and the one before, per CMS channel, written after masterData.
const accMonths = [];
// YouTube Revenue from the API for months the revenue file does not have yet (lib/integrations/revenueApiCollect.ts).
const revenueMonths = [];
// Seconds per step, in the log and on the run report (syncRuns), to see what makes a run long.
const timings = [];
let lastMark = Date.now();
function mark(step) {
  const now = Date.now();
  timings.push({ step, sec: Math.round((now - lastMark) / 1000) });
  lastMark = now;
  console.log(`⏱ ${step}: ${timings.at(-1).sec}s (รวม ${Math.round((now - Date.parse(startedAt)) / 1000)}s)`);
}

async function main() {
const api = new MetricoolApi({
  userId: process.env.METRICOOL_USER_ID,
  apiToken: process.env.METRICOOL_API_TOKEN,
});
const youtube = process.env.YOUTUBE_API_KEY ? new YouTubeDataApi(process.env.YOUTUBE_API_KEY) : null;
// --brands="TERO News" (comma-separated labels): only those brands, e.g. for a one-off backfill with --since.
const onlyBrands = args.brands ? args.brands.split(",").map((s) => s.trim()) : null;
const brands = JSON.parse(fs.readFileSync("config/metricool-brands.json", "utf8")).filter((b) => b.enabled && (!onlyBrands || onlyBrands.includes(b.label)));

console.log(`Metricool ${write ? "WRITE" : "test"} run ${since} → ${until} · brands: ${brands.map((b) => b.label).join(", ")}`);
// Accounts are read even without the app's key/secret: an account already on
// the API must then fall back to add-only (keep its numbers), not let
// Metricool's older numbers overwrite them and stop the whole run at check 7.
try {
  tiktokAccounts = await loadAccounts(await firestore());
  if (tiktokAccounts.length) console.log(`TikTok API: ${tiktokAccounts.map((a) => `${a.brand} (${a.displayName})`).join(", ")}`);
} catch (e) {
  console.log(`TikTok API accounts not read (${e.message}); TikTok comes from Metricool`);
}
// YouTube Analytics through the CMS account: watch time and shares for the channels it names.
let ytCms = null;
try {
  ytCms = await loadCmsAccount(await firestore());
  if (ytCms && !(process.env.YT_OAUTH_CLIENT_ID && process.env.YT_OAUTH_CLIENT_SECRET)) {
    console.log("YouTube Analytics: account found but YT_OAUTH_CLIENT_ID / YT_OAUTH_CLIENT_SECRET missing; skipped");
    integrations["YouTube Analytics"] = { ok: false, detail: "ไม่ได้ดึง", error: analyticsProblem("YT_OAUTH_CLIENT missing") };
    ytCms = null;
  } else if (ytCms) {
    console.log(`YouTube Analytics (CMS): channels ${ytCms.channels.join(", ")}`);
    integrations["YouTube Analytics"] = { ok: true, detail: "เติมเวลาดูและแชร์ 0 คลิป" };
  }
} catch (e) {
  console.log(`YouTube Analytics account not read (${e.message}); skipped`);
  integrations["YouTube Analytics"] = { ok: false, detail: "ไม่ได้ดึง", error: analyticsProblem(String(e.message || e)) };
}
for (const brand of brands) {
  const brandYouTube = [];
  const brandTikTok = [];
  const tiktokAccount = tiktokAccounts.find((a) => a.brand === brand.label);
  for (const network of brand.networks || NETWORKS) {
    // YouTube counts views inside the range only, so ask from `since` to today
    // for lifetime numbers, then keep the videos published in the window.
    const to = network === "youtube" ? today : until;
    let posts = [];
    let error = "";
    try {
      posts = await api.fetchPosts(network, brand.blogId, since, to);
    } catch (e) {
      error = e.message;
    }
    let mapped = 0, skipped = 0, outside = 0;
    for (const p of posts) {
      const row = mapPost(network, p, brand);
      if (!row) { skipped++; continue; }
      const thumb = thumbOf(network, p);
      if (thumb) thumbs.set(rowKey(row), thumb);
      const d = toIso(row.Date);
      if (d < since || d > until) { outside++; continue; }
      if (network === "youtube") brandYouTube.push(row);
      else if (network === "tiktok" && tiktokAccount) brandTikTok.push(row);
      else incoming.push(row);
      mapped++;
    }
    fetchStats.push({ brand: brand.label, network, fetched: posts.length, mapped, skipped, outside, error });
    console.log(`  ${brand.label.padEnd(12)} ${network.padEnd(9)} fetched=${String(posts.length).padStart(5)} kept=${String(mapped).padStart(4)} skipped=${skipped} outside=${outside}${error ? ` ERROR ${error}` : ""}`);
  }
  if (tiktokAccount) incoming.push(...(await tiktokStep(brand, tiktokAccount, brandTikTok)));
  // YouTube Data API: every upload with live lifetime counts, merged over Metricool.
  if (youtube && brand.youtubeChannelId) {
    let error = "";
    let fromApi = [];
    try {
      const sinceUtc = new Date(Date.parse(`${since}T00:00:00Z`) - 7 * 3600000).toISOString();
      // The uploads playlist leaves out unlisted videos (and some lives), so
      // also look up every id Metricool returned.
      const ids = [...new Set([
        ...(await youtube.listUploads(brand.youtubeChannelId, sinceUtc)),
        ...brandYouTube.map((r) => r.Content_ID),
      ])];
      fromApi = (await youtube.videos(ids))
        .map((v) => mapYouTubeVideo(v, brand))
        .filter((r) => r && toIso(r.Date) >= since && toIso(r.Date) <= until);
    } catch (e) {
      error = e.message;
    }
    const { rows, onlyDataApi } = combineYouTube(brandYouTube, fromApi);
    // Watch time and shares from YouTube Analytics; on any error the rows keep what they have.
    if (ytCms && ytCms.channels.includes(brand.youtubeChannelId)) {
      let enriched = 0, aError = "";
      try {
        const token = await accessTokenFor(ytCms.refreshToken, process.env.YT_OAUTH_CLIENT_ID, process.env.YT_OAUTH_CLIENT_SECRET);
        const ids = [...new Set(rows.filter((r) => r.Platform === "YouTube").map((r) => postId("YouTube", r.URL) || postId("YouTube", r.Content_ID)).filter(Boolean))];
        // One collection serves both: watch time / shares for the rows, the rest for the Deep Dive page.
        // Counted from the window's first day = each video's lifetime (they were all posted in it).
        const startedAt = Date.now();
        ytDeepDive = await collectYtAnalytics(token, ytCms.ownerId, brand.youtubeChannelId, ids, today, since);
        console.log(`  ${brand.label.padEnd(12)} yt-deepdive videos=${ytDeepDive.videos.length} retention=${ytDeepDive.retention.length} search=${Object.keys(ytDeepDive.search).length} in ${Math.round((Date.now() - startedAt) / 1000)}s`);
        const stats = new Map(ytDeepDive.videos.map((v) => [v.id, { views: v.views, averageViewDuration: v.avgViewSec, averageViewPercentage: v.avgViewPct, subscribersGained: v.subs, shares: v.shares }]));
        enriched = applyVideoStats(rows, stats);
      } catch (e) {
        aError = e.message;
      }
      fetchStats.push({ brand: brand.label, network: "youtube-analytics", fetched: enriched, mapped: enriched, error: aError });
      const yta = integrations["YouTube Analytics"] || { ok: true, detail: "", count: 0 };
      yta.count = (yta.count || 0) + enriched;
      yta.detail = `เติมเวลาดูและแชร์ ${yta.count.toLocaleString("en-US")} คลิป`;
      if (aError) Object.assign(yta, { ok: false, error: analyticsProblem(aError) });
      integrations["YouTube Analytics"] = yta;
      console.log(`  ${brand.label.padEnd(12)} yt-analytics enriched=${String(enriched).padStart(5)}${aError ? ` ERROR ${aError}` : ""}`);
    }
    incoming.push(...rows);
    fetchStats.push({ brand: brand.label, network: "youtube-data-api", fetched: fromApi.length, mapped: fromApi.length, onlyDataApi, error });
    console.log(`  ${brand.label.padEnd(12)} yt-dataapi fetched=${String(fromApi.length).padStart(5)} only-in-dataapi=${onlyDataApi}${error ? ` ERROR ${error}` : ""}`);
  } else {
    incoming.push(...brandYouTube);
  }
  mark(`ดึง ${brand.label}`);
}

// --baseline=firestore (and --write) reads live production data with the
// service account; rawDocs keep the exact stored documents for the backup and
// for the "nobody changed it meanwhile" check.
let rawDocs = [];
async function loadBaseline() {
  if (baselineFile !== "firestore") return JSON.parse(fs.readFileSync(baselineFile, "utf8"));
  rawDocs = await (await firestore()).listRaw("masterData");
  const rows = [];
  for (const d of rawDocs) {
    const data = decodeFields(d.fields || {});
    if (Array.isArray(data.rows)) rows.push(...data.rows);
    else if (docId(d.name).startsWith("chunk_") || !docId(d.name).startsWith("meta")) rows.push(data);
  }
  console.log(`baseline: Firestore masterData ${rows.length} rows in ${rawDocs.length} documents`);
  return rows;
}
const original = await loadBaseline();
mark("อ่าน masterData เดิม");
// The same post imported twice was counted twice; keep one row per post first.
const dedupe = dedupeDigitalRows(original);
const baseline = dedupe.rows;
if (dedupe.removed.length) console.log(`duplicates: ${dedupe.removed.length} extra rows in ${dedupe.groups} posts will be removed (backup: removed-duplicates.json)`);
// --update-only: refresh numbers of rows already in masterData, add nothing new.
const baselineKeys = new Set(baseline.map((r) => rowKey(r)).filter(Boolean));
const toMerge = (args["update-only"] === "true" ? incoming.filter((r) => baselineKeys.has(rowKey(r))) : incoming)
  // TikTok from Metricool after an API failure: new posts only (see tiktokAddOnlyKeys).
  .filter((r) => !(tiktokAddOnlyKeys.has(rowKey(r)) && baselineKeys.has(rowKey(r))));
const keptTikTok = incoming.filter((r) => tiktokAddOnlyKeys.has(rowKey(r)) && baselineKeys.has(rowKey(r))).length;
if (keptTikTok) console.log(`TikTok fallback: ${keptTikTok} existing TikTok posts keep their numbers (Metricool adds new posts only)`);
if (args["update-only"] === "true" && toMerge.length + keptTikTok !== incoming.length) console.log(`update-only: ${incoming.length - toMerge.length - keptTikTok} posts not in masterData are left out`);
const result = mergeIntoMaster(baseline, toMerge);

// How well does automatic detection agree with what the team labelled?
const byKey = new Map(baseline.map((r) => [rowKey(r), r]).filter(([k]) => k));
const agree = { program: [0, 0], vdo: [0, 0], date: [0, 0] };
const mismatches = { program: {}, vdo: {}, date: [] };
for (const row of incoming) {
  const old = byKey.get(rowKey(row));
  if (!old) continue;
  const cmp = (name, a, b) => {
    agree[name][1]++;
    if (a === b) agree[name][0]++;
    else if (name === "date") mismatches.date.length < 10 && mismatches.date.push(`${row.Platform} ${b}→${a}`);
    else { const k = `${b} → ${a}`; mismatches[name][k] = (mismatches[name][k] || 0) + 1; }
  };
  if (old.Program && old.Program !== "ไม่ระบุ") cmp("program", row.Program, old.Program);
  cmp("vdo", row.VDO_Type, old.VDO_Type);
  cmp("date", toIso(row.Date), toIso(old.Date));
}
// Reverse check: team rows in the window that the API did not return.
const incomingKeys = new Set(incoming.map((r) => rowKey(r)));
const missingFromApi = {};
for (const r of baseline) {
  if (!["Facebook", "Instagram", "TikTok", "YouTube"].includes(r.Platform)) continue;
  const d = toIso(r.Date);
  if (d < since || d > until) continue;
  const key = rowKey(r);
  if (key && incomingKeys.has(key)) continue;
  const k = `${r.Platform} · ${r.Program} · ${key ? "id" : "no-id"}`;
  missingFromApi[k] = (missingFromApi[k] || 0) + 1;
}
const pct = ([a, b]) => (b ? `${((a / b) * 100).toFixed(1)}% (${a}/${b})` : "-");

const newByProgram = {};
for (const r of result.inserted) newByProgram[`${r.Platform} · ${r.Program}`] = (newByProgram[`${r.Platform} · ${r.Program}`] || 0) + 1;
const review = result.inserted.filter((r) => r._review);
const viewGain = result.updated
  .map((u) => ({ key: u.key, before: Number(String(u.before.Views ?? 0).replace(/,/g, "")), after: Number(u.after.Views ?? String(u.before.Views ?? 0).replace(/,/g, "")) }))
  .filter((x) => x.after !== x.before)
  .sort((a, b) => b.after - b.before - (a.after - a.before));

// Daily snapshot that a real run would write (never overwritten).
const snapshot = buildSnapshot(result);
const snapshotChunks = chunkSnapshot(snapshot);
const snapshotBytes = Buffer.byteLength(JSON.stringify(snapshot));
// Daily growth: what each post gained since the previous run (lib/dashboard/growth.ts).
const growthDay = growthDayFor(today);
const growth = buildGrowth(result, growthDay);
// An account's first TikTok API run sets the starting point: its posts file no growth that day.
const baselineSkipped = growth.entries.filter((e) => tiktokBaselineKeys.has(e[0])).length;
growth.entries = growth.entries.filter((e) => !tiktokBaselineKeys.has(e[0]));
// Only the normal daily window (about 90 days) measures one day's gain. A wider
// run (backfill) also refreshes old posts not updated for months; their whole
// change would land on one day, so such runs write no growth.
const growthWindowStart = new Date(Date.parse(`${today}T00:00:00Z`) - 100 * 86400000).toISOString().slice(0, 10);
const growthEnabled = since >= growthWindowStart;

const summary = {
  window: { since, until, baseline: baselineFile },
  fetch: fetchStats,
  totals: {
    incoming: incoming.length,
    matchedExisting: result.updated.length + result.unchanged,
    updated: result.updated.length,
    unchanged: result.unchanged,
    inserted: result.inserted.length,
    needsReview: review.length,
  },
  agreementWithTeamLabels: { program: pct(agree.program), vdoType: pct(agree.vdo), bangkokDate: pct(agree.date) },
  topMismatches: {
    program: Object.entries(mismatches.program).sort((a, b) => b[1] - a[1]).slice(0, 8),
    vdoType: Object.entries(mismatches.vdo).sort((a, b) => b[1] - a[1]).slice(0, 8),
    date: mismatches.date,
  },
  snapshot: {
    date: today,
    rows: snapshot.length,
    documents: snapshotChunks.length,
    approxKB: Math.round(snapshotBytes / 1024),
    note: "rows = posts whose numbers changed or appeared today; unchanged posts are skipped",
  },
  growth: {
    day: growthDay,
    posts: growth.entries.length,
    views: growth.entries.reduce((a, e) => a + e[1], 0),
    newPosts: growth.entries.filter((e) => e[5]).length,
    drops: growth.entries.filter((e) => e[1] < 0).length,
    latePostsLeftOut: growth.late,
    tiktokFirstApiRunLeftOut: baselineSkipped,
    written: growthEnabled ? "yes" : `no: window starts ${since}, before ${growthWindowStart} (backfill)`,
  },
  newRowsByPlatformProgram: newByProgram,
  baselineRowsNotReturnedByApi: missingFromApi,
  biggestViewUpdates: viewGain.slice(0, 10),
};

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
const csv = (rows, cols) =>
  "﻿" + [cols.join(","), ...rows.map((r) => cols.map((c) => `"${String(r[c] ?? "").replaceAll('"', '""')}"`).join(","))].join("\n");
const cols = ["Date", "Publish_Time", "Platform", "Channel", "Program", "VDO_Type", "Topic_Type", "Topic", "Views", "Likes", "Comments", "Shares", "URL"];
fs.writeFileSync(path.join(outDir, "new-rows.csv"), csv(result.inserted, cols));
fs.writeFileSync(path.join(outDir, "needs-review.csv"), csv(review, cols));
fs.writeFileSync(
  path.join(outDir, "updated-rows.csv"),
  csv(result.updated.map((u) => ({ key: u.key, ...Object.fromEntries(Object.entries(u.before).map(([k, v]) => [`old_${k}`, v])), ...Object.fromEntries(Object.entries(u.after).map(([k, v]) => [`new_${k}`, v])) })),
    ["key", "old_Views", "new_Views", "old_Likes", "new_Likes", "old_Comments", "new_Comments", "old_Shares", "new_Shares"]),
);

fs.writeFileSync(
  path.join(outDir, `snapshot-${today}.csv`),
  csv(snapshot.map((r) => ({ key: r.k, views: r.v, likes: r.l, comments: r.c, shares: r.s })), ["key", "views", "likes", "comments", "shares"]),
);
console.log("\n" + JSON.stringify(summary.totals, null, 1));
console.log("snapshot:", summary.snapshot);
console.log("growth:", summary.growth);
console.log("agreement:", summary.agreementWithTeamLabels);
console.log(`report: ${outDir}/summary.json, new-rows.csv, needs-review.csv, updated-rows.csv`);

// Safety checks: all must pass before this data may replace production.
fs.writeFileSync(path.join(outDir, "removed-duplicates.json"), JSON.stringify(dedupe.removed, null, 1));
const validation = validateMerge(baseline, result, toMerge, { originalCount: original.length, removed: dedupe.removed });
fs.writeFileSync(path.join(outDir, "validation.json"), JSON.stringify(validation, null, 2));
console.log(`\nvalidation: ${validation.ok ? "PASS" : "FAIL"}`);
for (const c of validation.checks) {
  console.log(`  ${c.pass ? "✔" : "✖"} ${c.name} — ${c.detail}`);
  for (const w of c.warnings || []) console.log(`      · ${w}`);
}
console.log(`  dashboard load: ${validation.stats.dashboardLoadMB.before} → ${validation.stats.dashboardLoadMB.after} MB · reads per open: ${validation.stats.readsPerDashboardOpen.before} → ${validation.stats.readsPerDashboardOpen.after}`);

// ---------- TV rating workbook ----------
mark("รวมและตรวจข้อมูล");
const tvRun = await tvStep(result.merged);
mark("TV");
const finalRows = tvRun.result ? tvRun.result.rows : result.merged;
const tvChecks = tvRun.result ? validateTv(result.merged, tvRun.result, tvRun.episodes) : [];
// แยกรายการย่อย: new posts and old ones the rules now match move to the sub-show; rows the
// system moved go back when their rule is off. Only Program changes; the rest is checked above.
const splits = await programSplitStep(finalRows);

// ---------- Monthly ACC (รายได้) ----------
// Through the same CMS account; shows inside a channel are found by masterData's
// Program, then by title for older clips. A problem is reported, never fails the run.
// Skipped on a run limited to some brands (--brands): a backfill, not the daily run.
if (ytCms && !onlyBrands) {
  const startedAt = Date.now();
  const thisMonth = today.slice(0, 7);
  const prev = new Date(Date.UTC(Number(thisMonth.slice(0, 4)), Number(thisMonth.slice(5)) - 2, 1)).toISOString().slice(0, 7);
  try {
    const token = await accessTokenFor(ytCms.refreshToken, process.env.YT_OAUTH_CLIENT_ID, process.env.YT_OAUTH_CLIENT_SECRET);
    const programs = [...new Set(ACC_CHANNELS.filter((c) => c.program).map((c) => c.program))];
    const programOf = new Map();
    // A sub-show stays in its parent's accounting line (ถกใจคนค้นหมาป่า in ถกไม่เถียง).
    for (const r of finalRows) {
      if (r.Platform !== "YouTube") continue;
      const id = postId("YouTube", r.URL) || postId("YouTube", r.Content_ID);
      if (id) programOf.set(id, splits.parents.get(r.Program) || r.Program || "");
    }
    const programVideos = {};
    for (const channel of [...new Set(ACC_CHANNELS.filter((c) => c.program).map((c) => c.id))]) {
      Object.assign(programVideos, programVideoIds(await channelUploads(token, channel), programOf, programs));
    }
    for (const m of [prev, thisMonth]) accMonths.push(await collectAccMonth(token, ytCms.ownerId, m, today, programVideos));
    console.log(`Monthly ACC: ${accMonths.map((m) => `${m.month} (through ${m.through})`).join(", ")} · ${Object.entries(programVideos).map(([p, ids]) => `${p} ${ids.length} clips`).join(", ")} in ${Math.round((Date.now() - startedAt) / 1000)}s`);
  } catch (e) {
    accMonths.length = 0;
    console.log(`Monthly ACC not collected: ${e.message}`);
    integrations["Monthly ACC"] = { ok: false, detail: "ไม่ได้ดึง", error: analyticsProblem(e.message) };
  }
  mark("ดึง Monthly ACC");
  try {
    const token = await accessTokenFor(ytCms.refreshToken, process.env.YT_OAUTH_CLIENT_ID, process.env.YT_OAUTH_CLIENT_SECRET);
    // Each CMS channel's revenue too (รายงานผล → CMS Channel); without the channel list the totals still go.
    const cmsChannels = await listCmsChannels(token, ytCms.ownerId).catch((e) => {
      console.log(`CMS channels not listed: ${e.message}`);
      return undefined;
    });
    for (const m of [prev, thisMonth]) revenueMonths.push(await collectRevenueMonth(token, ytCms.ownerId, m, today, undefined, undefined, cmsChannels));
    console.log(`Revenue API: ${revenueMonths.map((m) => `${m.month} (through ${m.endDate})`).join(", ")}`);
  } catch (e) {
    revenueMonths.length = 0;
    console.log(`Revenue API not collected: ${e.message}`);
    integrations["Revenue API"] = { ok: false, detail: "ไม่ได้ดึง", error: analyticsProblem(e.message) };
  }
  mark("ดึงรายได้ YouTube (API)");
}
for (const c of tvChecks) {
  console.log(`  ${c.pass ? "✔" : "✖"} ${c.name} — ${c.detail}`);
  for (const w of c.warnings || []) console.log(`      · ${w}`);
}
const allChecks = [...validation.checks, ...tvChecks];
const allOk = allChecks.every((c) => c.pass);
fs.writeFileSync(path.join(outDir, "validation.json"), JSON.stringify({ ...validation, ok: allOk, checks: allChecks }, null, 2));
if (!allOk) process.exitCode = 1;

if (!write) return;

// ---------- write mode ----------
const report = baseReport(allOk ? "success" : "blocked");
const tvTotals = tvRun.result ? { tvUpdated: tvRun.result.updated.length, tvInserted: tvRun.result.inserted.length, tvMerged: tvRun.result.removed.length } : {};
report.totals = { ...summary.totals, duplicatesRemoved: dedupe.removed.length, ...tvTotals, rowsAfter: finalRows.length };
report.checks = allChecks;
// TV for the report: new episodes' air days, updated, latest air day with a rating.
if (tvStatus.length) {
  const rated = finalRows.filter((r) => r.Platform === "TV" && Number(r.TV_Rating_Total) > 0).map((r) => String(r.Date)).sort();
  report.tv = {
    inserted: (tvRun.result?.inserted || []).map((r) => String(r.Date)),
    updated: tvRun.result?.updated.length || 0,
    latest: rated[rated.length - 1] || "",
    // Episodes named from the day's clips (เงินทองของจริง): the newest air day per program.
    named: Object.values(
      Object.fromEntries(
        [...(tvRun.result?.inserted || []), ...finalRows.filter((r) => (tvRun.result?.named || []).some((n) => n.key === `${r.Date}|${r.Program}|${r.Channel}`))]
          .filter((r) => /ชื่อตอนจาก|ยังไม่มีชื่อตอน/.test(String(r.Notes || "")))
          .sort((a, b) => String(a.Date).localeCompare(String(b.Date)))
          .map((r) => [r.Program, { date: String(r.Date), program: String(r.Program), topic: String(r.Topic || ""), clips: (String(r.Notes).match(/คลิปวันนั้น d+/) || [""])[0] }]),
      ),
    ),
  };
}
if (!allOk) {
  const failed = allChecks.filter((c) => !c.pass).map((c) => c.name).join(", ");
  report.message = `ไม่ได้เขียนข้อมูล เพราะไม่ผ่านการตรวจ: ${failed} (ข้อมูลเดิมไม่ถูกแตะ)`;
  await notifyRun(finish(report));
  await writeRunReport(await firestore(), report);
  console.log(report.message);
  process.exitCode = 1;
  return;
}
const fsdb = await firestore();
const backed = await backupMasterData(fsdb, rawDocs, runId);
report.backupId = runId;
console.log(`backup: masterDataBackups/${runId} (${backed} documents)`);
mark("สำรอง masterData");
try {
  // The dashboard copy stops matching before masterData changes, so a run that
  // stops halfway can never leave the dashboard showing old numbers.
  await invalidateDashboardCache(fsdb);
  const chunks = await writeMasterData(fsdb, finalRows, rawDocs);
  const problem = await verifyMasterData(fsdb, finalRows);
  if (problem) throw new Error(problem);
  mark("เขียนและตรวจ masterData");
  // Which rows the system moved, now that they are written (next runs and the admin page read it).
  if (splits.loaded) {
    await fsdb
      .set("syncConfig/programSplitsMoved", encodeFields({ moved: splits.moved, updatedAt: new Date().toISOString() }))
      .catch((e) => console.error(`programSplitsMoved not saved: ${e.message}`));
  }
  report.snapshotDocs = await writeSnapshot(fsdb, today, runId, snapshot);
  // Compact copy for opening the dashboard fast; if it fails the dashboard
  // reads masterData as before, so it never fails the run.
  try {
    const version = new Date().toISOString();
    const parts = await writeDashboardCache(fsdb, finalRows, version, version);
    console.log(`dashboard copy: ${parts} part(s), version ${version}`);
  } catch (e) {
    console.error(`dashboard copy not written (dashboard will read masterData): ${e.message}`);
  }
  mark("snapshot และสำเนา dashboard");
  report.message = `อัปเดต ${result.updated.length} · ใหม่ ${result.inserted.length} · ลบแถวซ้ำ ${dedupe.removed.length} · รอตรวจ ${review.length}` +
    (tvRun.result ? ` · TV อัปเดต ${tvRun.result.updated.length} เทป ใหม่ ${tvRun.result.inserted.length}` : "");
  await writeCompetitors(fsdb, tvRun.competitors);
  // Accounts whose first API run is now written count growth from the next run.
  for (const a of tiktokAccounts) {
    if (a.baselineDone || !fetchStats.some((s) => s.network === "tiktok-api" && s.brand === a.brand && s.source === "api")) continue;
    a.baselineDone = true;
    await saveAccount(fsdb, a).catch((e) => console.error(`TikTok baseline flag not saved for ${a.brand}: ${e.message}`));
  }
  console.log(`written: ${chunks} masterData documents · snapshot ${report.snapshotDocs} document(s)`);
  mark("คู่แข่ง TV และ TikTok");
  // Last, so a run that is rolled back never leaves gains behind (the next run
  // would count them again). Analysis only: a failure here never fails the run.
  // Cover links for posts in masterData; analysis only, never fails the run.
  try {
    // Facebook / Instagram links expire within days anyway: keep them for recent posts only (120 days).
    const coverFrom = new Date(Date.parse(`${today}T00:00:00Z`) - 120 * 86400000).toISOString().slice(0, 10);
    const postDate = new Map(finalRows.map((r) => [rowKey(r), toIso(r.Date)]).filter(([k]) => k));
    const counts = await writeThumbnails(fsdb, thumbs, (k) => {
      if (!postDate.has(k)) return false;
      return !/^(Facebook|Instagram)\|/.test(k) || postDate.get(k) >= coverFrom;
    });
    console.log(`thumbnails: ${JSON.stringify(counts)}`);
  } catch (e) {
    console.error(`thumbnails not written: ${e.message}`);
  }
  mark("ภาพปก");
  // YouTube Deep Dive (admins only); analysis, never fails the run.
  if (ytDeepDive) {
    try {
      const parts = await writeYtAnalytics(fsdb, ytDeepDive);
      console.log(`youtube deep dive: ${ytDeepDive.videos.length} videos in ${parts} part(s)`);
    } catch (e) {
      console.error(`youtube deep dive not written: ${e.message}`);
      const yta = integrations["YouTube Analytics"];
      if (yta) Object.assign(yta, { ok: false, error: analyticsProblem(`deep dive not written: ${e.message}`) });
    }
  }
  mark("เขียน YouTube Deep Dive");
  // Monthly ACC (admins only); never fails the run.
  for (const m of accMonths) {
    try {
      await writeAccMonth(fsdb, m);
      console.log(`monthly acc: accMonthly/${m.month} ${m.rows.length} channels`);
      integrations["Monthly ACC"] = { ok: true, detail: `อัปเดต ${accMonths.map((x) => x.month).join(", ")}` };
    } catch (e) {
      console.error(`monthly acc not written: ${e.message}`);
      integrations["Monthly ACC"] = { ok: false, detail: "ไม่ได้บันทึก", error: analyticsProblem(`monthly acc not written: ${e.message}`) };
      break;
    }
  }
  mark("เขียน Monthly ACC");
  // YouTube Revenue from the API (who may see revenue reads); never fails the run.
  for (const m of revenueMonths) {
    try {
      await writeRevenueApiMonth(fsdb, m);
      console.log(`revenue api: revenueApi/${m.month} through ${m.endDate}`);
      integrations["Revenue API"] = { ok: true, detail: `อัปเดต ${revenueMonths.map((x) => x.month).join(", ")}` };
    } catch (e) {
      console.error(`revenue api not written: ${e.message}`);
      integrations["Revenue API"] = { ok: false, detail: "ไม่ได้บันทึก", error: analyticsProblem(`revenue api not written: ${e.message}`) };
      break;
    }
  }
  mark("เขียนรายได้ YouTube (API)");
  // ผู้ติดตาม board: each account's daily followers (lib/integrations/accountStatsCollect.ts); never fails the run.
  try {
    const timeline = process.env.METRICOOL_USER_ID && process.env.METRICOOL_API_TOKEN ? metricoolTimeline(process.env.METRICOOL_USER_ID, process.env.METRICOOL_API_TOKEN) : undefined;
    const st = await collectAccountStats(fsdb, today, { timeline, youtubeKey: process.env.YOUTUBE_API_KEY });
    if (st.accounts) {
      console.log(`followers: ${st.updated} accounts${st.problems.length ? ` · ${st.problems.length} problem(s): ${st.problems.join(" | ")}` : ""}`);
      integrations["ผู้ติดตาม"] = st.problems.length
        ? { ok: false, detail: `อัปเดต ${st.updated - st.problems.length} จาก ${st.accounts} บัญชี`, error: st.problems.slice(0, 3).join(" · ") }
        : { ok: true, detail: `อัปเดต ${st.updated} บัญชี` };
    }
  } catch (e) {
    console.error(`followers not collected: ${e.message}`);
    integrations["ผู้ติดตาม"] = { ok: false, detail: "ไม่ได้ดึง", error: String(e.message).slice(0, 160) };
  }
  // Media Kit audience: YouTube viewers through the CMS, Instagram followers through Metricool; never fails the run.
  try {
    const mc = process.env.METRICOOL_USER_ID && process.env.METRICOOL_API_TOKEN;
    let youtubeAudience;
    if (ytCms) {
      const token = await accessTokenFor(ytCms.refreshToken, process.env.YT_OAUTH_CLIENT_ID, process.env.YT_OAUTH_CLIENT_SECRET);
      youtubeAudience = async (channel, from, to) =>
        (await analyticsQuery(token, ytCms.ownerId, { startDate: from, endDate: to, filters: `channel==${channel}`, dimensions: "ageGroup,gender", metrics: "viewerPercentage" })).rows;
    }
    const au = await collectAudience(fsdb, today, {
      distribution: mc ? metricoolDistribution(process.env.METRICOOL_USER_ID, process.env.METRICOOL_API_TOKEN) : undefined,
      youtube: youtubeAudience,
    });
    console.log(`audience: ${au.written} accounts${au.problems.length ? ` · ${au.problems.join(" | ")}` : ""}`);
  } catch (e) {
    console.error(`audience not collected: ${e.message}`);
  }
  mark("ผู้ติดตาม");
  // Comments for วิเคราะห์คลิป (lib/integrations/commentsCollect.ts); never fails the run.
  try {
    const num = (v) => Number(String(v ?? "").replace(/,/g, "")) || 0;
    const clips = finalRows
      .map((r) => ({ platform: String(r.Platform), id: postId(String(r.Platform), r.URL) || postId(String(r.Platform), r.Content_ID), date: toIso(r.Date), views: num(r.Views), comments: num(r.Comments) }))
      .filter((c) => c.id);
    const facebookBlogs = brands.filter((b) => (b.networks || NETWORKS).includes("facebook")).map((b) => b.blogId);
    const got = await collectComments(fsdb, clips, {
      today,
      youtubeKey: process.env.YOUTUBE_API_KEY,
      facebookBlogs,
      fetchFacebook: (blogId) => api.fetchComments("facebook", blogId),
    });
    console.log(`comments: YouTube ${got.youtube} clips · Facebook ${got.facebook} posts · removed ${got.removed}${got.problems.length ? ` · ${got.problems.join(" / ")}` : ""}`);
    integrations["Comments"] = got.problems.length && !got.youtube && !got.facebook
      ? { ok: false, detail: "ไม่ได้ดึง", error: got.problems.join(" / ").slice(0, 200) }
      : { ok: true, detail: `คอมเมนต์ YouTube ${got.youtube} คลิป · Facebook ${got.facebook} โพสต์` };
  } catch (e) {
    console.error(`comments not collected: ${e.message}`);
    integrations["Comments"] = { ok: false, detail: "ไม่ได้ดึง", error: String(e.message || e).slice(0, 200) };
  }
  mark("คอมเมนต์");
  if (!growthEnabled) console.log(`growth: not written (${summary.growth.written})`);
  else try {
    const g = await writeGrowth(fsdb, growthDay, today, runId, growth);
    console.log(`growth: growthDaily/${growthDay} ${g.rows} posts (${Math.round(g.bytes / 1024)} KB)`);
  } catch (e) {
    console.error(`growth not written: ${e.message}`);
  }
} catch (e) {
  console.error(`write failed, restoring backup ${runId}: ${e.message}`);
  await restoreMasterData(fsdb, runId);
  await invalidateDashboardCache(fsdb).catch(() => undefined);
  report.status = "failed";
  report.message = `เขียนไม่สำเร็จ กู้คืนข้อมูลเดิมจากสำรองแล้ว: ${e.message}`;
  process.exitCode = 1;
}
mark("growth");
await notifyRun(finish(report));
await writeRunReport(fsdb, report);
// Old run logs, snapshots and backups: names only, so it stays quick however many there are.
const removed = await cleanupOld(fsdb, new Date());
mark("ล้างข้อมูลเก่า");
console.log(`run report: syncRuns/${runId} (${report.status}) · cleanup ${JSON.stringify(removed)}`);
}

// TikTok through the TikTok API for an authorised account; Metricool's rows
// (already fetched) are the fallback and the comparison. Returns the rows to use.
async function tiktokStep(brand, account, metricoolRows) {
  const stat = { brand: brand.label, network: "tiktok-api", account: account.displayName, fetched: 0, mapped: 0, source: "metricool", error: "" };
  let rows = metricoolRows;
  try {
    if (!process.env.TIKTOK_CLIENT_KEY || !process.env.TIKTOK_CLIENT_SECRET) throw new Error("ยังไม่ได้ตั้ง TIKTOK_CLIENT_KEY / TIKTOK_CLIENT_SECRET");
    const token = await refreshAccessToken(process.env.TIKTOK_CLIENT_KEY, process.env.TIKTOK_CLIENT_SECRET, account.refreshToken);
    if (token.refreshToken !== account.refreshToken) {
      // A new refresh token replaces the old one: save it even on a test run, or it is lost.
      account.refreshToken = token.refreshToken;
      account.refreshExpiresAt = token.refreshExpiresAt;
      await saveAccount(await firestore(), account);
      console.log(`  ${brand.label.padEnd(12)} tiktok-api new refresh token saved`);
    }
    const sinceSec = Date.parse(`${since}T00:00:00+07:00`) / 1000;
    const videos = await listVideos(token.accessToken, sinceSec, (s) => console.log(s));
    const apiRows = videos
      .map((v) => mapTikTokVideo(v, brand))
      .filter((r) => r && toIso(r.Date) >= since && toIso(r.Date) <= until);
    const cmp = compareSources(apiRows, metricoolRows);
    Object.assign(stat, { fetched: videos.length, compare: cmp });
    if (apiCoversAccount(cmp)) {
      rows = apiRows;
      stat.source = "api";
      stat.mapped = apiRows.length;
      if (!account.baselineDone) for (const r of apiRows) tiktokBaselineKeys.add(rowKey(r));
    } else {
      stat.error = `TikTok API ได้ ${cmp.apiVideos} คลิป น้อยกว่า Metricool ${cmp.metricoolPosts} คลิป (สิทธิ์อาจหลุด): เพิ่มเฉพาะคลิปใหม่จาก Metricool ตัวเลขเดิมคงไว้`;
    }
  } catch (e) {
    const msg = String(e.message || e);
    const fix = /TIKTOK_CLIENT/.test(msg) ? "ตั้ง GitHub Secrets ให้ครบ" : /invalid_grant|expired|revoked/i.test(msg) ? "ให้เจ้าของบัญชีกดอนุญาตใหม่" : "ระบบจะลองใหม่รอบหน้า";
    stat.error = `TikTok API ใช้ไม่ได้ (${msg.slice(0, 140)}): เพิ่มเฉพาะคลิปใหม่จาก Metricool ตัวเลขเดิมคงไว้ · ${fix}`;
  }
  if (stat.source === "metricool") for (const r of metricoolRows) tiktokAddOnlyKeys.add(rowKey(r));
  const daysLeft = account.refreshExpiresAt ? Math.floor((Date.parse(account.refreshExpiresAt) - Date.now()) / 86400000) : null;
  if (!stat.error && daysLeft !== null && daysLeft < 30) stat.error = `สิทธิ์ TikTok API ของ ${account.displayName} หมดอายุใน ${daysLeft} วัน: ให้เจ้าของบัญชีกดอนุญาตใหม่`;
  const c = stat.compare;
  console.log(`  ${brand.label.padEnd(12)} tiktok-api fetched=${String(stat.fetched).padStart(5)} source=${stat.source}${c ? ` matched=${c.matched}/${c.metricoolPosts} medianDiff=${c.medianViewDiff === null ? "-" : (c.medianViewDiff * 100).toFixed(1) + "%"} onlyApi=${c.onlyApi} onlyMetricool=${c.onlyMetricool}` : ""}${stat.error ? ` ⚠ ${stat.error}` : ""}`);
  fetchStats.push(stat);
  return rows;
}

// แยกรายการย่อย from syncConfig/programSplits (admins edit it in the dashboard). A problem
// reading the rules is logged and leaves Program as merged; it never fails the run.
async function programSplitStep(rows) {
  const none = { loaded: false, moved: {}, parents: new Map(), changes: [] };
  if (baselineFile !== "firestore") return none;
  try {
    const db = await firestore();
    const [rulesDoc, movedDoc, editsDoc] = await Promise.all([db.get("syncConfig/programSplits"), db.get("syncConfig/programSplitsMoved"), db.get("syncConfig/programEdits")]);
    const rules = readSplits(rulesDoc ? decodeFields(rulesDoc.fields || {}) : null);
    const before = readSplitMoved(movedDoc ? decodeFields(movedDoc.fields || {}) : null);
    // A Program an admin set on a clip (หน้ารายละเอียดคลิป) wins over the rules and stays as set.
    const edits = readProgramEdits(editsDoc ? decodeFields(editsDoc.fields || {}) : null);
    let edited = 0;
    for (const r of rows) {
      const e = edits[rowKey(r)];
      if (e && r.Platform !== "TV" && r.Program !== e.program) {
        r.Program = e.program;
        edited++;
      }
    }
    if (edited) console.log(`รายการที่ admin แก้: ใช้กับ ${edited} แถว`);
    if (!rules.length && !Object.keys(before).length) return none;
    const plan = planProgramSplits(rows, rules, before, rowKey, new Set(Object.keys(edits)));
    applySplitChanges(rows, plan.changes);
    const count = (kind) => plan.changes.filter((c) => c.kind === kind).length;
    console.log(`แยกรายการย่อย: ${rules.length} กฎ · ย้าย ${count("move")} แถว · คืนรายการแม่ ${count("back")} แถว`);
    return { loaded: true, moved: plan.moved, parents: splitParents(rules), changes: plan.changes };
  } catch (e) {
    console.error(`แยกรายการย่อย ไม่ได้ทำรอบนี้: ${e.message}`);
    return none;
  }
}

// TV: read each enabled workbook tab, parse episodes and competitors, merge.
// A source that cannot be read is reported and skipped; the rest still sync.
async function tvStep(rows) {
  let sources = [];
  try {
    if (args["tv-config"]) sources = JSON.parse(fs.readFileSync(args["tv-config"], "utf8")).sources || [];
    else if (baselineFile === "firestore") {
      const doc = await (await firestore()).get("syncConfig/tvSources");
      sources = doc ? decodeFields(doc.fields || {}).sources || [] : [];
    }
  } catch (e) {
    tvStatus.push({ id: "-", name: "รายการแหล่งข้อมูล TV", ok: false, error: String(e.message).slice(0, 200) });
  }
  sources = sources.filter((s) => s.enabled);
  if (!sources.length) return { result: null, episodes: [], competitors: [] };
  const { default: XLSX } = await import("xlsx");
  const creds = graphCredentials();
  let token = "";
  const books = new Map();
  const episodes = [];
  const competitors = [];
  // Tabs an admin uploaded in the dashboard (tvUploads/{sourceId}).
  const uploads = new Map();
  if (!args["tv-file"] && baselineFile === "firestore") {
    for (const d of await (await firestore()).listRaw("tvUploads")) uploads.set(docId(d.name), decodeFields(d.fields || {}));
  }
  const fromBook = (buf, s) => {
    let book = books.get(s.url);
    if (!book) {
      book = XLSX.read(buf(), { type: "buffer" });
      books.set(s.url, book);
    }
    const sheet = book.Sheets[s.sheet];
    if (!sheet) throw new Error(`ไม่พบแท็บ "${s.sheet}"`);
    const parsed = parseTvSheet(XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: "" }), s);
    if (parsed.missingColumns.length) throw new Error(`ไม่พบคอลัมน์: ${parsed.missingColumns.join(", ")}`);
    return parsed;
  };
  // An upload was parsed in the browser; take only well-formed numbers, and
  // the program/channel from the source settings, not from the upload.
  const fromUpload = (u, s) => {
    const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
    const eps = (u.episodes || [])
      .filter((e) => isPlainDay(e.date) && Number.isFinite(Number(e.rating)))
      .map((e) => ({
        date: e.date, program: s.program, channel: s.channel, topic: String(e.topic || ""), topicType: String(e.topicType || ""),
        durationMin: num(e.durationMin), rating: num(e.rating), bkk: num(e.bkk), urban: num(e.urban), bkkUrban: num(e.bkkUrban),
        rural: num(e.rural), viewers: num(e.viewers),
      }));
    const comps = (u.competitors || []).filter((c) => isPlainDay(c.date)).map((c) => ({
      date: c.date, competitorChannel: String(c.competitorChannel || ""), program: String(c.program || ""), slot: String(c.slot || ""), rating: num(c.rating),
    }));
    return { episodes: eps, competitors: comps, pending: u.pending || [], cancelled: u.cancelled || [], uploadedAt: u.uploadedAt, fileName: u.fileName };
  };
  console.log(`\nTV: ${sources.length} source(s)`);
  for (const s of sources) {
    const status = { id: s.id, name: s.name, ok: false, episodes: 0, pending: 0, cancelled: 0, competitors: 0, error: "", from: "" };
    try {
      const upload = uploads.get(s.id);
      let parsed;
      if (args["tv-file"]) {
        parsed = fromBook(() => fs.readFileSync(args["tv-file"]), s);
        status.from = "file";
      } else if (creds) {
        // SharePoint and an upload: take whichever is newer.
        token ||= await graphToken(creds);
        const modified = await sharedFileModified(s.url, token).catch(() => "");
        if (upload && modified && String(upload.uploadedAt) > modified) {
          parsed = fromUpload(upload, s);
          status.from = "upload";
        } else {
          try {
            const buf = await downloadSharedFile(s.url, token);
            parsed = fromBook(() => buf, s);
            status.from = "sharepoint";
          } catch (e) {
            if (!upload) throw e;
            parsed = fromUpload(upload, s);
            status.from = "upload";
            status.error = `SharePoint อ่านไม่ได้ ใช้ไฟล์ที่อัปโหลดแทน: ${String(e.message).slice(0, 120)}`;
          }
        }
      } else if (s.url) {
        // No Graph app: the link itself, shared as "Anyone with the link · Can view".
        // An upload is used when the link cannot be read.
        try {
          const buf = await downloadAnonymousLink(s.url);
          parsed = fromBook(() => buf, s);
          status.from = "link";
        } catch (e) {
          if (!upload) throw e;
          parsed = fromUpload(upload, s);
          status.from = "upload";
          status.error = `ลิงก์อ่านไม่ได้ ใช้ไฟล์ที่อัปโหลดแทน: ${String(e.message).slice(0, 120)}`;
        }
      } else if (upload) {
        parsed = fromUpload(upload, s);
        status.from = "upload";
      } else {
        throw new Error("ยังไม่มีข้อมูล: ใส่ลิงก์ไฟล์ใน แหล่งข้อมูล TV, อัปโหลดไฟล์ใน dashboard (เครื่องมือ admin → อัปโหลดไฟล์ TV) หรือตั้งค่า Microsoft Graph");
      }
      episodes.push(...parsed.episodes);
      competitors.push({ source: s, rows: parsed.competitors });
      Object.assign(status, { ok: true, episodes: parsed.episodes.length, pending: parsed.pending.length, cancelled: parsed.cancelled.length, competitors: parsed.competitors.length });
      // Rows read with a correction or left out (a Nielsen tab's dates): for a person to check.
      if (parsed.problems?.length) status.problems = parsed.problems.slice(0, 20);
    } catch (e) {
      status.error = String(e.message || e).slice(0, 200);
    }
    tvStatus.push(status);
    console.log(`  ${s.name}${status.from ? ` [${status.from}]` : ""}: ${status.ok ? `${status.episodes} เทป · รอ rating ${status.pending} · งด ${status.cancelled} · คู่แข่ง ${status.competitors}` : `ERROR ${status.error}`}`);
    for (const p of status.problems || []) console.log(`      ติด: ${p}`);
  }
  if (!episodes.length) return { result: null, episodes, competitors };
  // Tabs without episode names (เงินทองของจริง): named from the day's clips.
  const naming = nameEpisodes(episodes, rows);
  if (naming.named || naming.waiting.length) console.log(`  ชื่อตอนจากคลิป: ${naming.named} เทป · ยังไม่มีคลิปของวันนั้น ${naming.waiting.length}${naming.waiting.length ? ` (${naming.waiting.slice(-5).join(", ")})` : ""}`);
  const merged = mergeTvEpisodes(rows, episodes);
  const lines = merged.updated.map((u) => ({ key: u.key, before: JSON.stringify(u.before), after: JSON.stringify(u.after) }));
  fs.writeFileSync(path.join(outDir, "tv-updated.csv"), csvText(lines, ["key", "before", "after"]));
  fs.writeFileSync(path.join(outDir, "tv-summary.json"), JSON.stringify({ sources: tvStatus, updated: merged.updated.length, inserted: merged.inserted.map((r) => `${r.Date} ${r.Channel}`), mergedCopies: merged.removed.length, conflicts: merged.conflicts, audienceFixed: merged.audienceFixed }, null, 2));
  console.log(`  TV merge: อัปเดต ${merged.updated.length} เทป · ใหม่ ${merged.inserted.length} · รวมแถวซ้ำ ${merged.removed.length} · rating ไม่ตรงกัน ${merged.conflicts.length}`);
  return { result: merged, episodes, competitors };
}

function csvText(rows, cols) {
  return "\uFEFF" + [cols.join(","), ...rows.map((r) => cols.map((c) => `"${String(r[c] ?? "").replaceAll('"', '""')}"`).join(","))].join("\n");
}

// Competitor ratings, one document per source (read by the dashboard later).
async function writeCompetitors(fsdb, list) {
  for (const { source, rows } of list) {
    try {
      await fsdb.set(`tvCompetitors/${source.id}`, encodeFields({
        sourceId: source.id, name: source.name, program: source.program, channel: source.channel,
        updatedAt: new Date().toISOString(), rowCount: rows.length, rows,
      }));
    } catch (e) {
      console.error(`competitors ${source.name}: ${e.message}`);
    }
  }
}

// Per-platform health for the status line: fetched without error, newest post day.
function platformStatus() {
  const map = { facebook: "Facebook", fbreels: "Facebook", instagram: "Instagram", reels: "Instagram", tiktok: "TikTok", "tiktok-api": "TikTok", youtube: "YouTube", "youtube-data-api": "YouTube" };
  const out = {};
  for (const st of fetchStats) {
    const p = map[st.network];
    if (!p) continue;
    out[p] ||= { ok: true, latestPost: "" };
    // A brand without that network connected is not a failure.
    if (st.error && !/no \w+ connection for blog/i.test(st.error)) {
      out[p].ok = false;
      out[p].error = String(st.error).slice(0, 200);
    }
  }
  for (const r of incoming) {
    const p = String(r.Platform);
    const d = excelDate(r.Date);
    if (out[p] && d > out[p].latestPost) out[p].latestPost = d;
  }
  return out;
}

function baseReport(status) {
  return {
    runId, status, trigger, startedAt, finishedAt: "",
    window: { since, until }, message: "", platforms: {}, sources: fetchStats, tvSources: tvStatus,
    integrations: Object.fromEntries(Object.entries(integrations).map(([k, { count, ...s }]) => [k, s])),
    totals: {}, checks: [], timings, ...(githubRunUrl ? { githubRunUrl } : {}),
  };
}

// Email to the admins listed in syncConfig/notifications (via Apps Script).
// A mail problem is recorded on the report and never fails the sync.
async function notifyRun(report, { force = false } = {}) {
  const url = process.env.NOTIFY_WEBHOOK_URL;
  const secret = process.env.NOTIFY_TOKEN;
  try {
    const doc = await (await firestore()).get("syncConfig/notifications");
    const cfg = doc ? decodeFields(doc.fields || {}) : {};
    const to = cleanRecipients(cfg.emails);
    const mode = cfg.mode || "always";
    if (!to.length || (!force && !shouldNotify(mode, report.status, integrationProblems(report).length > 0))) return;
    if (!url || !secret) {
      report.notify = { ok: false, at: new Date().toISOString(), to: to.length, error: "ยังไม่ได้ตั้งค่า NOTIFY_WEBHOOK_URL / NOTIFY_TOKEN" };
      return;
    }
    const result = await sendEmail(url, secret, to, buildEmail(report));
    report.notify = { ok: result.ok, at: new Date().toISOString(), to: to.length, ...(result.error ? { error: result.error } : {}) };
    console.log(`email: ${result.ok ? `sent to ${to.length}` : `failed ${result.error}`}`);
  } catch (e) {
    report.notify = { ok: false, at: new Date().toISOString(), to: 0, error: String(e.message || e).slice(0, 200) };
  }
}

function finish(report) {
  report.finishedAt = new Date().toISOString();
  report.platforms = platformStatus();
  return report;
}

try {
  await main();
} catch (e) {
  console.error(e);
  process.exitCode = 1;
  // In write mode every failure is recorded so admins see it in the dashboard.
  if (write) {
    try {
      const report = finish(baseReport("failed"));
      report.message = `sync ล้มเหลวก่อนเขียนข้อมูล: ${String(e.message || e).slice(0, 300)} (ข้อมูลเดิมไม่ถูกแตะ)`;
      await notifyRun(report);
      await writeRunReport(await firestore(), report);
    } catch (reportError) {
      console.error("could not record the failed run:", reportError);
    }
  }
}
