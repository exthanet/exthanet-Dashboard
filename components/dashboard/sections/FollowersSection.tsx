"use client";
// ผู้ติดตาม: every company account and its followers, grouped by platform or by show
// (รายการ), with the total and the online views of the last 12 months from masterData.
// Numbers come from accountStats (the daily sync); an account without an API shows the
// admin's typed number marked "รอตรวจสอบ". Click a card for a popup with its daily
// followers and a link to the account; download the board as CSV.
import { useEffect, useMemo, useState } from "react";
import { Activity, ChartLine, Clapperboard, Clock, Download, ExternalLink, Eye, Heart, MessageCircle, Pencil, PlugZap, Settings, Share2, TrendingDown, TrendingUp, TriangleAlert, Users, X } from "lucide-react";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { RecordRow } from "@/lib/dashboard/types";
import {
  PLATFORM_LABEL,
  SOCIAL_PLATFORMS,
  accountLogo,
  accountPosts,
  accountYears,
  type YearRow,
  accountUrl,
  boardTotal,
  currentFollowers,
  followersOn,
  groupOf,
  shortCount,
  type AccountStat,
  type PostTotals,
  type SocialAccount,
  type SocialPlatform,
} from "@/lib/dashboard/socialAccounts";
import { loadAccountStats, loadSocialAccounts } from "@/lib/socialAccountsData";
import { dateLabel } from "@/lib/dashboard/format";
import { track } from "@/lib/loadingBar";
import { MediaKit } from "@/components/dashboard/sections/MediaKit";

export const PLATFORM_COLOR: Record<SocialPlatform, string> = {
  facebook: "#1877f2",
  instagram: "#d62976",
  tiktok: "#111111",
  youtube: "#ff0000",
  x: "#111111",
  line: "#06c755",
  other: "#5f6b7a",
};
const PENDING = "รอตรวจสอบ";
const VIEW_KEY = "followers-view";
type View = "platform" | "group";

const full = (v: number) => v.toLocaleString("en-US");
const dayTh = (d: string) => (d ? dateLabel(d) : "");
const initials = (name: string) => name.replace(/[^A-Za-z0-9ก-๙]/g, "").slice(0, 4).toUpperCase();

/** The uploaded logo or the brand page's Facebook picture; initials when there is none or it fails to load. */
function Logo({ a }: { a: SocialAccount }) {
  const [failed, setFailed] = useState(false);
  const src = accountLogo(a);
  return src && !failed ? (
    <img src={src} alt="" className="followers-logo" referrerPolicy="no-referrer" onError={() => setFailed(true)} />
  ) : (
    <span className="followers-logo text">{initials(a.name)}</span>
  );
}

/** Where the number on a card comes from: the platform's API, Metricool, both disagreeing, or typed. */
function SourceBadge({ a, stat }: { a: SocialAccount; stat?: AccountStat }) {
  const src = sourceOf(a, stat);
  const s = SOURCE_BADGE[src];
  const detail = [stat?.sources?.api && `API ${full(stat.sources.api.value)} (${dayTh(stat.sources.api.date)})`, stat?.sources?.metricool && `Metricool ${full(stat.sources.metricool.value)} (${dayTh(stat.sources.metricool.date)})`, stat?.check]
    .filter(Boolean)
    .join(" · ");
  return (
    <span className={`followers-src ${src}`} title={detail || s.title}>
      <s.Icon size={11} aria-hidden="true" />
      {s.label}
    </span>
  );
}

export function sourceOf(a: SocialAccount, stat?: AccountStat): keyof typeof SOURCE_BADGE {
  if (a.source === "manual") return "manual";
  if (stat?.check) return "check";
  return stat?.chosen === "api" ? "api" : "metricool";
}

const SOURCE_BADGE = {
  api: { label: "API", title: "ดึงตรงจากแพลตฟอร์ม", Icon: PlugZap },
  metricool: { label: "Metricool", title: "จาก Metricool", Icon: ChartLine },
  check: { label: "ตรวจสอบ", title: "ตัวเลขจาก 2 แหล่งต่างกันเกิน 2%", Icon: TriangleAlert },
  manual: { label: PENDING, title: "ยังไม่ได้ต่อ API · ตัวเลขกรอกโดยผู้ดูแล", Icon: Pencil },
} as const;

