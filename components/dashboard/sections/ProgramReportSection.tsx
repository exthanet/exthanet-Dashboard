"use client";
// รายงาน → รวมรายการ: every program side by side (lib/dashboard/programReport.ts) for
// the report range and the filters at the top, except the program filter.
import { Fragment, useMemo, useState } from "react";
import { Download, ExternalLink, LayoutList } from "lucide-react";
import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { RecordRow } from "@/lib/dashboard/types";
import { compact, num } from "@/lib/dashboard/format";
import { PLATFORM_COLORS } from "@/lib/dashboard/constants";
import { OTHERS, monthsOf, programDetail, programTable, type ProgramLine } from "@/lib/dashboard/programReport";
import { ClipDetailPanel } from "@/components/dashboard/sections/ClipDetailPanel";
import { recordDownload } from "@/lib/auth/activity";
import { useAdmin } from "@/components/dashboard/shared/AdminContext";

const LINE_COLORS = ["#ef4444", "#2563eb", "#16a34a", "#f59e0b", "#8b5cf6", "#0891b2"];
const thDate = (iso: string) => (iso ? new Intl.DateTimeFormat("th-TH", { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" }).format(new Date(`${iso}T00:00:00Z`)) : "");
const thMonth = (m: string) => new Intl.DateTimeFormat("th-TH", { timeZone: "UTC", month: "short", year: "2-digit" }).format(new Date(`${m}-01T00:00:00Z`));
const pct = (v: number, d = 1) => `${(v * 100).toFixed(d)}%`;
const colorOf = (p: string) => PLATFORM_COLORS[p] || "#64748b";
const addDays = (iso: string, d: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + d * 86400000).toISOString().slice(0, 10);

function Spark({ values }: { values: number[] }) {
  if (values.length < 2) return <span className="trend-same">–</span>;
  const max = Math.max(1, ...values);
  const w = 100;
  const h = 26;
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * w},${h - (v / max) * (h - 3) - 1}`).join(" ");
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true">
      <polyline points={pts} fill="none" stroke="#2563eb" strokeWidth="1.8" strokeLinejoin="round" />
    </svg>
  );
}

type SortKey = "views" | "posts" | "growth" | "medianViews" | "er";

interface Props {
  /** Rows passing the filters except program and date. */
  rows: RecordRow[];
  allRows: RecordRow[];
  startDate: string;
  endDate: string;
  comparePeriod: { start: string; end: string } | null;
  latestDate: string;
  canDownload?: boolean;
  /** Set the program filter and go to the overview. */
  onOpenProgram: (program: string) => void;
}

export function ProgramReportSection({ rows, allRows, startDate, endDate, comparePeriod, latestDate, canDownload = true, onOpenProgram }: Props) {
  const [sort, setSort] = useState<SortKey>("views");
  const [open, setOpen] = useState<string | null>(null);
  const [opened, setOpened] = useState<RecordRow | null>(null);
  const cur = useMemo(() => ({ start: startDate, end: endDate }), [startDate, endDate]);
  const table = useMemo(() => programTable(rows, cur, comparePeriod), [rows, cur, comparePeriod]);
  const lines = useMemo(() => {
    const keep = table.lines.filter((l) => l.program !== OTHERS);
    const others = table.lines.filter((l) => l.program === OTHERS);
    const val = (l: ProgramLine) => (sort === "growth" ? l.growth ?? -Infinity : l[sort]);
    return [...keep.sort((a, b) => val(b) - val(a)), ...others];
  }, [table, sort]);
  const months = useMemo(() => monthsOf(cur), [cur]);
  const short = months.length <= 3;
  const dayList = useMemo(() => {
    const out: string[] = [];
    if (startDate && endDate) for (let d = startDate; d <= endDate && out.length < 100; d = addDays(d, 1)) out.push(d);
    return out;
  }, [startDate, endDate]);
  const trendOf = (l: ProgramLine) => (short ? dayList.map((d) => l.daily[d] || 0) : months.map((m) => l.monthly[m] || 0));
  const top = table.lines.filter((l) => l.program !== OTHERS && l.views > 0).slice(0, 6);
  const monthlyData = months.map((m) => Object.fromEntries([["month", m], ...top.map((l) => [l.program, l.monthly[m] || 0])]));
  const shareData = table.lines.filter((l) => l.views > 0).slice(0, 10).map((l) => ({ program: l.program, views: l.views }));
  const hasTv = table.lines.some((l) => l.tv.episodes > 0);
  const compareText = comparePeriod ? `เทียบ ${thDate(comparePeriod.start)} – ${thDate(comparePeriod.end)}` : "";

  function downloadCsv() {
    const cols = ["Program", "Posts", "Views", "Growth", "MedianViewsPerPost", "ER", "Share", "YouTube", "Facebook", "Instagram", "TikTok", "TVEpisodes", "TVRating", "TVAudience"];
    const cell = (v: unknown) => {
      const s = String(v ?? "");
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const body = [...lines, table.total].map((l) =>
      [l.program === OTHERS ? `${OTHERS} (${l.members.join(" / ")})` : l.program, l.posts, l.views, l.growth === null ? "" : l.growth.toFixed(4), Math.round(l.medianViews), l.er.toFixed(4), l.share.toFixed(4), l.platforms.YouTube || 0, l.platforms.Facebook || 0, l.platforms.Instagram || 0, l.platforms.TikTok || 0, l.tv.episodes, l.tv.rating ?? "", l.tv.audience]
        .map(cell)
        .join(","),
    );
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob(["﻿" + [cols.join(","), ...body].join("\r\n")], { type: "text/csv;charset=utf-8" }));
    a.download = `programs-${startDate}-${endDate}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
    recordDownload("csv-programs", a.download, lines.length);
  }

  const head = (k: SortKey, label: string) => (
    <th className={`num sortable ${sort === k ? "active" : ""}`} onClick={() => setSort(k)} title="กดเพื่อเรียง">
      {label}
      {sort === k ? " ▼" : ""}
    </th>
  );

  return (
    <section className="panel program-report" id="program-report">
      {opened && <ClipDetailPanel clip={opened} allRows={allRows} latestDate={latestDate} onClose={() => setOpened(null)} />}
      <div className="panel-head">
        <div>
          <h2>
            <LayoutList size={18} /> รวมรายการ
          </h2>
          <p className="growth-sub">
            {thDate(startDate)} – {thDate(endDate)} · ทุกรายการ ตามตัวกรองด้านบน (ยกเว้นตัวกรองรายการ){compareText ? ` · % ${compareText}` : ""}
          </p>
        </div>
        {canDownload && table.lines.length > 0 && (
          <button type="button" className="acc-export" onClick={downloadCsv}>
            <Download size={14} /> CSV
          </button>
        )}
      </div>

      {!table.lines.length ? (
        <p className="growth-notice">ไม่มีข้อมูลในช่วงและตัวกรองนี้</p>
      ) : (
        <>
          <div className="table-scroll">
            <table className="trend-table program-table">
              <thead>
                <tr>
                  <th>รายการ</th>
                  {head("posts", "โพสต์")}
                  {head("views", "วิว")}
                  {head("growth", "เทียบช่วงก่อน")}
                  {head("medianViews", "วิว/โพสต์ (ค่ากลาง)")}
                  {head("er", "ER")}
                  <th className="num">สัดส่วนวิว</th>
                  <th>แพลตฟอร์ม</th>
                  <th>แนวโน้ม{short ? " (รายวัน)" : " (รายเดือน)"}</th>
                  {hasTv && <th className="num">TV: เทป · เรตติ้ง · ผู้ชม</th>}
                </tr>
              </thead>
              <tbody>
                {lines.map((l) => (
                  <Fragment key={l.program}>
                    <tr>
                      <td>
                        <button type="button" className="trend-tag" onClick={() => setOpen(open === l.program ? null : l.program)} aria-expanded={open === l.program}>
                          {open === l.program ? "▾ " : "▸ "}
                          {l.program}
                        </button>
                        {l.program === OTHERS && <small>{l.members.join(" · ")}</small>}
                      </td>
                      <td className="num">{num(l.posts)}</td>
                      <td className="num strong">{compact(l.views)}</td>
                      <td className={`num ${l.growth === null ? "" : l.growth >= 0 ? "up" : "down"}`}>{l.growth === null ? "-" : `${l.growth >= 0 ? "+" : ""}${pct(l.growth, 0)}`}</td>
                      <td className="num">{compact(l.medianViews)}</td>
                      <td className="num">{pct(l.er, 2)}</td>
                      <td className="num">{pct(l.share, 1)}</td>
                      <td>
                        <span className="trend-platforms" title={Object.entries(l.platforms).map(([p, v]) => `${p} ${num(v)}`).join(" · ")}>
                          {Object.entries(l.platforms)
                            .sort((a, b) => b[1] - a[1])
                            .map(([p, v]) => (
                              <i key={p} style={{ width: `${l.views ? (v / l.views) * 100 : 0}%`, background: colorOf(p) }} />
                            ))}
                        </span>
                      </td>
                      <td>
                        <Spark values={trendOf(l)} />
                      </td>
                      {hasTv && (
                        <td className="num">
                          {l.tv.episodes ? `${num(l.tv.episodes)} · ${l.tv.rating === null ? "-" : l.tv.rating.toFixed(3)} · ${compact(l.tv.audience)}` : "-"}
                        </td>
                      )}
                    </tr>
                    {open === l.program && <ProgramRow line={l} rows={rows} cur={cur} hasTv={hasTv} onOpenClip={setOpened} onOpenProgram={onOpenProgram} />}
                  </Fragment>
                ))}
                <tr className="acc-total">
                  <td>รวม</td>
                  <td className="num">{num(table.total.posts)}</td>
                  <td className="num">{compact(table.total.views)}</td>
                  <td className={`num ${table.total.growth === null ? "" : table.total.growth >= 0 ? "up" : "down"}`}>{table.total.growth === null ? "-" : `${table.total.growth >= 0 ? "+" : ""}${pct(table.total.growth, 0)}`}</td>
                  <td className="num">{compact(table.total.medianViews)}</td>
                  <td className="num">{pct(table.total.er, 2)}</td>
                  <td className="num">100%</td>
                  <td />
                  <td />
                  {hasTv && <td className="num">{table.total.tv.episodes ? `${num(table.total.tv.episodes)} เทป · ${compact(table.total.tv.audience)}` : "-"}</td>}
                </tr>
              </tbody>
            </table>
          </div>
          <p className="audience-note">
            วิว = ยอดสะสมล่าสุดของโพสต์ออนไลน์ที่โพสต์ในช่วงนี้ (ไม่รวม TV) · รายการที่มีไม่ถึง 5 โพสต์รวมไว้ใน “อื่นๆ” · กดชื่อรายการเพื่อดูคลิปเด่น Topic Type และ Hashtag
          </p>

          <div className="platform-report-grid program-charts">
            <article className="growth-table">
              <h3>สัดส่วนวิวแต่ละรายการ</h3>
              <div className="chart-md">
                <ResponsiveContainer>
                  <BarChart data={shareData} layout="vertical" margin={{ left: 10, right: 16 }}>
                    <CartesianGrid horizontal={false} stroke="#e8edf5" />
                    <XAxis type="number" tickFormatter={compact} tick={{ fontSize: 11 }} />
                    <YAxis type="category" dataKey="program" width={110} tick={{ fontSize: 11 }} />
                    <Tooltip formatter={(v) => [num(Number(v)), "วิว"]} />
                    <Bar dataKey="views" fill="#2563eb" radius={[0, 4, 4, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </article>
            <article className="growth-table">
              <h3>วิวรายเดือน (ตามเดือนที่โพสต์)</h3>
              {months.length >= 2 ? (
                <div className="chart-md">
                  <ResponsiveContainer>
                    <LineChart data={monthlyData}>
                      <CartesianGrid vertical={false} stroke="#e8edf5" />
                      <XAxis dataKey="month" tickFormatter={thMonth} tick={{ fontSize: 11 }} />
                      <YAxis tickFormatter={compact} tick={{ fontSize: 11 }} />
                      <Tooltip labelFormatter={(m) => thMonth(String(m))} formatter={(v, n) => [num(Number(v)), String(n)]} />
                      <Legend />
                      {top.map((l, i) => (
                        <Line key={l.program} type="monotone" dataKey={l.program} stroke={LINE_COLORS[i % LINE_COLORS.length]} strokeWidth={2} dot={{ r: 2 }} />
                      ))}
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              ) : (
                <p className="growth-notice">เลือกช่วงเวลาอย่างน้อย 2 เดือน (เช่น 90 วันล่าสุด) เพื่อดูแนวโน้มรายเดือน</p>
              )}
            </article>
          </div>
        </>
      )}
      <UnassignedClips allRows={allRows} startDate={startDate} endDate={endDate} onOpen={setOpened} />
    </section>
  );
}

function ProgramRow({
  line,
  rows,
  cur,
  hasTv,
  onOpenClip,
  onOpenProgram,
}: {
  line: ProgramLine;
  rows: RecordRow[];
  cur: { start: string; end: string };
  hasTv: boolean;
  onOpenClip: (r: RecordRow) => void;
  onOpenProgram: (program: string) => void;
}) {
  const d = useMemo(() => programDetail(rows, line.members, cur), [rows, line.members, cur]);
  return (
    <tr className="program-detail-row">
      <td colSpan={hasTv ? 10 : 9}>
        <div className="program-detail">
          <div>
            <b>คลิปที่วิวสูงสุด</b>
            <ol className="search-clips">
              {d.top.map((r, i) => (
                <li key={`${r.url || r.topic}-${i}`}>
                  <span className="ranking-title">
                    <button type="button" className="clip-open" onClick={() => onOpenClip(r)} title="วิเคราะห์คลิปนี้">
                      {r.topic || "ไม่ระบุประเด็น"}
                    </button>
                    {r.url && (
                      <a href={r.url} target="_blank" rel="noreferrer" aria-label="เปิดคลิป">
                        <ExternalLink size={11} />
                      </a>
                    )}
                  </span>
                  <small>
                    <b style={{ color: colorOf(r.platform) }}>{r.platform}</b> · {thDate(r.date)} · {compact(r.views)} วิว
                  </small>
                </li>
              ))}
            </ol>
          </div>
          <div>
            <b>Topic Type ที่ได้ผลดีที่สุด</b> <small>(วิว/โพสต์ ค่ากลาง)</small>
            {d.topics.length ? (
              <ul className="program-list">
                {d.topics.map((t) => (
                  <li key={t.topicType}>
                    {t.topicType} <small>{compact(t.medianViews)} · {t.posts} โพสต์</small>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="audience-note">โพสต์ยังไม่พอ (ต้องมีอย่างน้อย 3 โพสต์ต่อหมวด)</p>
            )}
            <b>Hashtag ยอดนิยม</b>
            {d.hashtags.length ? (
              <div className="trend-related">
                {d.hashtags.map((t) => (
                  <span key={t.tag} className="program-tag">
                    {t.tag} <small>{compact(t.views)}</small>
                  </span>
                ))}
              </div>
            ) : (
              <p className="audience-note">ไม่มี hashtag ที่ใช้ถึง 2 โพสต์</p>
            )}
            {line.program !== OTHERS && (
              <button type="button" className="trend-more" style={{ marginTop: 8 }} onClick={() => onOpenProgram(line.program)}>
                เปิดในหน้าภาพรวม
              </button>
            )}
          </div>
        </div>
      </td>
    </tr>
  );
}

/**
 * Admins: posts of the range still on "ไม่ระบุ", most viewed first, the same clip on several
 * platforms as one line; a click opens the clip panel, where its program can be set.
 */
function UnassignedClips({ allRows, startDate, endDate, onOpen }: { allRows: RecordRow[]; startDate: string; endDate: string; onOpen: (r: RecordRow) => void }) {
  const { isAdmin } = useAdmin();
  const [showAll, setShowAll] = useState(false);
  const list = useMemo(() => {
    const byTitle = new Map<string, { row: RecordRow; views: number; platforms: Set<string>; posts: number }>();
    for (const r of allRows) {
      if (r.platform === "TV" || (r.program && r.program !== "ไม่ระบุ") || r.date < startDate || r.date > endDate) continue;
      const k = r.topic.replace(/s+/g, " ").trim().slice(0, 60) || `${r.platform}-${r.contentId}`;
      const e = byTitle.get(k) || { row: r, views: 0, platforms: new Set<string>(), posts: 0 };
      e.views += r.views || 0;
      e.posts++;
      e.platforms.add(r.platform);
      if ((r.views || 0) > (e.row.views || 0)) e.row = r;
      byTitle.set(k, e);
    }
    return [...byTitle.values()].sort((a, b) => b.views - a.views);
  }, [allRows, startDate, endDate]);
  if (!isAdmin || !list.length) return null;
  const shown = showAll ? list : list.slice(0, 15);
  const posts = list.reduce((a, e) => a + e.posts, 0);
  return (
    <div className="unassigned-clips">
      <h3>
        คลิปที่ยังไม่ระบุรายการ <small>{num(posts)} โพสต์ · {num(list.length)} คลิป · กดเพื่อเลือกรายการ (admin)</small>
      </h3>
      <table>
        <thead>
          <tr>
            <th>คลิป</th>
            <th>แพลตฟอร์ม</th>
            <th className="num">วิว</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((e) => (
            <tr key={`${e.row.platform}-${e.row.contentId}`} onClick={() => onOpen(e.row)} className="clickable">
              <td>{e.row.topic.replace(/s+/g, " ").slice(0, 90) || "(ไม่มีข้อความ)"}</td>
              <td>{[...e.platforms].join(", ")}</td>
              <td className="num">{num(e.views)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {list.length > shown.length && (
        <button type="button" className="tv-add" onClick={() => setShowAll(true)}>
          ดูทั้งหมด {num(list.length)} คลิป
        </button>
      )}
    </div>
  );
}
