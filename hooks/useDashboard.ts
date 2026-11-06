"use client";
import { dashboardAsset, isStaticHost } from "@/lib/dashboard/hosting";
import { programMatches } from "@/lib/dashboard/programFilter";
import { autoGrain, tvAudienceTrend, tvEpisodes as episodesOf } from "@/lib/dashboard/tvTrend";
import {
  loadMasterDataFromFirebase,
  saveMasterDataToFirebase,
} from "@/lib/firebase";
import { bestFormat, sumBy, topicSimilarity } from "@/lib/dashboard/analytics";
import { PROGRAMS } from "@/lib/dashboard/constants";
import { parseCsv } from "@/lib/dashboard/csv";
import { getCompareRange, getDatePresetRange, isoDate } from "@/lib/dashboard/dates";
import { loadDashboardRows } from "@/lib/dashboardCache";
import { matchesSearch, searchTerms } from "@/lib/dashboard/search";
import { recordDownload } from "@/lib/auth/activity";
import { compact, num, pct } from "@/lib/dashboard/format";
import {
  countNonPlainDates,
  n,
  normalize,
  normalizeRowsWithDeduplication,
  sourceDay,
} from "@/lib/dashboard/normalize";
import type {
  CompareFilter,
  CompareRow,
  CompareSortKey,
  ComparePreset,
  DatePreset,
  RawRow,
  RecordRow,
} from "@/lib/dashboard/types";
import { useEffect, useMemo, useRef, useState } from "react";
import { track } from "@/lib/loadingBar";


/** KPI totals for a set of rows; the same rules as the `metrics` memo. */
function summarize(source: RecordRow[], tvMode: boolean) {
  const digital = source.filter((r) => r.platform !== "TV");
  const perf = tvMode ? source.filter((r) => r.platform === "TV") : digital;
  const tv = source.filter((r) => r.platform === "TV" || r.ratingTotal > 0 || r.gmmRating > 0);
  const one31 = tv.filter((r) => r.ratingTotal > 0);
  const gmm25 = tv.filter((r) => r.gmmRating > 0);
  const digitalViews = digital.reduce((a, r) => a + r.views, 0);
  const views = perf.reduce((a, r) => a + (tvMode ? r.audienceTotal + r.gmmAudience : r.views), 0);
  const engagement = perf.reduce((a, r) => a + r.engagement, 0);
  // Rate over content that has views: photo posts have engagement but no views.
  const viewed = perf.filter((r) => (tvMode ? r.audienceTotal + r.gmmAudience : r.views) > 0);
  const rateEngagement = viewed.reduce((a, r) => a + r.engagement, 0);
  const tvAudience = tv.reduce((a, r) => a + r.audienceTotal + r.gmmAudience, 0);
  return {
    rows: source.length,
    totalCombinedViews: digitalViews + tvAudience,
    views,
    tvAudience,
    ratingOne31: one31.length ? one31.reduce((a, r) => a + r.ratingTotal, 0) / one31.length : 0,
    ratingGmm25: gmm25.length ? gmm25.reduce((a, r) => a + r.gmmRating, 0) / gmm25.length : 0,
    engagement,
    engagementRate: views ? rateEngagement / views : 0,
  };
}

/** Imported rows with each date stored as the plain day written in the file. */
function toPlainDates(raw: RawRow[]): { rows: RawRow[]; unreadable: number } {
  let unreadable = 0;
  const rows = raw.map((r) => {
    const key = ["Date", "date", "Publish Date"].find((k) => r[k] !== undefined && r[k] !== null && r[k] !== "");
    if (!key) return r;
    const day = sourceDay(r[key]);
    if (!day) {
      unreadable++;
      return r;
    }
    return { ...r, [key]: day };
  });
  return { rows, unreadable };
}

const shiftIso = (iso: string, days: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return isoDate(d);
};