/** The account's posts in the last 12 months: posts, views, likes, comments, shares and ER, each with its icon. */
function PostStats({ totals }: { totals: PostTotals | null }) {
  if (!totals) return <span className="followers-stats-row none">ไม่มีข้อมูลโพสต์ (ไม่ได้ sync โพสต์ของบัญชีนี้)</span>;
  const items = [
    { Icon: Clapperboard, label: "โพสต์", value: full(totals.posts) },
    { Icon: Eye, label: "วิว", value: shortCount(totals.views) },
    { Icon: Heart, label: "ไลก์", value: shortCount(totals.likes) },
    { Icon: MessageCircle, label: "คอมเมนต์", value: shortCount(totals.comments) },
    { Icon: Share2, label: "แชร์", value: shortCount(totals.shares) },
    { Icon: Activity, label: "ER", value: totals.er === null ? "–" : `${(totals.er * 100).toFixed(1)}%` },
  ];
  return (
    <span className="followers-stats-row" title={`${full(totals.posts)} โพสต์ใน 12 เดือนล่าสุด`}>
      {items.map(({ Icon, label, value }) => (
        <span key={label}>
          <Icon size={14} aria-hidden="true" />
          <b>{value}</b>
          {label}
        </span>
      ))}
    </span>
  );
}

interface Group {
  key: string;
  label: string;
  total: number;
  accounts: SocialAccount[];
}

/** Groups by platform or by show, the larger first; inside a group the larger account first. */
export function groupAccounts(accounts: SocialAccount[], stats: Record<string, AccountStat>, view: View): Group[] {
  const value = (a: SocialAccount) => currentFollowers(a, stats[a.id])?.value || 0;
  const map = new Map<string, Group>();
  for (const a of accounts) {
    const key = view === "platform" ? a.platform : groupOf(a);
    const label = view === "platform" ? PLATFORM_LABEL[a.platform] : groupOf(a);
    const g = map.get(key) || { key, label, total: 0, accounts: [] };
    g.total += value(a);
    g.accounts.push(a);
    map.set(key, g);
  }
  const groups = [...map.values()];
  for (const g of groups) g.accounts.sort((x, y) => value(y) - value(x));
  // Platforms keep their usual order when equal; shows go by size.
  return groups.sort((x, y) => y.total - x.total || SOCIAL_PLATFORMS.indexOf(x.key as SocialPlatform) - SOCIAL_PLATFORMS.indexOf(y.key as SocialPlatform));
}

