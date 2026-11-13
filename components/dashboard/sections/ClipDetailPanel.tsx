"use client";
// Advanced → การเติบโต: click a clip to see it on every platform, its daily
// gains in the range, how it did against normal and when it was posted
// (lib/dashboard/clipDetail.ts). Uses the growth days the page already loaded,
// or loads up to 31 days up to the latest data when opened from elsewhere.
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Clock, ExternalLink, Link2, Share2, X } from "lucide-react";
import { Bar, CartesianGrid, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { RecordRow } from "@/lib/dashboard/types";
import { addDays, daysBetween, type GrowthEntry } from "@/lib/dashboard/growth";
import { growthSyncTimes, loadGrowthDays } from "@/lib/growthData";
import { earlySignals } from "@/lib/dashboard/earlySignal";
import { levelText, perHourText } from "@/components/dashboard/sections/EarlySignalBox";
import { compact, dateLabel, num } from "@/lib/dashboard/format";
import { vsNormal, vsNormalTone } from "@/lib/dashboard/vsNormal";
import { PLATFORM_COLORS } from "@/lib/dashboard/constants";
import { watchShare } from "@/lib/dashboard/quality";
import { clipDetail, daysAfterPost, gainedByPlatform, siblingsOf, type ClipPost } from "@/lib/dashboard/clipDetail";
import { useMotion } from "@/components/dashboard/shared/Motion";
import { ClipTiles, FactCards, HourChart, ShareBar, YtClipBox } from "@/components/dashboard/sections/ClipMotion";
import { recordKey } from "@/lib/dashboard/growth";
import { loadThumbnails, thumbnailFor } from "@/lib/thumbnailData";
import { track } from "@/lib/loadingBar";
import { ClipComments } from "@/components/dashboard/sections/ClipComments";
import { ClipProgramEditor } from "@/components/dashboard/sections/ClipProgramEditor";

const thDate = (iso: string, opts: Intl.DateTimeFormatOptions = { day: "numeric", month: "short", year: "2-digit" }) =>
  iso ? new Intl.DateTimeFormat("th-TH", { timeZone: "UTC", ...opts }).format(new Date(`${iso}T00:00:00Z`)) : "";
const thClock = (ms: number) =>
  new Intl.DateTimeFormat("th-TH", { timeZone: "Asia/Bangkok", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(ms));
const hh = (h: number) => `${String(h).padStart(2, "0")}:00`;
const colorOf = (p: string) => PLATFORM_COLORS[p] || "#64748b";
const duration = (r: RecordRow) => {
  const sec = r.videoLengthSec || Math.round(r.durationMin * 60);
  return sec > 0 ? `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, "0")} นาที` : "";
};

/** Days loaded when the panel fetches its own growth data. */
const OWN_DAYS = 31;
const NO_DAYS = new Map<string, GrowthEntry[] | null>();

interface Props {
  clip: RecordRow;
  /** Every row (not cut by the filters), to find the same content on other platforms. */
  allRows: RecordRow[];
  /** Growth days already loaded (growth page); without them the panel loads its own. */
  days?: Map<string, GrowthEntry[] | null>;
  rangeDays?: string[];
  /** Newest data day: the panel loads from the posting day (at most 31 days back) to here. */
  latestDate?: string;
  onClose: () => void;
}

function hourText(p: ClipPost) {
  if (p.hour === null) return "ไม่มีเวลาโพสต์";
  const own = p.hourMedian !== null ? ` · ชั่วโมงนี้ได้ค่ากลาง ${compact(p.hourMedian)}/คลิป` : "";
  const best = p.bestHour && p.bestHour.hour !== p.hour ? ` · ชั่วโมงที่ดีที่สุด ${hh(p.bestHour.hour)} (${compact(p.bestHour.median)}/คลิป)` : p.bestHour ? " · เป็นชั่วโมงที่ค่ากลางสูงสุด" : "";
  return `โพสต์ ${p.row.publishTime} น.${own}${best}`;
}

export function ClipDetailPanel({ clip, allRows, days, rangeDays, latestDate, onClose }: Props) {
  // Opened without growth data: the last 31 days up to the latest data, not before the first post.
  const ownRange = useMemo(() => {
    if (days && rangeDays) return null;
    const posted = siblingsOf(clip, allRows).posts.map((r) => r.date).filter(Boolean).sort()[0] || clip.date;
    const end = latestDate && latestDate >= posted ? latestDate : posted;
    const from = addDays(end, -(OWN_DAYS - 1));
    return daysBetween(posted > from ? posted : from, end);
  }, [days, rangeDays, clip, allRows, latestDate]);
  const [ownDays, setOwnDays] = useState<Map<string, GrowthEntry[] | null> | null>(null);
  useEffect(() => {
    if (!ownRange) return;
    let alive = true;
    setOwnDays(null);
    track(loadGrowthDays(ownRange))
      .then((m) => alive && setOwnDays(m))
      .catch(() => alive && setOwnDays(NO_DAYS));
    return () => {
      alive = false;
    };
  }, [ownRange]);
  const growthDays = days || ownDays || NO_DAYS;
  const range = rangeDays || ownRange || [];
  const loadingDays = !days && !ownDays;

  const d = useMemo(() => clipDetail(clip, allRows, growthDays, range), [clip, allRows, growthDays, range]);
  // A chart day = gains between the previous day's last sync and this day's last sync (the next morning).
  const syncAt = useMemo(() => (loadingDays ? new Map<string, number>() : growthSyncTimes()), [loadingDays, growthDays]);
  const dayLabel = (day: string) => {
    const date = thDate(day, { weekday: "short", day: "numeric", month: "short" });
    const end = syncAt.get(day);
    if (!end) return date;
    const start = syncAt.get(addDays(day, -1));
    return `${date} · นับ${start ? `จาก ${thClock(start)} ` : ""}ถึง ${thClock(end)} น.`;
  };
  const share = useMemo(() => gainedByPlatform(d), [d]);
  // Start speed of each post first seen in the loaded days (peers: same programme, platform, format).
  const starts = useMemo(() => {
    if (loadingDays) return [];
    const keys = new Set(d.posts.map((p) => p.key));
    return earlySignals(growthDays, growthSyncTimes(), allRows).filter((c) => keys.has(c.key));
  }, [loadingDays, d, growthDays, allRows]);

  // Cover: the clicked post first, then its other posts; a broken link moves to the next one.
  const [stored, setStored] = useState<Map<string, string>>(new Map());
  const [coverAt, setCoverAt] = useState(0);
  useEffect(() => {
    track(loadThumbnails())
      .then(setStored)
      .catch(() => setStored(new Map()));
  }, []);
  const covers = useMemo(() => {
    const keys = [recordKey(clip), ...d.posts.map((p) => p.key)].filter(Boolean);
    return [...new Set(keys.map((k) => thumbnailFor(k, stored)).filter(Boolean))];
  }, [clip, d, stored]);
  useEffect(() => setCoverAt(0), [covers]);
  const cover = covers[coverAt] || "";

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const motion = useMotion();
  // Platforms hidden on the daily chart (click the legend).
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const toggle = (p: string) =>
    setHidden((x) => {
      const n = new Set(x);
      if (n.has(p)) n.delete(p);
      else n.add(p);
      return n;
    });

  // Short facts from the numbers above (rules, not AI).
  const facts: string[] = [];
  if (share.length > 1 && d.gained > 0) facts.push(`${Math.round((share[0].total / d.gained) * 100)}% ของวิวที่เพิ่มในช่วงนี้มาจาก ${share[0].name}`);
  if (d.peak) {
    const after = daysAfterPost(d, d.peak.date);
    facts.push(`วิวเพิ่มมากที่สุดวันที่ ${thDate(d.peak.date)} (${num(d.peak.views)} วิว)${after !== null && after >= 0 ? ` · ${after === 0 ? "วันที่โพสต์" : `${after} วันหลังโพสต์`}` : ""}`);
  }
  // Posts under a week old are still collecting views: say so beside the comparison.
  const lastDay = range.at(-1) || "";
  const young = (r: RecordRow) => {
    const age = lastDay && r.date ? Math.round((Date.parse(`${lastDay}T00:00:00Z`) - Date.parse(`${r.date}T00:00:00Z`)) / 86400000) : null;
    return age !== null && age >= 0 && age < 7 ? ` · โพสต์ได้ ${age} วัน ยอดยังเพิ่มได้` : "";
  };
  for (const c of starts) {
    if (c.perHour === null || c.hours === null) continue;
    const lv = levelText(c);
    const head = c.level === "hot" ? "🔥 เริ่มต้นแรง" : c.level === "good" ? "เริ่มต้นดีกว่าปกติ" : c.level === "normal" ? "เริ่มต้นปกติ" : "ความเร็วช่วงแรก";
    facts.push(`${head}: ${c.row.platform} ${c.row.vdoType} ได้ ${num(c.firstViews)} วิวใน ${c.hours.toFixed(1)} ชม.แรก (${perHourText(c.perHour)}/ชม.)${lv.detail ? ` · ${lv.detail}` : ""}`);
  }
  for (const p of d.posts) if (p.index !== null) facts.push(`${p.row.platform} ${p.row.vdoType}: ${vsNormal(p.index)} (ค่ากลาง ${compact(p.baseline!)})${young(p.row)}`);
  for (const p of d.posts)
    if (p.hour !== null && p.bestHour && p.bestHour.hour !== p.hour && p.hourMedian !== null && p.bestHour.median > p.hourMedian * 1.5)
      facts.push(`${p.row.platform} โพสต์ ${hh(p.hour)} แต่ ${p.row.vdoType} ช่วง ${hh(p.bestHour.hour)} ได้ค่ากลางสูงกว่า ${(p.bestHour.median / p.hourMedian).toFixed(1)} เท่า`);

  const firstDay = range[0] || "";
  const hasWatch = d.posts.some((p) => watchShare(p.row) !== null);

  // On <body>: inside a panel, a transformed ancestor would trap the fixed overlay.
  return createPortal(
    <div className="clip-detail-backdrop" onClick={onClose}>
      <aside className="clip-detail cm" role="dialog" aria-modal="true" aria-label="วิเคราะห์คลิป" onClick={(e) => e.stopPropagation()}>
        <header className="clip-detail-head">
          {cover && (
            <a className="clip-detail-cover" href={clip.url || undefined} target="_blank" rel="noreferrer" title="เปิดคลิป">
              <img src={cover} alt={clip.topic} referrerPolicy="no-referrer" onError={() => setCoverAt((i) => i + 1)} />
            </a>
          )}
          <div className="clip-detail-title">
            <small>วิเคราะห์คลิป</small>
            <h2 title={clip.topic}>{clip.topic || "ไม่ระบุประเด็น"}</h2>
            <p>
              {[clip.program, clip.topicType, thDate(d.firstPosted, { day: "numeric", month: "short", year: "numeric" }), duration(clip)].filter(Boolean).join(" · ")}
            </p>
          </div>
          <button type="button" className="clip-detail-close" onClick={onClose} aria-label="ปิด">
            <X size={18} />
          </button>
        </header>

        <ClipProgramEditor posts={d.posts.map((p) => p.row)} allRows={allRows} />

        {d.byTitle && (
          <p className="growth-notice">
            <Link2 size={14} /> พบคลิปเดียวกัน {d.posts.length} โพสต์ใน {new Set(d.posts.map((p) => p.row.platform)).size} แพลตฟอร์ม · จับคู่จากชื่อคลิป
            (รายการเดียวกัน โพสต์ห่างกันไม่เกิน 3 วัน) ถ้าตั้งชื่อต่างกันจะไม่ถูกนับรวม
          </p>
        )}

        <ClipTiles
          tiles={[
            { label: "ยอดวิวรวม", value: d.totalViews, format: compact, detail: d.posts.length > 1 ? `รวม ${d.posts.length} โพสต์ · ยอดสะสมล่าสุด` : "ยอดสะสมล่าสุด" },
            { label: "วิวที่เพิ่มในช่วงนี้", value: loadingDays ? null : d.gained, format: compact, detail: `${thDate(firstDay)} – ${thDate(lastDay)}${loadingDays ? "" : ` · ${d.daysWithData} วันที่มีข้อมูล`}` },
            { label: "Engagement", value: d.likes + d.comments + d.shares, format: compact, detail: `ER ${(d.er * 100).toFixed(2)}% · เพิ่มในช่วงนี้ ${compact(d.gainedEngagement)}` },
            {
              label: "Comment",
              value: d.comments,
              format: compact,
              detail: `Like ${compact(d.likes)} · Share ${compact(d.shares)}${d.totalViews ? ` · ${((d.comments / d.totalViews) * 1000).toFixed(2)} comment ต่อ 1,000 วิว` : ""}`,
            },
          ]}
        />
        <p className="audience-note clip-detail-kpi-note">
          ยอดวิวรวม = ยอดสะสมตั้งแต่โพสต์ถึง sync ล่าสุด · วิวที่เพิ่มในช่วงนี้ = ผลรวมของกราฟรายวันในช่วงที่เลือก จึงน้อยกว่ายอดวิวรวม · ER = (Like + Comment + Share) ÷ วิว
        </p>

        <section className="clip-detail-box">
          <h3>แยกตามแพลตฟอร์ม</h3>
          <ShareBar posts={d.posts} total={d.totalViews} />
          <div className="table-scroll">
            <table className="clip-detail-table">
              <thead>
                <tr>
                  <th>แพลตฟอร์ม</th>
                  <th>โพสต์</th>
                  <th className="num">วิวสะสม</th>
                  <th className="num">สัดส่วน</th>
                  <th className="num">เพิ่มในช่วงนี้</th>
                  <th className="num">ER</th>
                  {hasWatch && <th className="num" title="เวลาดูเฉลี่ย ÷ ความยาวคลิป">ดูเฉลี่ย</th>}
                  <th className="num">เทียบค่าปกติ</th>
                </tr>
              </thead>
              <tbody>
                {d.posts.map((p) => (
                  <tr key={p.key || p.row.url}>
                    <td>
                      <span className="clip-dot" style={{ background: colorOf(p.row.platform) }} />
                      <a href={p.row.url || undefined} target="_blank" rel="noreferrer">
                        {p.row.platform} <ExternalLink size={11} />
                      </a>
                      <small>{p.row.vdoType}</small>
                    </td>
                    <td>
                      {thDate(p.row.date)}
                      <small>{p.row.publishTime ? `${p.row.publishTime} น.` : "ไม่มีเวลา"}</small>
                    </td>
                    <td className="num strong">{num(p.row.views)}</td>
                    <td className="num">
                      {d.totalViews ? `${Math.round((p.row.views / d.totalViews) * 100)}%` : "-"}
                      <span className="clip-share">
                        <i style={{ width: `${d.totalViews ? (p.row.views / d.totalViews) * 100 : 0}%`, background: colorOf(p.row.platform) }} />
                      </span>
                    </td>
                    <td className="num">{num(p.gained)}</td>
                    <td className="num">{p.row.views > 0 ? `${((p.row.engagement / p.row.views) * 100).toFixed(1)}%` : "-"}</td>
                    {hasWatch && <td className="num">{watchShare(p.row) === null ? "-" : `${Math.round(watchShare(p.row)! * 100)}%`}</td>}
                    <td className={`num ${p.index === null ? "" : vsNormalTone(p.index)}`}>{p.index === null ? "-" : vsNormal(p.index)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="audience-note">
            สัดส่วน = วิวของโพสต์นั้น ÷ ยอดวิวรวมทุกแพลตฟอร์ม · เพิ่มในช่วงนี้ = วิวที่เพิ่มในช่วงที่เลือก (จากข้อมูลรายวัน) · เทียบค่าปกติ = วิว ÷ ค่ากลางวิวของคลิปแพลตฟอร์มและรูปแบบเดียวกันใน 30 วันก่อนโพสต์{hasWatch && " · ดูเฉลี่ย = เวลาดูเฉลี่ย ÷ ความยาวคลิป (เฉพาะแพลตฟอร์มที่ API ให้ข้อมูล)"}
          </p>
        </section>

        <section className="clip-detail-box">
          <h3>วิวที่เพิ่มแต่ละวัน แยกตามแพลตฟอร์ม</h3>
          {loadingDays ? (
            <p className="growth-notice">กำลังโหลดข้อมูลรายวัน…</p>
          ) : d.daysWithData ? (
            <div className="chart-md">
              <ResponsiveContainer>
                <ComposedChart data={d.daily}>
                  <CartesianGrid vertical={false} stroke="#e8edf5" />
                  <XAxis dataKey="date" tickFormatter={dateLabel} tick={{ fontSize: 11 }} />
                  <YAxis yAxisId="v" tickFormatter={compact} tick={{ fontSize: 11 }} />
                  <YAxis yAxisId="c" orientation="right" tickFormatter={compact} tick={{ fontSize: 11 }} />
                  <Tooltip labelFormatter={(v) => dayLabel(String(v))} formatter={(v, name) => [num(Number(v)), String(name)]} />
                  {d.platforms
                    .filter((p) => !hidden.has(p))
                    .map((p) => (
                      <Bar key={p} yAxisId="v" dataKey={p} stackId="v" fill={colorOf(p)} isAnimationActive={motion} />
                    ))}
                  <Line yAxisId="c" type="monotone" dataKey="cumulative" name="เพิ่มสะสมในช่วงนี้" stroke="#f59e0b" strokeWidth={2} dot={false} isAnimationActive={motion} />
                  {d.firstPosted >= firstDay && <ReferenceLine yAxisId="v" x={d.firstPosted} stroke="#64748b" strokeDasharray="4 3" label={{ value: "โพสต์", fontSize: 11, position: "insideTopLeft" }} />}
                  {d.peak && <ReferenceLine yAxisId="v" x={d.peak.date} stroke="#16a34a" strokeDasharray="4 3" label={{ value: "พีค", fontSize: 11, position: "insideTopRight" }} />}
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <p className="growth-notice">ไม่มีข้อมูลรายวันของคลิปนี้ในช่วงที่เลือก</p>
          )}
          {!loadingDays && d.daysWithData > 0 && (
            <div className="pi-legend">
              {d.platforms.map((p) => (
                <button key={p} type="button" className={hidden.has(p) ? "off" : ""} onClick={() => toggle(p)} aria-pressed={!hidden.has(p)}>
                  <i style={{ background: colorOf(p) }} />
                  {p}
                </button>
              ))}
              <span className="cm-legend-line">
                <i /> เพิ่มสะสมในช่วงนี้
              </span>
            </div>
          )}
          <p className="audience-note">
            วันที่ = วันที่มีคนดู · ระบบ sync ทุกเช้า (ราว 8 โมง) แล้วนับวิวที่เพิ่มจากรอบก่อนเป็นของวันก่อนหน้า จึงเป็นช่วง 8 โมงถึง 8 โมงเช้าวันถัดไป (ชี้ที่กราฟเพื่อดูเวลาจริง) · ยอดล่าสุดคือเมื่อวาน
            · เส้นส้ม = วิวที่เพิ่มรวมกันตั้งแต่วันแรกของช่วง (แกนขวา) · เส้นประ "โพสต์" = วันที่โพสต์ · "พีค" = วันที่วิวเพิ่มมากที่สุด
            · ข้อมูลรายวันมีเฉพาะโพสต์ที่ดึงผ่าน API และวันที่ระบบเก็บข้อมูลแล้ว ไม่รวมแถวที่ทีมกรอกเอง
          </p>
        </section>

        {/* YouTube Analytics of the clip; shows nothing without YouTube Deep Dive. */}
        <YtClipBox posts={d.posts} />

        <section className="clip-detail-box">
          <h3>
            <Clock size={15} /> ช่วงเวลาที่โพสต์
          </h3>
          <ul className="clip-detail-hours">
            {d.posts.map((p) => (
              <li key={`h-${p.key || p.row.url}`}>
                <b style={{ color: colorOf(p.row.platform) }}>{p.row.platform}</b> <small>{p.row.vdoType}</small>
                <span>{hourText(p)}</span>
                <HourChart post={p} />
              </li>
            ))}
          </ul>
          <p className="audience-note">ค่ากลาง = วิวต่อคลิปของแพลตฟอร์มและรูปแบบเดียวกันที่โพสต์ในชั่วโมงนั้น ช่วง 90 วันก่อนโพสต์ (ต้องมีอย่างน้อย 3 คลิป) · กราฟ: แท่งเขียว = ชั่วโมงที่ดีที่สุด · เส้นประ = ชั่วโมงที่คลิปนี้โพสต์</p>
        </section>

        {facts.length > 0 && (
          <section className="clip-detail-box">
            <h3>
              <Share2 size={15} /> สรุปจากตัวเลข
            </h3>
            <FactCards facts={[...new Set(facts)]} />
            <p className="audience-note">คิดจากกฎตายตัว ไม่ใช่ AI · เป็นความสัมพันธ์ของตัวเลข ไม่ได้บอกสาเหตุ</p>
          </section>
        )}

        {/* YouTube / Facebook comments; shows nothing without วิเคราะห์เชิงลึก. */}
        <ClipComments posts={d.posts.length ? d.posts.map((p) => p.row) : [clip]} />
      </aside>
    </div>,
    document.body,
  );
}
