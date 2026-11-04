"use client";
// TV competitors: a program's rating against same-slot channels or fixed
// news/talk shows, from the TV workbook (lib/dashboard/competitors.ts). Only the
// programs picked in the รายการ filter, and only tabs that have competitors.
import { useEffect, useMemo, useState } from "react";
import { programMatches } from "@/lib/dashboard/programFilter";
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { RecordRow } from "@/lib/dashboard/types";
import { dateLabel } from "@/lib/dashboard/format";
import { TOPIC_COLORS } from "@/lib/dashboard/constants";
import { OWN_KEY, competitorRanking, competitorTrend, outOfRange, type CompetitorMode } from "@/lib/dashboard/competitors";
import { loadTvCompetitors, type CompetitorSource } from "@/lib/tvCompetitorData";
import { Empty } from "@/components/dashboard/shared/Empty";
import { track } from "@/lib/loadingBar";

const OWN_COLOR = "#0757e8";

interface Props {
  /** Rows passing the filters except the date (the chart applies the range itself). */
  rows: RecordRow[];
  program: string;
  startDate: string;
  endDate: string;
  grain: "day" | "month";
}

export function TvCompetitorChart({ rows, program, startDate, endDate, grain }: Props) {
  const [sources, setSources] = useState<CompetitorSource[] | null>(null);
  const [error, setError] = useState("");
  const [picked, setPicked] = useState("");
  const [mode, setMode] = useState<CompetitorMode>("channel");

  useEffect(() => {
    track(loadTvCompetitors())
      .then(setSources)
      .catch((e) => setError(String(e?.message || e)));
  }, []);

  // ONE31 first (it carries both kinds of competitors), then the rest.
  const ordered = useMemo(
    () => [...(sources || [])].sort((a, b) => Number(/gmm/i.test(a.channel)) - Number(/gmm/i.test(b.channel))),
    [sources],
  );
  // Tabs of the picked programs that carry competitors (เงินทองของจริง's have none).
  const available = useMemo(() => ordered.filter((s) => s.rows.length && programMatches(program, s.program)), [ordered, program]);
  const withData = [...new Set(ordered.filter((s) => s.rows.length).map((s) => s.program))];
  const manyPrograms = new Set(available.map((s) => s.program)).size > 1;
  const source = available.find((s) => s.sourceId === picked) || available[0];
  const ownName = source?.program || "";
  const hasSlots = !!source?.rows.some((r) => !r.competitorChannel);
  const view: CompetitorMode = mode === "slot" && !hasSlots ? "channel" : mode;

  // ถกไม่เถียง's own rating per day for this broadcast (merged TV rows: One31 in ratingTotal, GMM25 in gmmRating).
  const own = useMemo(() => {
    const m = new Map<string, number>();
    if (!source) return m;
    const gmm = /gmm/i.test(source.channel);
    for (const r of rows) {
      if (r.platform !== "TV" || r.program !== source.program) continue;
      const v = gmm ? r.gmmRating : r.ratingTotal;
      if (v > 0) m.set(r.date, v);
    }
    return m;
  }, [rows, source]);

  const trend = useMemo(
    () => (source ? competitorTrend(source.rows, own, view, startDate, endDate, grain) : null),
    [source, own, view, startDate, endDate, grain],
  );
  const ranking = useMemo(
    () => (source ? competitorRanking(source.rows, own, view, startDate, endDate) : []),
    [source, own, view, startDate, endDate],
  );
  const skipped = useMemo(() => (source ? outOfRange(source.rows, startDate, endDate) : []), [source, startDate, endDate]);
  const colorOf = (key: string, i: number) => (key === OWN_KEY ? OWN_COLOR : TOPIC_COLORS[(i + 1) % TOPIC_COLORS.length]);

  return (
    <article className="panel full tv-competitors" id="tv-competitors">
      <div className="panel-head">
        <div>
          <h2>คู่แข่ง TV</h2>
          <p>
            Rating ของ{ownName || "รายการ"}เทียบ{view === "channel" ? "ช่องคู่แข่งช่วงเวลาเดียวกัน" : "รายการข่าว / ทอล์กที่ใช้เทียบ"} ·{" "}
            {grain === "day" ? "รายวัน" : "รายเดือน"} · ค่าดิบจากไฟล์ TV
          </p>
        </div>
        <div className="ranking-controls">
          <div className="segmented">
            {available.map((s) => (
              <button key={s.sourceId} className={source?.sourceId === s.sourceId ? "active" : ""} onClick={() => setPicked(s.sourceId)}>
                {manyPrograms ? `${s.program} · ${s.channel}` : s.channel}
              </button>
            ))}
          </div>
          <div className="segmented">
            <button className={view === "channel" ? "active" : ""} onClick={() => setMode("channel")}>
              ช่องช่วงเวลาเดียวกัน
            </button>
            <button className={view === "slot" ? "active" : ""} onClick={() => setMode("slot")} disabled={!hasSlots} title={hasSlots ? "" : "มีเฉพาะรอบ ONE31"}>
              รายการข่าว-ทอล์ก
            </button>
          </div>
        </div>
      </div>

      {error && <p className="growth-notice warn">โหลดข้อมูลคู่แข่งไม่สำเร็จ: {error}</p>}
      {!sources && !error && <p className="growth-notice">กำลังโหลดข้อมูลคู่แข่ง…</p>}
      {sources && !sources.length && <p className="growth-notice">ยังไม่มีข้อมูลคู่แข่ง · อัปโหลดไฟล์ TV แล้ว sync แบบเขียนจริงก่อน</p>}
      {sources && !!sources.length && !source && (
        <p className="growth-notice">
          รายการที่เลือกไม่มีข้อมูลคู่แข่งในไฟล์ TV{withData.length ? ` · มีเฉพาะ${withData.join(", ")}` : ""}
        </p>
      )}

      {skipped.length > 0 && source && (
        <p className="growth-notice warn">
          ไม่นำมาคำนวณ {skipped.length} ค่า เพราะ rating อยู่นอกช่วง 0–30 (น่าจะพิมพ์ผิดในไฟล์ TV):{" "}
          {skipped
            .slice(0, 3)
            .map((r) => `${r.date} ${r.competitorChannel || r.program} = ${r.rating}`)
            .join(" · ")}
          {" "}· แก้ในไฟล์แล้วอัปโหลดใหม่
        </p>
      )}
      {source && trend && (
        <div className="tv-competitor-grid">
          <div className="chart-lg">
            {trend.points.length ? (
              <ResponsiveContainer>
                <LineChart data={trend.points}>
                  <CartesianGrid vertical={false} stroke="#e8edf5" />
                  <XAxis dataKey="date" tickFormatter={(v) => (grain === "day" ? dateLabel(v) : v)} tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} width={44} />
                  <Tooltip
                    labelFormatter={(v) => (grain === "day" ? dateLabel(String(v)) : String(v))}
                    formatter={(v, name, item) => {
                      const prog = (item?.payload as Record<string, string> | undefined)?.[`program:${String(name)}`];
                      return [`${Number(v).toFixed(3)}${prog ? ` · ${prog}` : ""}`, String(name)];
                    }}
                  />
                  <Legend />
                  <Line type="monotone" dataKey={OWN_KEY} stroke={OWN_COLOR} strokeWidth={3.5} dot={false} connectNulls />
                  {trend.series.map((s, i) => (
                    <Line key={s.key} type="monotone" dataKey={s.key} stroke={colorOf(s.key, i)} strokeWidth={1.6} dot={false} connectNulls />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <Empty />
            )}
          </div>
          <div className="tv-competitor-rank">
            <h3>อันดับ rating เฉลี่ยในช่วงนี้</h3>
            {ranking.length ? (
              <table>
                <thead>
                  <tr>
                    <th>#</th>
                    <th>{view === "channel" ? "ช่อง" : "รายการ"}</th>
                    <th className="num">Rating เฉลี่ย</th>
                    <th className="num">{ownName}ชนะ</th>
                  </tr>
                </thead>
                <tbody>
                  {ranking.map((r, i) => (
                    <tr key={r.key} className={r.own ? "own" : ""}>
                      <td>{i + 1}</td>
                      <td>
                        {r.key}
                        {view === "slot" && !r.own && <small> {trend.series.find((s) => s.key === r.key)?.slot}</small>}
                      </td>
                      <td className="num">{r.avg.toFixed(3)}</td>
                      <td className="num">{r.winShare === null ? "-" : `${Math.round(r.winShare * 100)}%`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="ranking-empty">ไม่มีข้อมูลในช่วงนี้</p>
            )}
            <p className="audience-note">“{ownName}ชนะ” = % ของวันที่ออกอากาศทั้งคู่ ที่ rating {ownName}สูงกว่า</p>
          </div>
        </div>
      )}
    </article>
  );
}