export function FollowersSection({ rows, isAdmin, openSettings }: { rows: RecordRow[]; isAdmin: boolean; openSettings?: () => void }) {
  const [accounts, setAccounts] = useState<SocialAccount[] | null>(null);
  const [stats, setStats] = useState<Record<string, AccountStat>>({});
  const [error, setError] = useState("");
  const [picked, setPicked] = useState("");
  const [view, setView] = useState<View>(() => {
    try {
      return localStorage.getItem(VIEW_KEY) === "group" ? "group" : "platform";
    } catch {
      return "platform";
    }
  });
  const pickView = (v: View) => {
    setView(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      /* private window: the choice just isn't kept */
    }
  };

  useEffect(() => {
    track(Promise.all([loadSocialAccounts(), loadAccountStats()]))
      .then(([a, s]) => {
        setAccounts(a);
        setStats(s);
      })
      .catch((e) => setError(String(e?.message || e)));
  }, []);

  const shown = useMemo(() => (accounts || []).filter((a) => a.enabled), [accounts]);
  const groups = useMemo(() => groupAccounts(shown, stats, view), [shown, stats, view]);
  const total = useMemo(() => boardTotal(shown, stats), [shown, stats]);
  const pending = useMemo(() => shown.filter((a) => a.source === "manual"), [shown]);
  const pendingTotal = useMemo(() => boardTotal(pending, stats), [pending, stats]);
  const updated = useMemo(
    () =>
      shown
        .filter((a) => a.source !== "manual")
        .map((a) => stats[a.id]?.latest?.date || "")
        .filter(Boolean)
        .sort()
        .pop() || "",
    [shown, stats],
  );
  // Online views of the posts published in the last 12 months (as the deck's "views / year").
  const views12 = useMemo(() => {
    const days = rows.filter((r) => r.platform !== "TV").map((r) => r.date).sort();
    const last = days[days.length - 1] || "";
    if (!last) return 0;
    const from = new Date(Date.parse(`${last}T00:00:00Z`) - 365 * 86400000).toISOString().slice(0, 10);
    return rows.filter((r) => r.platform !== "TV" && r.date > from && r.date <= last).reduce((a, r) => a + (r.views || 0), 0);
  }, [rows]);

  const lastPostDay = useMemo(() => rows.filter((r) => r.platform !== "TV").map((r) => r.date).sort().pop() || "", [rows]);
  // The cards show the last 12 months (the popup compares calendar years).
  const posts12 = useMemo(() => {
    const from = lastPostDay ? new Date(Date.parse(`${lastPostDay}T00:00:00Z`) - 364 * 86400000).toISOString().slice(0, 10) : "";
    return new Map(shown.map((a) => [a.id, lastPostDay ? accountPosts(a, rows, from, lastPostDay) : null]));
  }, [rows, shown, lastPostDay]);
  const [tab, setTab] = useState<"chart" | "years">("chart");

  const growth = (a: SocialAccount) => {
    const now = currentFollowers(a, stats[a.id]);
    if (!now || a.source === "manual") return null;
    const then = followersOn(stats[a.id], new Date(Date.parse(`${now.date}T00:00:00Z`) - 30 * 86400000).toISOString().slice(0, 10));
    return then === null ? null : now.value - then;
  };
  const pickedAccount = shown.find((a) => a.id === picked);
  const series = useMemo(
    () => (pickedAccount ? Object.entries(stats[pickedAccount.id]?.series || {}).sort().map(([date, value]) => ({ date, value })) : []),
    [pickedAccount, stats],
  );
  const pickedNow = pickedAccount ? currentFollowers(pickedAccount, stats[pickedAccount.id]) : null;
  const pickedGrowth = pickedAccount ? growth(pickedAccount) : null;
  const pickedYears = useMemo(
    () => (pickedAccount ? accountYears(pickedAccount, rows, stats[pickedAccount.id], lastPostDay || new Date().toISOString().slice(0, 10)) : []),
    [pickedAccount, rows, stats, lastPostDay],
  );

  return (
    <article className="panel full followers-board-panel" id="followers">
      <div className="panel-head">
        <div>
          <h2>ผู้ติดตาม</h2>
          <p>ผู้ติดตามของทุกบัญชี · ใช้ตัวเลขจาก API ของแพลตฟอร์มก่อน เทียบกับ Metricool ทุกวัน · “{PENDING}” = บัญชีที่ยังไม่ได้ต่อ API ตัวเลขกรอกโดยผู้ดูแล</p>
        </div>
        <div className="ranking-controls">
          <div className="segmented">
            <button className={view === "platform" ? "active" : ""} onClick={() => pickView("platform")}>
              จัดตามแพลตฟอร์ม
            </button>
            <button className={view === "group" ? "active" : ""} onClick={() => pickView("group")}>
              จัดตามรายการ
            </button>
          </div>
          {isAdmin && openSettings && (
            <button className="tv-add" onClick={openSettings}>
              <Settings size={14} /> ตั้งค่าบัญชี
            </button>
          )}
          <button className="tv-add" onClick={() => downloadCsv(groups, view, stats, growth, posts12)} disabled={!shown.length}>
            <Download size={14} /> ดาวน์โหลด CSV
          </button>
        </div>
      </div>

      {error && <p className="growth-notice warn">โหลดข้อมูลไม่สำเร็จ: {error}</p>}
      {accounts === null && !error && <p className="growth-notice">กำลังโหลด…</p>}
      {accounts && !shown.length && (
        <p className="growth-notice">ยังไม่มีบัญชี{isAdmin ? " · กด “ตั้งค่าบัญชี” แล้วเลือก “เริ่มจากรายการตั้งต้น”" : " · รอผู้ดูแลระบบตั้งค่า"}</p>
      )}

      {shown.length > 0 && (
        <div className="followers-board">
          <div className="followers-hero">
            <div>
              <strong>{shortCount(total)}</strong>
              <span className="followers-total-label">Online platform followers and subscribers</span>
              <small>
                {full(total)} · {shown.length} บัญชี{updated ? ` · ข้อมูลถึง ${dayTh(updated)}` : ""}
                {pending.length ? ` · รวมตัวเลข${PENDING} ${pending.length} บัญชี (${full(pendingTotal)})` : ""}
              </small>
            </div>
            <div className="followers-views">
              Total online view
              <b>{shortCount(views12)} views / year</b>
              <small>วิวของโพสต์ 12 เดือนล่าสุดในระบบ</small>
            </div>
          </div>

          {groups.map((g) => (
            <section key={g.key} className="followers-group">
              <header>
                <span>
                  {view === "platform" && <i className="followers-dot" style={{ background: PLATFORM_COLOR[g.key as SocialPlatform] }} />}
                  {g.label}
                </span>
                <small>
                  {full(g.total)} · {g.accounts.length} บัญชี
                </small>
              </header>
              <div className="followers-grid">
                {g.accounts.map((a) => {
                  const now = currentFollowers(a, stats[a.id]);
                  const gr = growth(a);
                  const problem = a.source !== "manual" && stats[a.id]?.error;
                  return (
                    <div
                      key={a.id}
                      role="button"
                      tabIndex={0}
                      className={`followers-card ${picked === a.id ? "active" : ""}`}
                      onClick={() => (setTab("chart"), setPicked(a.id))}
                      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), (setTab("chart"), setPicked(a.id)))}
                      title={problem || stats[a.id]?.check || ""}
                    >
                      <SourceBadge a={a} stat={stats[a.id]} />
                      {accountUrl(a) && (
                        <a className="followers-open" href={accountUrl(a)} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} aria-label={`เปิด ${a.name} บน ${PLATFORM_LABEL[a.platform]}`}>
                          <ExternalLink size={14} />
                        </a>
                      )}
                      <span className="followers-card-top">
                        <Logo a={a} />
                        <span className="followers-body">
                          <span className="followers-num">
                            <Users size={15} aria-hidden="true" />
                            {now ? full(now.value) : "–"}
                          </span>
                          <span className="followers-name">
                            {view === "group" && (
                              <span className="followers-pill" style={{ background: PLATFORM_COLOR[a.platform] }}>
                                {PLATFORM_LABEL[a.platform]}
                              </span>
                            )}
                            <span className="followers-title">{a.name}</span>
                          </span>
                          <span className="followers-meta">
                            {a.source === "manual" ? (
                              <span className="followers-wait">
                                <Clock size={12} aria-hidden="true" /> กรอกเมื่อ {dayTh(a.manualDate || "")}
                              </span>
                            ) : gr !== null ? (
                              <span className={gr >= 0 ? "up" : "down"}>
                                {gr >= 0 ? <TrendingUp size={12} aria-hidden="true" /> : <TrendingDown size={12} aria-hidden="true" />}
                                {`${gr >= 0 ? "+" : ""}${full(gr)} ใน 30 วัน`}
                              </span>
                            ) : problem ? (
                              <span className="down">ดึงไม่ได้</span>
                            ) : (
                              <span>{now ? dayTh(now.date) : "รอ sync"}</span>
                            )}
                          </span>
                        </span>
                      </span>
                      <PostStats totals={posts12.get(a.id) ?? null} />
                    </div>
                  );
                })}
              </div>
            </section>
          ))}
          <p className="followers-legend">
            <span><PlugZap size={12} /> API = ดึงตรงจากแพลตฟอร์ม</span>
            <span><ChartLine size={12} /> Metricool</span>
            <span><TriangleAlert size={12} /> ตรวจสอบ = 2 แหล่งต่างกันเกิน 2%</span>
            <span><Pencil size={12} /> {PENDING} = กรอกเอง</span>
            <span><ExternalLink size={12} /> เปิดบัญชี</span>
            <span><Eye size={12} /> <Heart size={12} /> <MessageCircle size={12} /> <Share2 size={12} /> <Activity size={12} /> <Clapperboard size={12} /> โพสต์ · วิว · ไลก์ · คอมเมนต์ · แชร์ · ER รวม 12 เดือนล่าสุด</span>
          </p>
        </div>
      )}

      {shown.length > 0 && <MediaKit accounts={shown} stats={stats} rows={rows} total={total} views12={views12} />}

      {pickedAccount && (
        <div className="modal-backdrop" onClick={() => setPicked("")}>
          <section className="source-modal sync-modal followers-popup" onClick={(e) => e.stopPropagation()}>
            <button className="close" onClick={() => setPicked("")} aria-label="ปิด">
              <X size={18} />
            </button>
            <div className="sync-heading">
              <Logo a={pickedAccount} />
              <div>
                <h2>{pickedAccount.name}</h2>
                <p>
                  {PLATFORM_LABEL[pickedAccount.platform]} · {groupOf(pickedAccount)}
                  {pickedAccount.source === "manual" ? ` · ${PENDING} (ยังไม่ได้ต่อ API)` : pickedAccount.source === "youtube" ? " · YouTube API" : " · Metricool"}
                </p>
              </div>
            </div>
            <div className="followers-stats">
              <div>
                ผู้ติดตาม
                <b>{pickedNow ? full(pickedNow.value) : "–"}</b>
                {pickedNow ? dayTh(pickedNow.date) : ""}
              </div>
              {pickedGrowth !== null && (
                <div>
                  เพิ่มขึ้น 30 วัน
                  <b>{`${pickedGrowth >= 0 ? "+" : ""}${full(pickedGrowth)}`}</b>
                </div>
              )}
              {(() => {
                const p = posts12.get(pickedAccount.id);
                return p ? (
                  <div>
                    โพสต์ 12 เดือน
                    <b>{full(p.posts)}</b>
                    วิว {shortCount(p.views)} · ER {p.er === null ? "–" : `${(p.er * 100).toFixed(1)}%`}
                  </div>
                ) : null;
              })()}
              {(stats[pickedAccount.id]?.sources?.api || stats[pickedAccount.id]?.sources?.metricool) && (
                <div>
                  แหล่งข้อมูล
                  <b>{sourceOf(pickedAccount, stats[pickedAccount.id]) === "api" ? "API" : sourceOf(pickedAccount, stats[pickedAccount.id]) === "check" ? "ตรวจสอบ" : "Metricool"}</b>
                  {stats[pickedAccount.id]?.sources?.api && `API ${full(stats[pickedAccount.id]!.sources!.api!.value)}`}
                  {stats[pickedAccount.id]?.sources?.api && stats[pickedAccount.id]?.sources?.metricool && " · "}
                  {stats[pickedAccount.id]?.sources?.metricool && `Metricool ${full(stats[pickedAccount.id]!.sources!.metricool!.value)}`}
                </div>
              )}
              {series.length > 1 && (
                <div>
                  ข้อมูลย้อนหลัง
                  <b>{full(series.length)} วัน</b>
                  ตั้งแต่ {dayTh(series[0].date)}
                </div>
              )}
            </div>
            {stats[pickedAccount.id]?.check && <p className="growth-notice warn">{stats[pickedAccount.id]!.check} · แสดงตัวเลขจาก{stats[pickedAccount.id]?.chosen === "api" ? " API" : " Metricool"}</p>}
            <div className="segmented followers-tabs">
              <button className={tab === "chart" ? "active" : ""} onClick={() => setTab("chart")}>
                กราฟผู้ติดตาม
              </button>
              <button className={tab === "years" ? "active" : ""} onClick={() => setTab("years")}>
                เทียบรายปี
              </button>
            </div>
            {tab === "years" ? (
              <YearTable years={pickedYears} hasPosts={posts12.get(pickedAccount.id) !== null} />
            ) : series.length > 1 ? (
              <div className="chart-md">
                <ResponsiveContainer>
                  <LineChart data={series}>
                    <CartesianGrid vertical={false} stroke="#e8edf5" />
                    <XAxis dataKey="date" tickFormatter={dateLabel} tick={{ fontSize: 11 }} minTickGap={30} />
                    <YAxis tick={{ fontSize: 11 }} width={70} tickFormatter={(v) => shortCount(Number(v))} domain={["auto", "auto"]} />
                    <Tooltip labelFormatter={(v) => dateLabel(String(v))} formatter={(v) => [full(Number(v)), "ผู้ติดตาม"]} />
                    <Line type="monotone" dataKey="value" stroke={PLATFORM_COLOR[pickedAccount.platform]} strokeWidth={2.5} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <p className="ranking-empty">
                {pickedAccount.source === "manual" ? `${PENDING}: ยังไม่ได้ต่อ API · ตัวเลขกรอกเมื่อ ${dayTh(pickedAccount.manualDate || "")}` : "ยังมีข้อมูลไม่พอทำกราฟ"}
              </p>
            )}
            <div className="tv-actions">
              {accountUrl(pickedAccount) ? (
                <a className="followers-link" href={accountUrl(pickedAccount)} target="_blank" rel="noopener noreferrer">
                  <ExternalLink size={15} /> เปิดบัญชีบน {PLATFORM_LABEL[pickedAccount.platform]}
                </a>
              ) : (
                <span className="sync-muted">ยังไม่มีลิงก์บัญชี · ใส่ได้ในหน้าตั้งค่าบัญชีโซเชียล</span>
              )}
            </div>
          </section>
        </div>
      )}
    </article>
  );
}

