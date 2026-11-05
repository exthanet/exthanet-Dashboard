"use client";
// ผู้ติดตาม: every company account and its followers, grouped by platform or by show
// (รายการ), with the total and the online views of the last 12 months from masterData.
// Numbers come from accountStats (the daily sync); an account without an API shows the
// admin's typed number marked "รอตรวจสอบ". Click a card for a popup with its daily
// followers and a link to the account; download the board as CSV.
import { useEffect, useMemo, useState } from "react";
import { Download, ExternalLink, Settings, X } from "lucide-react";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { RecordRow } from "@/lib/dashboard/types";
import {
  PLATFORM_LABEL,
  SOCIAL_PLATFORMS,
  accountUrl,
  boardTotal,
  currentFollowers,
  followersOn,
  groupOf,
  shortCount,
  type AccountStat,
  type SocialAccount,
  type SocialPlatform,
} from "@/lib/dashboard/socialAccounts";
import { loadAccountStats, loadSocialAccounts } from "@/lib/socialAccountsData";
import { dateLabel } from "@/lib/dashboard/format";
import { track } from "@/lib/loadingBar";

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

  return (
    <article className="panel full followers-board-panel" id="followers">
      <div className="panel-head">
        <div>
          <h2>ผู้ติดตาม</h2>
          <p>ผู้ติดตามของทุกบัญชี · ตัวเลขจาก Metricool / YouTube อัปเดตทุกวันพร้อม sync · “{PENDING}” = บัญชีที่ยังไม่ได้ต่อ API ตัวเลขกรอกโดยผู้ดูแล</p>
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
          <button className="tv-add" onClick={() => downloadCsv(groups, view, stats, growth)} disabled={!shown.length}>
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
                      onClick={() => setPicked(a.id)}
                      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), setPicked(a.id))}
                      title={problem || ""}
                    >
                      {accountUrl(a) && (
                        <a className="followers-open" href={accountUrl(a)} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} aria-label={`เปิด ${a.name} บน ${PLATFORM_LABEL[a.platform]}`}>
                          <ExternalLink size={14} />
                        </a>
                      )}
                      {a.logo ? <img src={a.logo} alt="" className="followers-logo" /> : <span className="followers-logo text">{initials(a.name)}</span>}
                      <span className="followers-body">
                        <span className="followers-num">{now ? full(now.value) : "–"}</span>
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
                            <span className="followers-manual" title={a.manualDate ? `กรอกเมื่อ ${dayTh(a.manualDate)}` : ""}>
                              {PENDING}
                            </span>
                          ) : gr !== null ? (
                            <span className={gr >= 0 ? "up" : "down"}>{`${gr >= 0 ? "+" : ""}${full(gr)} ใน 30 วัน`}</span>
                          ) : problem ? (
                            <span className="down">ดึงไม่ได้</span>
                          ) : (
                            <span>{now ? dayTh(now.date) : "รอ sync"}</span>
                          )}
                        </span>
                      </span>
                    </div>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      )}

      {pickedAccount && (
        <div className="modal-backdrop" onClick={() => setPicked("")}>
          <section className="source-modal sync-modal followers-popup" onClick={(e) => e.stopPropagation()}>
            <button className="close" onClick={() => setPicked("")} aria-label="ปิด">
              <X size={18} />
            </button>
            <div className="sync-heading">
              {pickedAccount.logo ? <img src={pickedAccount.logo} alt="" className="followers-logo" /> : <span className="followers-logo text">{initials(pickedAccount.name)}</span>}
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
              {series.length > 1 && (
                <div>
                  ข้อมูลย้อนหลัง
                  <b>{full(series.length)} วัน</b>
                  ตั้งแต่ {dayTh(series[0].date)}
                </div>
              )}
            </div>
            {series.length > 1 ? (
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

/** The board as CSV (Excel opens it with Thai intact), grouped as on screen. */
function downloadCsv(groups: Group[], view: View, stats: Record<string, AccountStat>, growth: (a: SocialAccount) => number | null) {
  const head = ["กลุ่ม", "รายการ", "แพลตฟอร์ม", "บัญชี", "ผู้ติดตาม", "ข้อมูลวันที่", "เพิ่มขึ้น 30 วัน", "ที่มา", "ลิงก์"];
  const lines = groups.flatMap((g) =>
    g.accounts.map((a) => {
      const now = currentFollowers(a, stats[a.id]);
      const gr = growth(a);
      const source = a.source === "manual" ? PENDING : a.source === "youtube" ? "YouTube API" : "Metricool";
      return [g.label, groupOf(a), PLATFORM_LABEL[a.platform], a.name, now ? String(now.value) : "", now?.date || "", gr === null ? "" : String(gr), source, accountUrl(a)];
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