/** `enabled`: load data only once someone is signed in (Firestore requires it). */
export function useDashboard(enabled = true) {
  const [rows, setRows] = useState<RecordRow[]>([]),
    [rawRows, setRawRows] = useState<RawRow[]>([]),
    [cloudSaving, setCloudSaving] = useState(false),
    [cloudSaveProgress, setCloudSaveProgress] = useState<{
      current: number;
      total: number;
    } | null>(null),
    [loading, setLoading] = useState(true),
    [menuOpen, setMenuOpen] = useState(false),
    [sourceOpen, setSourceOpen] = useState(false),
    [sheetUrl, setSheetUrl] = useState(""),
    [sourceName, setSourceName] = useState("Firebase Firestore"),
    [uploadedAt, setUploadedAt] = useState(""),
    [message, setMessage] = useState("");
  // Filters: the controls show a choice at once (…Input); the report is worked out
  // from applied copies, set only after the browser has painted the top loading
  // bar (two animation frames). The recalculation can block the page for seconds,
  // and the bar must already be on screen by then (it animates off the main thread).
  const [programInput, setProgram] = useState("ถกไม่เถียง"),
    [platformInput, setPlatform] = useState("ALL"),
    [vdoTypeInput, setVdoType] = useState("ALL"),
    [topicTypeInput, setTopicType] = useState("ALL"),
    [searchInput, setSearch] = useState(""),
    [startDateInput, setStartDate] = useState(""),
    [endDateInput, setEndDate] = useState(""),
    [datePresetInput, setDatePreset] = useState<DatePreset>("LAST_28_DAYS"),
    [compareModeInput, setCompareModeState] = useState<ComparePreset>("PREVIOUS"),
    [compareStartInput, setCompareStart] = useState(""),
    [compareEndInput, setCompareEnd] = useState("");
  const inputs = {
    program: programInput,
    platform: platformInput,
    vdoType: vdoTypeInput,
    topicType: topicTypeInput,
    search: searchInput,
    startDate: startDateInput,
    endDate: endDateInput,
    datePreset: datePresetInput,
    compareMode: compareModeInput,
    compareStart: compareStartInput,
    compareEnd: compareEndInput,
  };
  const inputsKey = JSON.stringify(inputs);
  const [applied, setApplied] = useState(inputs);
  const appliedKey = JSON.stringify(applied);
  useEffect(() => {
    if (inputsKey === appliedKey) return;
    const next = JSON.parse(inputsKey) as typeof inputs;
    let done = false;
    // A plain update, not a transition: a transition can be put off again and
    // again by other updates, leaving the page showing the old numbers. The bar
    // is already painted and keeps moving while this one works.
    const apply = () => {
      if (done) return;
      done = true;
      setApplied(next);
    };
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(apply);
    });
    // Hidden tabs run no animation frames: apply anyway.
    const fallback = setTimeout(apply, 250);
    return () => {
      done = true;
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
      clearTimeout(fallback);
    };
  }, [inputsKey, appliedKey]);
  const { program, platform, vdoType, topicType, search, startDate, endDate, datePreset, compareMode, compareStart, compareEnd } = applied;
  const filtering = inputsKey !== appliedKey;
  // Search box terms (comma = any of them; see lib/dashboard/search.ts).
  const terms = useMemo(() => searchTerms(search), [search]);
  const [topTopicType, setTopTopicType] = useState("ALL");
  const [grain, setGrain] = useState<"day" | "month" | "year">("day");
  const [ratingGrain, setRatingGrain] = useState<"day" | "month" | "year">("day");
  const fileRef = useRef<HTMLInputElement>(null);
  const [executiveChartType, setExecutiveChartType] = useState<"line" | "bar" | "area" | "pct">(
    "line",
  );
  const [comparePage, setComparePage] = useState(1),
    [comparePageSize, setComparePageSize] = useState(20),
    [compareSort, setCompareSort] = useState<CompareSortKey>("date"),
    [compareDirection, setCompareDirection] = useState<"asc" | "desc">("desc"),
    [compareFilter, setCompareFilter] = useState<CompareFilter>("all");
  useEffect(() => {
    if (!enabled) return;
    async function initDashboardData() {
      setLoading(true);
      try {
        if (!isStaticHost) {
          // Compact copy / this browser when they match masterData, else masterData itself.
          // One more try after a moment: right after a first sign-in the server may
          // not have the new profile yet and refuses the first read.
          let cloudResult = await track(loadDashboardRows()).catch(() => null);
          if (!cloudResult || !cloudResult.rows.length) {
            await new Promise((r) => setTimeout(r, 2500));
            cloudResult = await track(loadDashboardRows()).catch(() => null);
          }
          if (cloudResult && cloudResult.rows.length > 0) {
            setRawRows(cloudResult.rows);
            const nonPlain = countNonPlainDates(cloudResult.rows);
            if (nonPlain) {
              setMessage(`⚠️ พบ ${num(nonPlain)} แถวที่วันที่ไม่ใช่รูปแบบ YYYY-MM-DD ในข้อมูล Cloud วันที่ของแถวเหล่านี้อาจคลาดเคลื่อน กรุณาแจ้งผู้ดูแลระบบ`);
            }
            const x = normalizeRowsWithDeduplication(cloudResult.rows);
            setRows(x);
            const d = x.map((r) => r.date).filter(Boolean).sort();
            const latest = d.at(-1) || "";
            if (latest) showDefaultRange();
            setSourceName("Firebase Firestore");
            if (cloudResult.updatedAt) {
              setUploadedAt(cloudResult.updatedAt);
            }
            setLoading(false);
            return;
          }
        }

        // The live site shows Firestore data only: an old file must never stand
        // in for it unnoticed. Only the static (GitHub Pages) build reads a file.
        if (!isStaticHost) {
          setMessage("โหลดข้อมูลจาก Cloud ไม่สำเร็จ กรุณารีเฟรชหน้า หากยังไม่ได้ให้แจ้งผู้ดูแลระบบ");
          setLoading(false);
          return;
        }
        const res = await fetch(dashboardAsset("master-data.json"));
        const lastModifiedHeader = res.headers.get("last-modified");
        const data: RawRow[] = await res.json();
        setRawRows(data);
        const x = normalizeRowsWithDeduplication(data);
        setRows(x);
        const d = x.map((r) => r.date).filter(Boolean).sort();
        const latest = d.at(-1) || "";
        if (latest) showDefaultRange();
        setSourceName(isStaticHost ? "master-data.json" : "Firebase Firestore");
        if (lastModifiedHeader) {
          setUploadedAt(new Date(lastModifiedHeader).toISOString());
        }
        setLoading(false);
      } catch {
        setMessage("โหลดข้อมูลเริ่มต้นไม่สำเร็จ");
        setLoading(false);
      }
    }

    initDashboardData();
  }, [enabled]);
  const options = useMemo(
    () => ({
      programs: [...new Set([...PROGRAMS, ...rows.map((r) => r.program)])]
        .filter(Boolean)
        .sort(),
      platforms: [...new Set(rows.map((r) => r.platform))]
        .filter(Boolean)
        .sort(),
      vdoTypes: [...new Set(rows.map((r) => r.vdoType))].filter(Boolean).sort(),
      topicTypes: [...new Set(rows.map((r) => r.topicType))]
        .filter(Boolean)
        .sort(),
    }),
    [rows],
  );
  const filtered = useMemo(
    () =>
      rows.filter(
        (r) =>
          programMatches(program, r.program) &&
          (platform === "ALL" || r.platform === platform) &&
          (vdoType === "ALL" || r.vdoType === vdoType) &&
          (topicType === "ALL" || r.topicType === topicType) &&
          (!startDate || r.date >= startDate) &&
          (!endDate || r.date <= endDate) &&
          matchesSearch(r, terms),
      ),
    [rows, program, platform, vdoType, topicType, startDate, endDate, terms],
  );
  const executiveRows = useMemo(
    () =>
      rows.filter(
        (r) =>
          programMatches(program, r.program) &&
          (vdoType === "ALL" || r.vdoType === vdoType) &&
          (topicType === "ALL" || r.topicType === topicType) &&
          (!startDate || r.date >= startDate) &&
          (!endDate || r.date <= endDate) &&
          matchesSearch(r, terms),
      ),
    [rows, program, vdoType, topicType, startDate, endDate, terms],
  );
  // Advanced → การเติบโต: the same filters without the date (gains are dated by when they happened).
  const growthRows = useMemo(
    () =>
      rows.filter(
        (r) =>
          r.platform !== "TV" &&
          programMatches(program, r.program) &&
          (platform === "ALL" || r.platform === platform) &&
          (vdoType === "ALL" || r.vdoType === vdoType) &&
          (topicType === "ALL" || r.topicType === topicType) &&
          matchesSearch(r, terms),
      ),
    [rows, program, platform, vdoType, topicType, terms],
  );
  // Daily up to 31 days (e.g. "28 วันล่าสุด", which spans two months); monthly beyond.
  const executiveGrain = useMemo<"day" | "month">(
    () =>
      startDate && endDate && (Date.parse(endDate) - Date.parse(startDate)) / 86400000 + 1 <= 31
        ? "day"
        : "month",
    [startDate, endDate],
  );
  // Per period: views of each digital platform (own key, e.g. "YouTube"), their
  // total ("Digital Views") and "TV Audience". Same rows and rules as before.
  const digitalVsTv = useMemo(() => {
    const m = new Map<string, Record<string, number | string>>();
    executiveRows.forEach((r) => {
      const key = executiveGrain === "day" ? r.date : r.date.slice(0, 7),
        x = m.get(key) || { date: key, "Digital Views": 0, "TV Audience": 0 };
      if (r.platform === "TV") {
        x["TV Audience"] = Number(x["TV Audience"]) + r.audienceTotal + r.gmmAudience;
      } else {
        x["Digital Views"] = Number(x["Digital Views"]) + r.views;
        x[r.platform] = Number(x[r.platform] || 0) + r.views;
      }
      m.set(key, x);
    });
    return [...m.values()]
      .sort((a, b) => String(a.date).localeCompare(String(b.date)))
      .slice(executiveGrain === "day" ? -31 : -24);
  }, [executiveRows, executiveGrain]);
  /** Digital platforms in that chart, biggest first. */
  const digitalPlatforms = useMemo(() => {
    const t = new Map<string, number>();
    executiveRows.forEach((r) => r.platform !== "TV" && t.set(r.platform, (t.get(r.platform) || 0) + r.views));
    return [...t.entries()].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).map(([p]) => p);
  }, [executiveRows]);
  // Views per period by VDO type (TV rows count audience, as in the VDO Type pie).
  // The 6 biggest types get their own series; the rest add up to "อื่นๆ".
  const vdoTypeTrend = useMemo(() => {
    const value = (r: RecordRow) => (r.platform === "TV" ? r.audienceTotal + r.gmmAudience : r.views);
    const totals = new Map<string, number>();
    executiveRows.forEach((r) => totals.set(r.vdoType || "ไม่ระบุ", (totals.get(r.vdoType || "ไม่ระบุ") || 0) + value(r)));
    const ranked = [...totals.entries()].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).map(([t]) => t);
    const top = new Set(ranked.slice(0, 6));
    const keys = [...ranked.slice(0, 6), ...(ranked.length > 6 ? ["อื่นๆ"] : [])];
    const m = new Map<string, Record<string, number | string>>();
    executiveRows.forEach((r) => {
      const key = executiveGrain === "day" ? r.date : r.date.slice(0, 7);
      const t = top.has(r.vdoType || "ไม่ระบุ") ? r.vdoType || "ไม่ระบุ" : "อื่นๆ";
      const x = m.get(key) || { date: key };
      x[t] = Number(x[t] || 0) + value(r);
      m.set(key, x);
    });
    const data = [...m.values()]
      .sort((a, b) => String(a.date).localeCompare(String(b.date)))
      .slice(executiveGrain === "day" ? -31 : -24);
    return { data, keys };
  }, [executiveRows, executiveGrain]);
  const programPie = useMemo(
    () =>
      sumBy(
        executiveRows,
        (r) => r.program,
        (r) =>
          r.platform === "TV" ? r.audienceTotal + r.gmmAudience : r.views,
      )
        .sort((a, b) => b.total - a.total)
        .slice(0, 8),
    [executiveRows],
  );
  const platformPie = useMemo(
    () =>
      sumBy(
        executiveRows,
        (r) => r.platform,
        (r) =>
          r.platform === "TV" ? r.audienceTotal + r.gmmAudience : r.views,
      )
        .sort((a, b) => b.total - a.total)
        .slice(0, 8),
    [executiveRows],
  );
  // Digital views by account / page (Channel), same rows as the other pies here.
  const accountPie = useMemo(
    () =>
      sumBy(
        executiveRows.filter((r) => r.platform !== "TV"),
        (r) => (r.channel && r.channel.trim() !== "-" ? r.channel.trim() : "ไม่ระบุ"),
        (r) => r.views,
      )
        .sort((a, b) => b.total - a.total)
        .slice(0, 8),
    [executiveRows],
  );
  const vdoTypePie = useMemo(
    () =>
      sumBy(
        executiveRows,
        (r) => r.vdoType,
        (r) =>
          r.platform === "TV" ? r.audienceTotal + r.gmmAudience : r.views,
      )
        .sort((a, b) => b.total - a.total)
        .slice(0, 8),
    [executiveRows],
  );
  const digitalFiltered = useMemo(
    () => filtered.filter((r) => r.platform !== "TV"),
    [filtered],
  );
  const tvMode = platform === "TV";
  const performanceFiltered = useMemo(
    () =>
      tvMode ? filtered.filter((r) => r.platform === "TV") : digitalFiltered,
    [tvMode, filtered, digitalFiltered],
  );
  const performanceValue = (r: RecordRow) =>
    tvMode ? r.audienceTotal + r.gmmAudience : r.views;
  const metrics = useMemo(() => {
    const digitalViews = digitalFiltered.reduce((a, r) => a + r.views, 0),
      views = performanceFiltered.reduce(
        (a, r) => a + (tvMode ? r.audienceTotal + r.gmmAudience : r.views),
        0,
      ),
      engagement = performanceFiltered.reduce((a, r) => a + r.engagement, 0),
      // Rate over content that has views: photo posts have engagement but no views.
      rateEngagement = performanceFiltered
        .filter((r) => (tvMode ? r.audienceTotal + r.gmmAudience : r.views) > 0)
        .reduce((a, r) => a + r.engagement, 0),
      likes = performanceFiltered.reduce((a, r) => a + r.likes, 0),
      comments = performanceFiltered.reduce((a, r) => a + r.comments, 0),
      shares = performanceFiltered.reduce((a, r) => a + r.shares, 0),
      uploads = performanceFiltered.reduce((a, r) => a + r.uploadCount, 0),
      tvRows = filtered.filter((r) => r.platform === "TV" || r.ratingTotal > 0 || r.gmmRating > 0),
      one31Rows = tvRows.filter((r) => r.ratingTotal > 0),
      gmm25Rows = tvRows.filter((r) => r.gmmRating > 0),
      ratingAvgOne31 = one31Rows.length
        ? one31Rows.reduce((a, r) => a + r.ratingTotal, 0) / one31Rows.length
        : 0,
      ratingAvgGmm25 = gmm25Rows.length
        ? gmm25Rows.reduce((a, r) => a + r.gmmRating, 0) / gmm25Rows.length
        : 0,
      ratingAvg = tvRows.length
        ? tvRows.reduce((a, r) => a + r.ratingTotal, 0) / tvRows.length
        : 0,
      tvAudience = tvRows.reduce(
        (a, r) => a + r.audienceTotal + r.gmmAudience,
        0,
      ),
      totalCombinedViews = digitalViews + tvAudience,
      one31Episodes = one31Rows.length,
      gmm25Episodes = gmm25Rows.length,
      tvEpisodes = one31Episodes + gmm25Episodes,
      tvBroadcastDays = tvRows.length,
      days = new Set(performanceFiltered.map((r) => r.date)).size || 1,
      sortedDates = [...new Set(performanceFiltered.map((r) => r.date).filter(Boolean))].sort(),
      latestDate = sortedDates.at(-1) || "",
      latestDayRows = latestDate ? performanceFiltered.filter((r) => r.date === latestDate) : [],
      latestUploads = latestDayRows.reduce((a, r) => a + r.uploadCount, 0),
      latestUploadByPlatform = [...sumBy(latestDayRows, (r) => r.platform, (r) => r.uploadCount)]
        .filter((x) => x.total > 0)
        .sort((a, b) => b.total - a.total),
      uploadByPlatform = [...sumBy(performanceFiltered, (r) => r.platform, (r) => r.uploadCount)]
        .sort((a, b) => b.total - a.total),
      digitalViewsByPlatform = [...sumBy(digitalFiltered, (r) => r.platform, (r) => r.views)]
        .filter((x) => x.total > 0)
        .sort((a, b) => b.total - a.total),
      digitalContentByPlatform = [...sumBy(digitalFiltered, (r) => r.platform, () => 1)]
        .sort((a, b) => b.total - a.total);
    return {
      views,
      digitalViews,
      totalCombinedViews,
      engagement,
      likes,
      comments,
      shares,
      uploads,
      latestDate,
      latestUploads,
      latestUploadByPlatform,
      uploadByPlatform,
      digitalViewsByPlatform,
      digitalContentByPlatform,
      ratingAvg,
      ratingAvgOne31,
      ratingAvgGmm25,
      one31Episodes,
      gmm25Episodes,
      tvBroadcastDays,
      tvAudience,
      tvEpisodes,
      tvAudienceAvg: tvEpisodes ? tvAudience / tvEpisodes : 0,
      engagementRate: views ? rateEngagement / views : 0,
      avgDaily: views / days,
    };
  }, [performanceFiltered, filtered, digitalFiltered, tvMode]);
  const chartGrain = useMemo<"day" | "month" | "year">(
    () =>
      tvMode
        ? startDate && endDate && startDate.slice(0, 7) === endDate.slice(0, 7)
          ? "day"
          : "month"
        : grain,
    [tvMode, startDate, endDate, grain],
  );
  const daily = useMemo(() => {
    const m = new Map<string, Record<string, number | string | string[]>>();
    performanceFiltered.forEach((r) => {
      const key =
        chartGrain === "year"
          ? r.date.slice(0, 4)
          : chartGrain === "month"
            ? r.date.slice(0, 7)
            : r.date;
      const x = m.get(key) || { date: key, topics: [] };
      const series = tvMode ? "TV Audience" : r.vdoType;
      x[series] =
        n(x[series]) + (tvMode ? r.audienceTotal + r.gmmAudience : r.views);
      const topicList = x.topics as string[];
      if (r.topic && !topicList.includes(r.topic)) topicList.push(r.topic);
      m.set(key, x);
    });
    return [...m.values()]
      .sort((a, b) => String(a.date).localeCompare(String(b.date)))
      .slice(chartGrain === "day" ? -31 : -24);
  }, [performanceFiltered, chartGrain, tvMode]);
  const types = useMemo(
    () =>
      sumBy(
        performanceFiltered,
        (r) => (tvMode ? "TV Audience" : r.vdoType),
        (r) => (tvMode ? r.audienceTotal + r.gmmAudience : r.views),
      )
        .sort((a, b) => b.total - a.total)
        .slice(0, 7),
    [performanceFiltered, tvMode],
  );
  const topics = useMemo(
    () =>
      sumBy(
        performanceFiltered,
        (r) => r.topicType,
        (r) => (tvMode ? r.audienceTotal + r.gmmAudience : r.views),
      )
        .sort((a, b) => b.total - a.total)
        .slice(0, 10),
    [performanceFiltered, tvMode],
  );
  const platforms = useMemo(() => {
    // When platform filter is TV, show TV. When ALL or other, show digital platforms sorted by views, then TV at the end.
    if (platform === "TV") {
      const tvRows = filtered.filter((r) => r.platform === "TV");
      const dates = tvRows.map((r) => r.date).filter(Boolean).sort();
      const total = tvRows.reduce((a, r) => a + r.audienceTotal + r.gmmAudience, 0);
      return [
        {
          name: "TV",
          total,
          latestDate: dates.at(-1) || "",
        },
      ];
    }

    const digitalSums = sumBy(
      digitalFiltered,
      (r) => r.platform,
      (r) => r.views,
    ).sort((a, b) => b.total - a.total);

    const digitalList = digitalSums.map((p) => {
      const dates = digitalFiltered
        .filter((r) => r.platform === p.name && r.date)
        .map((r) => r.date)
        .sort();
      return {
        ...p,
        latestDate: dates.at(-1) || "",
      };
    });

    if (platform === "ALL") {
      const tvRows = filtered.filter((r) => r.platform === "TV");
      if (tvRows.length > 0) {
        const tvDates = tvRows.map((r) => r.date).filter(Boolean).sort();
        const tvTotal = tvRows.reduce((a, r) => a + r.audienceTotal + r.gmmAudience, 0);
        digitalList.push({
          name: "TV",
          total: tvTotal,
          latestDate: tvDates.at(-1) || "",
        });
      }
    }

    return digitalList;
  }, [digitalFiltered, filtered, platform]);
  // Denominator for platform shares: the list can include TV next to the
  // digital platforms, so digital views alone would push shares past 100%.
  const platformTotal = useMemo(
    () => platforms.reduce((a, p) => a + p.total, 0),
    [platforms],
  );
  const programs = useMemo(
    () =>
      sumBy(
        performanceFiltered,
        (r) => r.program,
        (r) => (tvMode ? r.audienceTotal + r.gmmAudience : r.views),
      ).sort((a, b) => b.total - a.total),
    [performanceFiltered, tvMode],
  );
  const topSource = useMemo(
    () =>
      topicType === "ALL" && topTopicType !== "ALL"
        ? performanceFiltered.filter((r) => r.topicType === topTopicType)
        : performanceFiltered,
    [performanceFiltered, topicType, topTopicType],
  );
  const top = useMemo(
    () =>
      [...topSource]
        .sort(
          (a, b) =>
            (tvMode ? b.audienceTotal + b.gmmAudience : b.views) -
            (tvMode ? a.audienceTotal + a.gmmAudience : a.views),
        )
        .slice(0, 10),
    [topSource, tvMode],
  );
  const best = useMemo(
    () =>
      [...performanceFiltered]
        .filter((r) => (tvMode ? r.audienceTotal + r.gmmAudience : r.views) > 0)
        .sort(
          (a, b) =>
            (tvMode ? b.audienceTotal + b.gmmAudience : b.views) -
            (tvMode ? a.audienceTotal + a.gmmAudience : a.views),
        )
        .slice(0, 5),
    [performanceFiltered, tvMode],
  );
  // TV Overview: a range longer than a month opens month by month (the buttons still switch).
  useEffect(() => setRatingGrain(autoGrain(startDate, endDate)), [startDate, endDate]);
  const rating = useMemo(() => {
    const m = new Map<
      string,
      {
        date: string;
        total: number;
        bkk: number;
        urban: number;
        bu: number;
        rural: number;
        count: number;
      }
    >();
    // Averages only over broadcasts that have a rating; a pending (0) row
    // would otherwise pull the average down.
    filtered
      .filter((r) => r.ratingTotal > 0)
      .forEach((r) => {
        const key =
          ratingGrain === "year"
            ? r.date.slice(0, 4)
            : ratingGrain === "month"
              ? r.date.slice(0, 7)
              : r.date;
        const x = m.get(key) || {
          date: key,
          total: 0,
          bkk: 0,
          urban: 0,
          bu: 0,
          rural: 0,
          count: 0,
        };
        x.total += r.ratingTotal;
        x.bkk += r.ratingBkk;
        x.urban += r.ratingUrban;
        x.bu += r.ratingBkkUrban;
        x.rural += r.ratingRural;
        x.count++;
        m.set(key, x);
      });
    return [...m.values()]
      .sort((a, b) => a.date.localeCompare(b.date))
      .slice(ratingGrain === "day" ? -31 : -24)
      .map((x) => ({
        date: x.date,
        Total: x.count ? x.total / x.count : 0,
        "15+BKK": x.count ? x.bkk / x.count : 0,
        "15+URBAN": x.count ? x.urban / x.count : 0,
        "15+BKK&URBAN": x.count ? x.bu / x.count : 0,
        "15+RURAL": x.count ? x.rural / x.count : 0,
      }));
  }, [filtered, ratingGrain]);
  // Same grain as TV Rating Score; a month or year point = average audience per episode.
  const tvAudience = useMemo(() => tvAudienceTrend(filtered, ratingGrain), [filtered, ratingGrain]);
  const tvRatingBreakdown = useMemo(() => {
    const m = new Map<string, { program: string; channel: string; rating: number; audience: number; episodes: number }>();
    // Each merged TV row carries both channels; split them back so every line
    // pairs a channel's rating with that channel's own audience.
    const add = (program: string, channel: string, rating: number, audience: number) => {
      if (rating <= 0 && audience <= 0) return;
      const key = `${program}|${channel}`;
      const x = m.get(key) || { program, channel, rating: 0, audience: 0, episodes: 0 };
      x.rating += rating;
      x.audience += audience;
      x.episodes += 1;
      m.set(key, x);
    };
    filtered.filter((r) => r.platform === "TV" || r.ratingTotal > 0).forEach((r) => {
      add(r.program, "One31", r.ratingTotal, r.audienceTotal);
      add(r.program, "GMM25", r.gmmRating, r.gmmAudience);
    });
    return [...m.values()].map((x) => ({ ...x, rating: x.episodes ? x.rating / x.episodes : 0 })).sort((a, b) => b.audience - a.audience);
  }, [filtered]);
  // TV Rating รายเทป: every episode in the date filter, newest first.
  const tvEpisodes = useMemo(() => episodesOf(filtered), [filtered]);

  const compare = useMemo(() => {
    type Cluster = Omit<CompareRow, "tvAudience" | "online" | "total" | "posts"> & {
      posts: RecordRow[];
      matchTopic: string;
    };
    const byDate = new Map<string, RecordRow[]>();
    filtered.forEach((r) =>
      byDate.set(r.date, [...(byDate.get(r.date) || []), r]),
    );
    const result: CompareRow[] = [];
    const addMetrics = (x: Cluster, r: RecordRow) => {
      if (r.platform === "TV") {
        x.one = r.ratingTotal;
        x.gmm = r.gmmRating;
        x.oneAudience += r.audienceTotal;
        x.gmmAudience += r.gmmAudience;
        x.hasTv = true;
        if (r.topic) {
          x.topic = r.topic;
          x.matchTopic = r.topic;
        }
        if (r.channel) x.page = r.channel;
      } else {
        x.posts.push(r);
        if (r.platform === "YouTube") x.youtube += r.views;
        else if (r.platform === "Facebook" || r.platform === "Instagram") x.facebook += r.views;
        else if (r.platform === "TikTok") x.tiktok += r.views;
      }
      x.engagement += r.engagement;
    };
    for (const [date, dateRows] of byDate) {
      const clusters: Cluster[] = [];
      const ordered = [...dateRows].sort(
        (a, b) =>
          (a.platform === "TV" ? -1 : 1) - (b.platform === "TV" ? -1 : 1),
      );
      for (const r of ordered) {
        const meaningfulProgram =
          r.program && r.program !== "ไม่ระบุ" && r.program !== "ไม่ระบุรายการ";
        let target = meaningfulProgram
          ? clusters.find((x) => x.hasTv && x.program === r.program)
          : undefined;
        if (!target) {
          let best: Cluster | undefined,
            bestScore = 0;
          for (const x of clusters) {
            if (meaningfulProgram && x.program !== r.program) continue;
            const score = topicSimilarity(r.topic || r.episodeId, x.matchTopic);
            if (score > bestScore) {
              best = x;
              bestScore = score;
            }
          }
          if (best && bestScore >= 0.24) target = best;
        }
        if (!target) {
          target = {
            date,
            topic: r.topic || r.episodeId,
            matchTopic: r.topic || r.episodeId,
            program: r.program,
            one: 0,
            gmm: 0,
            oneAudience: 0,
            gmmAudience: 0,
            youtube: 0,
            facebook: 0,
            tiktok: 0,
            engagement: 0,
            page: r.channel,
            hasTv: false,
            posts: [],
          };
          clusters.push(target);
        }
        addMetrics(target, r);
      }
      result.push(
        ...clusters.map(({ matchTopic: _, ...row }) => {
          const tvAudience = row.oneAudience + row.gmmAudience;
          const online = row.youtube + row.facebook + row.tiktok;
          return { ...row, tvAudience, online, total: tvAudience + online };
        }),
      );
    }
    return result;
  }, [filtered]);
  const compareSorted = useMemo(
    () =>
      compare
        .filter((r) => compareFilter === "all" || (compareFilter === "tv") === r.hasTv)
        .sort((a, b) => {
        const av = a[compareSort],
          bv = b[compareSort];
        const result =
          typeof av === "number" && typeof bv === "number"
            ? av - bv
            : String(av).localeCompare(String(bv), "th");
        return compareDirection === "asc" ? result : -result;
      }),
    [compare, compareFilter, compareSort, compareDirection],
  );
  // Footer totals for everything the filters keep, not just the visible page.
  const compareTotals = useMemo(() => {
    const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
    const sum = (key: "tvAudience" | "youtube" | "facebook" | "tiktok" | "online" | "total" | "engagement") =>
      compareSorted.reduce((a, r) => a + r[key], 0);
    return {
      count: compareSorted.length,
      tvCount: compareSorted.filter((r) => r.hasTv).length,
      one: avg(compareSorted.filter((r) => r.one > 0).map((r) => r.one)),
      gmm: avg(compareSorted.filter((r) => r.gmm > 0).map((r) => r.gmm)),
      tvAudience: sum("tvAudience"),
      youtube: sum("youtube"),
      facebook: sum("facebook"),
      tiktok: sum("tiktok"),
      online: sum("online"),
      total: sum("total"),
      engagement: sum("engagement"),
    };
  }, [compareSorted]);
  const comparePageCount = Math.max(
    1,
    Math.ceil(compareSorted.length / comparePageSize),
  );
  const compareRows = useMemo(
    () =>
      compareSorted.slice(
        (comparePage - 1) * comparePageSize,
        comparePage * comparePageSize,
      ),
    [compareSorted, comparePage, comparePageSize],
  );
  useEffect(
    () => setComparePage(1),
    [
      program,
      platform,
      vdoType,
      topicType,
      startDate,
      endDate,
      search,
      comparePageSize,
      compareFilter,
    ],
  );
  useEffect(() => {
    if (comparePage > comparePageCount) setComparePage(comparePageCount);
  }, [comparePage, comparePageCount]);
  function sortCompare(key: CompareSortKey) {
    if (compareSort === key)
      setCompareDirection((x) => (x === "asc" ? "desc" : "asc"));
    else {
      setCompareSort(key);
      setCompareDirection(
        key === "date" || typeof compare[0]?.[key] === "number"
          ? "desc"
          : "asc",
      );
    }
    setComparePage(1);
  }
  const platformAnalysis = useMemo(
    () =>
      [...new Set(digitalFiltered.map((r) => r.platform))]
        .map((name) => {
          const items = digitalFiltered.filter(
              (r) => r.platform === name && r.views > 0,
            ),
            top = [...items].sort((a, b) => b.views - a.views)[0],
            format = bestFormat(items),
            topic = sumBy(
              items,
              (r) => r.topicType,
              (r) => r.views,
            ).sort((a, b) => b.total - a.total)[0];
          return { name, top, format, topic: topic?.name || "ข้อมูลยังไม่พอ" };
        })
        .filter((x) => x.top)
        .sort((a, b) => (b.top?.views || 0) - (a.top?.views || 0)),
    [digitalFiltered],
  );
  const provinceRating = useMemo(() => {
    const tv = filtered.filter((r) => r.ratingTotal > 0);
    const count = tv.length || 1;
    const totals = [
      {
        zone: "15+BKK",
        rating: tv.length ? tv.reduce((a, r) => a + r.ratingBkk, 0) / count : 0,
        source: "15+BKK",
      },
      {
        zone: "15+BKK&URBAN",
        rating: tv.length ? tv.reduce((a, r) => a + r.ratingBkkUrban, 0) / count : 0,
        source: "15+BKK&URBAN",
      },
      {
        zone: "15+URBAN",
        rating: tv.length ? tv.reduce((a, r) => a + r.ratingUrban, 0) / count : 0,
        source: "15+URBAN",
      },
      {
        zone: "15+RURAL",
        rating: tv.length ? tv.reduce((a, r) => a + r.ratingRural, 0) / count : 0,
        source: "15+RURAL",
      },
    ];
    return totals;
  }, [filtered]);
  // Trend windows (30 vs previous 30 days, last 90 days) look back past the
  // selected start date, so they use every filter except the start date.
  // Otherwise the previous window is always empty and growth reads +100%.
  const trendRows = useMemo(
    () =>
      rows.filter(
        (r) =>
          r.platform !== "TV" &&
          r.date &&
          programMatches(program, r.program) &&
          (platform === "ALL" || r.platform === platform) &&
          (vdoType === "ALL" || r.vdoType === vdoType) &&
          (topicType === "ALL" || r.topicType === topicType) &&
          (!endDate || r.date <= endDate) &&
          matchesSearch(r, terms),
      ),
    [rows, program, platform, vdoType, topicType, endDate, terms],
  );
  // Ranking picks its own day/week, so it gets every filter except dates.
  const rankingRows = useMemo(
    () =>
      rows.filter(
        (r) =>
          r.date &&
          programMatches(program, r.program) &&
          (platform === "ALL" || r.platform === platform) &&
          (vdoType === "ALL" || r.vdoType === vdoType) &&
          (topicType === "ALL" || r.topicType === topicType) &&
          matchesSearch(r, terms),
      ),
    [rows, program, platform, vdoType, topicType, terms],
  );
  // รายงานรวมแพลตฟอร์ม: the filters except platform and date (the page shows every platform; the range and the comparison come from the dates).
  const platformReportRows = useMemo(
    () =>
      rows.filter(
        (r) =>
          r.date &&
          programMatches(program, r.program) &&
          (vdoType === "ALL" || r.vdoType === vdoType) &&
          (topicType === "ALL" || r.topicType === topicType) &&
          matchesSearch(r, terms),
      ),
    [rows, program, vdoType, topicType, terms],
  );
  // รวมรายการ: the filters except program and date (every program side by side; the range comes from the dates).
  const programReportRows = useMemo(
    () =>
      rows.filter(
        (r) =>
          r.date &&
          (platform === "ALL" || r.platform === platform) &&
          (vdoType === "ALL" || r.vdoType === vdoType) &&
          (topicType === "ALL" || r.topicType === topicType) &&
          matchesSearch(r, terms),
      ),
    [rows, platform, vdoType, topicType, terms],
  );
  const dataLatestDate = useMemo(
    () => rows.reduce((max, r) => (r.date > max ? r.date : max), ""),
    [rows],
  );
  const dataFirstDate = useMemo(
    () => rows.reduce((m, r) => (r.date && (!m || r.date < m) ? r.date : m), ""),
    [rows],
  );
  // % change on the KPI cards: the selected range against the chosen
  // comparison (default: the period of the same length right before it).
  const comparePeriod = useMemo(
    () => getCompareRange(startDate, endDate, compareMode, { start: compareStart, end: compareEnd }),
    [startDate, endDate, compareMode, compareStart, compareEnd],
  );
  const growth = useMemo(() => {
    if (!comparePeriod) return null;
    const prev = summarize(
      rankingRows.filter((r) => r.date >= comparePeriod.start && r.date <= comparePeriod.end),
      tvMode,
    );
    if (!prev.rows) return null;
    const cur = summarize(filtered, tvMode);
    const pctChange = (now: number, before: number) =>
      before > 0 ? (now - before) / before : null;
    return {
      totalCombinedViews: pctChange(cur.totalCombinedViews, prev.totalCombinedViews),
      views: pctChange(cur.views, prev.views),
      tvAudience: pctChange(cur.tvAudience, prev.tvAudience),
      ratingOne31: pctChange(cur.ratingOne31, prev.ratingOne31),
      ratingGmm25: pctChange(cur.ratingGmm25, prev.ratingGmm25),
      engagement: pctChange(cur.engagement, prev.engagement),
      engagementRate: pctChange(cur.engagementRate, prev.engagementRate),
    };
  }, [comparePeriod, rankingRows, filtered, tvMode]);
  const trendEnd = useMemo(
    () =>
      digitalFiltered
        .map((r) => r.date)
        .filter(Boolean)
        .sort()
        .at(-1) || "",
    [digitalFiltered],
  );
  const topicTrend = useMemo(() => {
    if (!trendEnd) return [];
    const end = new Date(`${trendEnd}T00:00:00Z`),
      recentStart = new Date(end);
    recentStart.setUTCDate(recentStart.getUTCDate() - 29);
    const previousStart = new Date(recentStart);
    previousStart.setUTCDate(previousStart.getUTCDate() - 30);
    const rs = isoDate(recentStart),
      ps = isoDate(previousStart);
    const grouped = new Map<
      string,
      { name: string; recent: number; previous: number }
    >();
    trendRows.forEach((r) => {
      if (r.date > trendEnd || r.date < ps) return;
      const x = grouped.get(r.topicType) || {
        name: r.topicType,
        recent: 0,
        previous: 0,
      };
      if (r.date >= rs) x.recent += r.views;
      else x.previous += r.views;
      grouped.set(r.topicType, x);
    });
    return [...grouped.values()]
      .filter((x) => x.recent > 0)
      .map((x) => ({
        ...x,
        // null = no views in the previous 30 days, so no growth rate exists.
        growth: x.previous ? (x.recent - x.previous) / x.previous : null,
      }))
      .sort((a, b) => b.recent - a.recent)
      .slice(0, 5);
  }, [trendRows, trendEnd]);
  const q4Plan = useMemo(() => {
    if (!trendEnd) return { topics: [], formats: [] };
    const start = new Date(`${trendEnd}T00:00:00Z`);
    start.setUTCDate(start.getUTCDate() - 89);
    const recent = trendRows.filter(
      (r) => r.date >= isoDate(start) && r.date <= trendEnd,
    );
    const topics = sumBy(
      recent,
      (r) => r.topicType,
      (r) => r.views,
    )
      .sort((a, b) => b.total - a.total)
      .slice(0, 3);
    const formats = [...new Set(recent.map((r) => r.platform))]
      .map((platform) => ({
        platform,
        format: bestFormat(recent.filter((r) => r.platform === platform)),
      }))
      .filter((x) => x.format)
      .sort((a, b) => (b.format?.avgViews || 0) - (a.format?.avgViews || 0))
      .slice(0, 3);
    return { topics, formats };
  }, [trendRows, trendEnd]);
  const insights = useMemo(() => {
    const t = top[0],
      p = platforms[0],
      e = tvMode
        ? undefined
        : [...performanceFiltered]
            // Over 100% means the source counted engagement from a wider
            // audience than the views (e.g. Facebook posts), so skip those.
            .filter((r) => r.views >= 1000 && r.engagementRate <= 1)
            .sort((a, b) => b.engagementRate - a.engagementRate)[0];
    return [
      t
        ? `${tvMode ? "รายการ TV" : "คลิป"} ยอดสูงสุด “${t.topic.slice(0, 68)}” ทำ ${compact(tvMode ? t.audienceTotal + t.gmmAudience : t.views)} ${tvMode ? "Audience" : "Views"}`
        : "ยังไม่มี Top Content",
      p
        ? `${p.name} คิดเป็น ${platformTotal ? ((p.total / platformTotal) * 100).toFixed(1) : 0}% ของยอดรวมทุกแพลตฟอร์ม`
        : "ยังไม่มีข้อมูลแพลตฟอร์ม",
      e
        ? `Engagement เด่น “${e.topic.slice(0, 58)}” ทำ ${pct(e.engagementRate)} — ควรต่อยอดรูปแบบ ${e.vdoType}`
        : tvMode
          ? "TV Audience แสดงจาก ONE31 + GMM25 โดยไม่คูณ Rating"
          : "ยังไม่มีข้อมูล Engagement เพียงพอ",
    ];
  }, [top, platforms, platformTotal, performanceFiltered, tvMode]);
  function applyRows(imported: RawRow[], name: string, fileTimestamp?: string) {
    // Every import path (Excel, CSV, Google Sheet) stores the day exactly as
    // written in the file, so "บันทึกขึ้น Cloud" keeps raw data = source.
    const { rows: raw, unreadable } = toPlainDates(imported);
    const x = normalizeRowsWithDeduplication(raw);
    if (!x.length) throw new Error("ไม่พบข้อมูลที่มีคอลัมน์ Date");
    setRawRows(raw);
    const d = x.map((r) => r.date).sort();
    setRows(x);
    setStartDate(d[0]);
    setEndDate(d.at(-1) || d[0]);
    setSourceName(name);
    setUploadedAt(fileTimestamp || new Date().toISOString());
    setMessage(
      `นำเข้า ${num(x.length)} แถวเรียบร้อย (สามารถกดบันทึกขึ้น Cloud ได้)` +
        (unreadable ? ` · ⚠️ ${num(unreadable)} แถวอ่านวันที่ไม่ได้ กรุณาตรวจคอลัมน์ Date ในไฟล์` : ""),
    );
    setSourceOpen(false);
  }

  async function saveCurrentDataToCloud(userRole?: string): Promise<{ success: boolean; message: string }> {
    if (userRole !== "admin") {
      const msg = "เฉพาะผู้ดูแลระบบ (Admin) เท่านั้นที่สามารถบันทึกข้อมูลขึ้น Cloud ได้ (กรุณาเข้าสู่ระบบด้วยสิทธิ์ Admin)";
      setMessage(msg);
      throw new Error(msg);
    }

    // Only imported data is saved. Data shown from the Cloud may be the compact
    // dashboard copy (not every column); saving it would strip masterData.
    if (sourceName === "Firebase Firestore") {
      const msg = "ข้อมูลที่แสดงอยู่มาจาก Cloud แล้ว ไม่ต้องบันทึกซ้ำ (นำเข้าไฟล์ก่อน แล้วจึงบันทึกขึ้น Cloud)";
      setMessage(msg);
      throw new Error(msg);
    }
    const dataToSave = rawRows.length > 0 ? rawRows : (rows as unknown as RawRow[]);
    if (!dataToSave.length) {
      const msg = "ไม่มีข้อมูลสำหรับบันทึก";
      setMessage(msg);
      throw new Error(msg);
    }

    setCloudSaving(true);
    setCloudSaveProgress(null);
    setMessage("กำลังบันทึกข้อมูลขึ้น Firebase Firestore...");

    try {
      const result = await saveMasterDataToFirebase(dataToSave, (current, total) => {
        setCloudSaveProgress({ current, total });
      });
      setSourceName("Firebase Firestore");
      setUploadedAt(new Date().toISOString());
      setMessage(result.message);
      return { success: true, message: result.message };
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : "บันทึกข้อมูลขึ้น Cloud ไม่สำเร็จ";
      setMessage(`เกิดข้อผิดพลาด: ${errorMsg}`);
      throw new Error(errorMsg);
    } finally {
      setCloudSaving(false);
      setCloudSaveProgress(null);
    }
  }
  async function loadSheet(): Promise<{ success: boolean; message: string }> {
    setLoading(true);
    setMessage("");
    try {
      const id = sheetUrl.match(/\/spreadsheets\/d\/([\w-]+)/)?.[1],
        gid = sheetUrl.match(/[?&#]gid=(\d+)/)?.[1] || "0";
      const url = id
        ? `https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=${gid}`
        : sheetUrl;
      const r = await fetch(url);
      if (!r.ok) throw new Error("ไม่สามารถเปิด Google Sheet ได้ (โปรดตรวจสอบว่าตั้งค่าแชร์เป็น 'ทุกคนที่มีลิงก์ดูได้' หรือยัง)");
      const text = await r.text();
      const parsed = parseCsv(text);
      if (!parsed || parsed.length === 0) {
        throw new Error("ไม่พบข้อมูลใน Google Sheet ที่ระบุ");
      }
      applyRows(parsed, "Google Sheets");
      const successMsg = `นำเข้า ${num(parsed.length)} แถวจาก Google Sheets สำเร็จ`;
      return { success: true, message: successMsg };
    } catch (e) {
      const err = e instanceof Error ? e.message : "นำเข้าไม่สำเร็จ";
      setMessage(err);
      return { success: false, message: err };
    } finally {
      setLoading(false);
    }
  }
  async function onFile(file?: File): Promise<{ success: boolean; message: string }> {
    if (!file) return { success: false, message: "ไม่ได้เลือกไฟล์" };
    setLoading(true);
    setMessage("");
    try {
      const fileTimestamp = file.lastModified
        ? new Date(file.lastModified).toISOString()
        : new Date().toISOString();

      let parsedRows: RawRow[] = [];

      if (file.name.toLowerCase().endsWith(".csv")) {
        const text = await file.text();
        parsedRows = parseCsv(text);
      } else {
        const XLSX = await import("xlsx");
        // Date cells stay Excel serial numbers: turning them into JS Dates
        // (cellDates) is what saved Bangkok midnight as the previous UTC day.
        const wb = XLSX.read(await file.arrayBuffer(), { type: "array" });
        const shName =
          wb.SheetNames.find((x) => x.toLowerCase().includes("master")) ||
          wb.SheetNames[0];
        const sh = wb.Sheets[shName];
        if (!sh) throw new Error("ไม่พบ Sheet ข้อมูลในไฟล์ Excel");
        parsedRows = XLSX.utils.sheet_to_json(sh, { defval: null }) as RawRow[];
      }

      if (!parsedRows || parsedRows.length === 0) {
        throw new Error("ไฟล์ที่เลือกไม่มีข้อมูล หรือรูปแบบแถวว่างเปล่า");
      }

      applyRows(parsedRows, file.name, fileTimestamp);
      const successMsg = `นำเข้าไฟล์ ${file.name} จำนวน ${num(parsedRows.length)} รายการสำเร็จ`;
      return { success: true, message: successMsg };
    } catch (e) {
      const err = e instanceof Error ? e.message : "อ่านไฟล์ไม่สำเร็จ";
      setMessage(err);
      return { success: false, message: err };
    } finally {
      setLoading(false);
    }
  }
  /** Opening view (and "ล้างตัวกรอง"): the last 28 full days, compared with the 28 before. */
  function showDefaultRange() {
    const [start, end] = getDatePresetRange("LAST_28_DAYS");
    setStartDate(start);
    setEndDate(end);
    setDatePreset("LAST_28_DAYS");
  }
  /** Custom comparison starts from the previous period, so its dates are never empty. */
  function setCompareMode(mode: ComparePreset) {
    if (mode === "CUSTOM" && (!compareStartInput || !compareEndInput)) {
      const prev = getCompareRange(startDateInput, endDateInput, "PREVIOUS");
      if (prev) {
        setCompareStart(prev.start);
        setCompareEnd(prev.end);
      }
    }
    setCompareModeState(mode);
  }
  function applyDatePreset(value: DatePreset) {
    setDatePreset(value);
    if (value === "CUSTOM") return;
    const [start, end] = getDatePresetRange(value, { first: dataFirstDate, last: dataLatestDate });
    setStartDate(start);
    setEndDate(end);
  }
  function download() {
    const h = [
        "Date",
        "Program",
        "Topic",
        "Topic Type",
        "VDO Type",
        "Platform",
        "Channel",
        "Digital Views",
        "Engagement",
        "Engagement Rate",
        "TV Rating Score",
        "Video Link",
      ],
      body = filtered.map((r) => [
        r.date,
        r.program,
        r.topic,
        r.topicType,
        r.vdoType,
        r.platform,
        r.channel,
        r.platform === "TV" ? 0 : r.views,
        r.engagement,
        r.engagementRate,
        r.ratingTotal,
        /^https?:\/\//.test(r.url || "") ? r.url : "",
      ]);
    const esc = (v: unknown) => `"${String(v ?? "").replaceAll('"', '""')}"`;
    const blob = new Blob(
      [[h, ...body].map((r) => r.map(esc).join(",")).join("\n")],
      { type: "text/csv;charset=utf-8" },
    );
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `performance-${startDate}-${endDate}.csv`;
    a.click();
    recordDownload("csv-performance", a.download, body.length);
    URL.revokeObjectURL(a.href);
  }
  function reset() {
    setProgram("ALL");
    setPlatform("ALL");
    setVdoType("ALL");
    setTopicType("ALL");
    setSearch("");
    setCompareMode("PREVIOUS");
    showDefaultRange();
  }
  return {
    rows,
    setRows,
    loading,
    filtering,
    filterInputs: {
      program: programInput,
      platform: platformInput,
      vdoType: vdoTypeInput,
      topicType: topicTypeInput,
      search: searchInput,
      startDate: startDateInput,
      endDate: endDateInput,
      datePreset: datePresetInput,
      compareMode: compareModeInput,
      compareStart: compareStartInput,
      compareEnd: compareEndInput,
    },
    setLoading,
    menuOpen,
    setMenuOpen,
    sourceOpen,
    setSourceOpen,
    sheetUrl,
    setSheetUrl,
    sourceName,
    setSourceName,
    uploadedAt,
    setUploadedAt,
    message,
    setMessage,
    program,
    setProgram,
    platform,
    setPlatform,
    vdoType,
    setVdoType,
    topicType,
    setTopicType,
    search,
    setSearch,
    startDate,
    setStartDate,
    endDate,
    setEndDate,
    datePreset,
    compareMode,
    setCompareMode,
    compareStart,
    setCompareStart,
    compareEnd,
    setCompareEnd,
    dataFirstDate,
    setDatePreset,
    topTopicType,
    setTopTopicType,
    grain,
    setGrain,
    ratingGrain,
    setRatingGrain,
    fileRef,
    executiveChartType,
    setExecutiveChartType,
    comparePage,
    setComparePage,
    comparePageSize,
    setComparePageSize,
    compareSort,
    setCompareSort,
    compareDirection,
    setCompareDirection,
    options,
    filtered,
    executiveRows,
    growthRows,
    executiveGrain,
    digitalVsTv,
    digitalPlatforms,
    vdoTypeTrend,
    programPie,
    platformPie,
    vdoTypePie,
    accountPie,
    digitalFiltered,
    tvMode,
    performanceFiltered,
    performanceValue,
    metrics,
    chartGrain,
    daily,
    types,
    topics,
    platforms,
    platformTotal,
    programs,
    topSource,
    top,
    best,
    rating,
    tvAudience,
    tvRatingBreakdown,
    tvEpisodes,
    compare,
    compareSorted,
    compareTotals,
    compareFilter,
    setCompareFilter,
    comparePageCount,
    compareRows,
    sortCompare,
    platformAnalysis,
    provinceRating,
    topicTrend,
    q4Plan,
    insights,
    rankingRows,
    platformReportRows,
    programReportRows,
    dataLatestDate,
    comparePeriod,
    growth,
    applyRows,
    loadSheet,
    onFile,
    rawRows,
    cloudSaving,
    cloudSaveProgress,
    saveCurrentDataToCloud,
    applyDatePreset,
    download,
    reset,
  };
}
export type DashboardModel = ReturnType<typeof useDashboard>;