const change = (a: number, b: number) => (b ? (a - b) / b : null);

/** Calendar years side by side; the change row compares per month, since a year may be only partly covered. */
function YearTable({ years, hasPosts }: { years: YearRow[]; hasPosts: boolean }) {
  if (!years.length) return <p className="ranking-empty">ยังไม่มีข้อมูลรายปี</p>;
  const [cur, prev] = years;
  const perMonth = (y: YearRow, k: "posts" | "views" | "likes" | "comments" | "shares") => (y.months ? y[k] / y.months : 0);
  const pctCell = (v: number | null) =>
    v === null ? <td>–</td> : <td className={v >= 0 ? "up" : "down"}>{`${v >= 0 ? "+" : ""}${Math.round(v * 100).toLocaleString("en-US")}%`}</td>;
  const erOf = (y: YearRow) => (y.er === null ? "–" : `${(y.er * 100).toFixed(2)}%`);
  return (
    <div className="followers-years">
      <table>
        <thead>
          <tr>
            <th>ปี</th>
            <th><Users size={13} aria-hidden="true" /> ผู้ติดตามสิ้นปี</th>
            {hasPosts && (
              <>
                <th><Clapperboard size={13} aria-hidden="true" /> โพสต์</th>
                <th><Eye size={13} aria-hidden="true" /> วิว</th>
                <th>วิว/เดือน</th>
                <th><Heart size={13} aria-hidden="true" /> ไลก์</th>
                <th><MessageCircle size={13} aria-hidden="true" /> คอมเมนต์</th>
                <th><Share2 size={13} aria-hidden="true" /> แชร์</th>
                <th><Activity size={13} aria-hidden="true" /> ER</th>
              </>
            )}
          </tr>
        </thead>
        <tbody>
          {years.map((y) => (
            <tr key={y.year}>
              <td>
                {y.year + 543}
                {hasPosts && <small>{y.months ? `${y.months} เดือน${y.months < 12 ? " ⚠️" : ""}` : "ไม่มีโพสต์"}</small>}
              </td>
              <td>{y.followersEnd === null ? "–" : full(y.followersEnd)}</td>
              {hasPosts && (
                <>
                  <td>{full(y.posts)}</td>
                  <td>{shortCount(y.views)}</td>
                  <td>{shortCount(Math.round(perMonth(y, "views")))}</td>
                  <td>{shortCount(y.likes)}</td>
                  <td>{shortCount(y.comments)}</td>
                  <td>{shortCount(y.shares)}</td>
                  <td>{erOf(y)}</td>
                </>
              )}
            </tr>
          ))}
          {prev && (
            <tr className="followers-change">
              <td>
                เปลี่ยนแปลง<small>{hasPosts ? "เทียบเฉลี่ยต่อเดือน" : "ผู้ติดตาม"}</small>
              </td>
              {cur.followersEnd !== null && prev.followersEnd !== null ? pctCell(change(cur.followersEnd, prev.followersEnd)) : <td>–</td>}
              {hasPosts && (
                <>
                  {pctCell(prev.months ? change(perMonth(cur, "posts"), perMonth(prev, "posts")) : null)}
                  {pctCell(prev.months ? change(perMonth(cur, "views"), perMonth(prev, "views")) : null)}
                  {pctCell(prev.months ? change(perMonth(cur, "views"), perMonth(prev, "views")) : null)}
                  {pctCell(prev.months ? change(perMonth(cur, "likes"), perMonth(prev, "likes")) : null)}
                  {pctCell(prev.months ? change(perMonth(cur, "comments"), perMonth(prev, "comments")) : null)}
                  {pctCell(prev.months ? change(perMonth(cur, "shares"), perMonth(prev, "shares")) : null)}
                  {cur.er !== null && prev.er !== null ? (
                    <td className={cur.er >= prev.er ? "up" : "down"}>{`${cur.er >= prev.er ? "+" : ""}${((cur.er - prev.er) * 100).toFixed(2)} จุด`}</td>
                  ) : (
                    <td>–</td>
                  )}
                </>
              )}
            </tr>
          )}
        </tbody>
      </table>
      <p className="audience-note">
        ⚠️ = ปีที่มีข้อมูลโพสต์ไม่ครบ 12 เดือน (ระบบเริ่มเก็บโพสต์ ก.ค.–ก.ย. 2568) แถวเปลี่ยนแปลงจึงเทียบแบบเฉลี่ยต่อเดือน · ผู้ติดตามสิ้นปี = ค่าวันสุดท้ายของปี (ปีปัจจุบันใช้ค่าล่าสุด)
      </p>
    </div>
  );
}

/** The board as CSV (Excel opens it with Thai intact), grouped as on screen. */
function downloadCsv(groups: Group[], view: View, stats: Record<string, AccountStat>, growth: (a: SocialAccount) => number | null, posts12: Map<string, PostTotals | null>) {
  const head = ["กลุ่ม", "รายการ", "แพลตฟอร์ม", "บัญชี", "ผู้ติดตาม", "ข้อมูลวันที่", "เพิ่มขึ้น 30 วัน", "ที่มา", "ตัวเลข API", "ตัวเลข Metricool", "หมายเหตุ", "โพสต์ 12 เดือน", "วิว 12 เดือน", "ไลก์ 12 เดือน", "คอมเมนต์ 12 เดือน", "แชร์ 12 เดือน", "ER 12 เดือน", "ลิงก์"];
  const lines = groups.flatMap((g) =>
    g.accounts.map((a) => {
      const now = currentFollowers(a, stats[a.id]);
      const gr = growth(a);
      const st = stats[a.id];
      const source = SOURCE_BADGE[sourceOf(a, st)].label;
      const p = posts12.get(a.id);
      const num = (v?: number) => (v === undefined ? "" : String(v));
      return [
        g.label, groupOf(a), PLATFORM_LABEL[a.platform], a.name, now ? String(now.value) : "", now?.date || "", gr === null ? "" : String(gr), source,
        num(st?.sources?.api?.value), num(st?.sources?.metricool?.value), st?.check || "",
        num(p?.posts), num(p?.views), num(p?.likes), num(p?.comments), num(p?.shares), p?.er == null ? "" : (p.er * 100).toFixed(2) + "%",
        accountUrl(a),
      ];
    }),
  );
  const cell = (v: string) => `"${v.replace(/"/g, '""')}"`;
  const csv = "﻿" + [head, ...lines].map((r) => r.map(cell).join(",")).join("\r\n");
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  link.download = `followers-${view === "platform" ? "by-platform" : "by-show"}-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
}
