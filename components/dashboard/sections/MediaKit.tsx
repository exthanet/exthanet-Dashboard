"use client";
// Media Kit under the ผู้ติดตาม board, for the sales team: 12-month totals, who follows /
// watches each show (YouTube viewers through the CMS, Instagram followers through Metricool),
// each show's last 90 days, and the top clips with links. Numbers come from masterData and
// the sync's accountStats / audienceStats, so they match the rest of the dashboard.
import { useEffect, useMemo, useState } from "react";
import { Download, ExternalLink } from "lucide-react";
import type { RecordRow } from "@/lib/dashboard/types";
import { PLATFORM_LABEL, PROGRAM_GROUP, currentFollowers, groupOf, shortCount, type AccountStat, type SocialAccount } from "@/lib/dashboard/socialAccounts";
import { loadAudience, type Audience } from "@/lib/socialAccountsData";
import { dateLabel } from "@/lib/dashboard/format";

const full = (v: number) => Math.round(v).toLocaleString("en-US");
const NOT_SHOWS = new Set(["PROMO", "ไม่ระบุ", ""]);
const AGES = ["13-17", "18-24", "25-34", "35-44", "45-54", "55-64", "65+"];
const GENDER_LABEL: Record<string, string> = { male: "ชาย", female: "หญิง", other: "ไม่ระบุ" };

const minusDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) - n * 86400000).toISOString().slice(0, 10);

export function MediaKit({ accounts, stats, rows, total, views12 }: { accounts: SocialAccount[]; stats: Record<string, AccountStat>; rows: RecordRow[]; total: number; views12: number }) {
  const [audience, setAudience] = useState<Record<string, Audience>>({});
  useEffect(() => {
    loadAudience()
      .then(setAudience)
      .catch(() => setAudience({}));
  }, []);

  const last = useMemo(() => rows.filter((r) => r.platform !== "TV").map((r) => r.date).sort().pop() || "", [rows]);
  const year = useMemo(() => (last ? rows.filter((r) => r.date > minusDays(last, 365) && r.date <= last) : []), [rows, last]);
  const digital12 = useMemo(() => year.filter((r) => r.platform !== "TV"), [year]);
  const kpi = useMemo(() => {
    const likes = digital12.reduce((a, r) => a + (r.likes || 0), 0);
    const comments = digital12.reduce((a, r) => a + (r.comments || 0), 0);
    const shares = digital12.reduce((a, r) => a + (r.shares || 0), 0);
    const tv = year.filter((r) => r.platform === "TV").reduce((a, r) => a + (r.audienceTotal || 0) + (r.gmmAudience || 0), 0);
    return {
      posts: digital12.length,
      likes,
      comments,
      shares,
      million: digital12.filter((r) => r.views >= 1_000_000).length,
      tenMillion: digital12.filter((r) => r.views >= 10_000_000).length,
      tv,
    };
  }, [digital12, year]);

  // Each show's last 90 days; followers = the board's accounts of that show.
  const shows = useMemo(() => {
    if (!last) return [];
    const from = minusDays(last, 89);
    const byProgram = new Map<string, RecordRow[]>();
    for (const r of rows) {
      if (r.platform === "TV" || r.date < from || r.date > last || NOT_SHOWS.has(r.program)) continue;
      byProgram.set(r.program, [...(byProgram.get(r.program) || []), r]);
    }
    return [...byProgram]
      .filter(([, l]) => l.length >= 20)
      .map(([program, l]) => {
        const views = l.reduce((a, r) => a + (r.views || 0), 0);
        const eng = l.reduce((a, r) => a + (r.likes || 0) + (r.comments || 0) + (r.shares || 0), 0);
        const group = PROGRAM_GROUP[program] || program;
        const followers = accounts.filter((a) => groupOf(a) === group).reduce((s, a) => s + (currentFollowers(a, stats[a.id])?.value || 0), 0);
        return { program, posts: l.length, views, avg: views / l.length, er: views ? eng / views : 0, followers };
      })
      .sort((a, b) => b.views - a.views);
  }, [rows, last, accounts, stats]);

  const top = useMemo(() => {
    if (!last) return [];
    const from = minusDays(last, 89);
    return rows
      .filter((r) => r.platform !== "TV" && r.date >= from && r.date <= last)
      .sort((a, b) => b.views - a.views)
      .slice(0, 10);
  }, [rows, last]);

  const audiences = useMemo(
    () =>
      accounts
        .filter((a) => audience[a.id])
        .map((a) => ({ a, au: audience[a.id] }))
        .sort((x, y) => groupOf(x.a).localeCompare(groupOf(y.a), "th") || x.a.platform.localeCompare(y.a.platform)),
    [accounts, audience],
  );

  const exportCsv = () => {
    const cell = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const lines: unknown[][] = [
      ["Media Kit", `ข้อมูลถึง ${last}`],
      [],
      ["ภาพรวม 12 เดือน", "ค่า"],
      ["ผู้ติดตามรวม", total],
      ["วิวออนไลน์", views12],
      ["โพสต์", kpi.posts],
      ["ไลก์", kpi.likes],
      ["คอมเมนต์", kpi.comments],
      ["แชร์", kpi.shares],
      ["คลิปเกิน 1 ล้านวิว", kpi.million],
      ["ผู้ชม TV", kpi.tv],
      [],
      ["รายการ (90 วัน)", "ผู้ติดตาม", "โพสต์", "วิว", "วิวเฉลี่ยต่อคลิป", "ER"],
      ...shows.map((s) => [s.program, s.followers, s.posts, s.views, Math.round(s.avg), `${(s.er * 100).toFixed(2)}%`]),
      [],
      ["กลุ่มผู้ชม", "แพลตฟอร์ม", "บัญชี", "ชาย %", "หญิง %", ...AGES.map((x) => `${x} %`), "ช่วงข้อมูล", "ที่มา"],
      ...audiences.map(({ a, au }) => [groupOf(a), PLATFORM_LABEL[a.platform], a.name, (au.gender.male || 0).toFixed(1), (au.gender.female || 0).toFixed(1), ...AGES.map((x) => (au.age[x] || 0).toFixed(1)), `${au.from} – ${au.to}`, au.source]),
      [],
      ["คลิปเด่น 90 วัน", "รายการ", "แพลตฟอร์ม", "วันที่", "วิว", "ลิงก์"],
      ...top.map((r) => [r.topic, r.program, r.platform, r.date, r.views, r.url]),
    ];
    const csv = "﻿" + lines.map((l) => l.map(cell).join(",")).join("\r\n");
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    link.download = `media-kit-${last}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
  };

  if (!last) return null;

  return (
    <section className="media-kit" id="media-kit">
      <div className="media-kit-head">
        <div>
          <h2>Media Kit</h2>
          <p>สำหรับทีมขาย · ข้อมูลถึง {dateLabel(last)} · ตัวเลขจากโพสต์ในระบบ ผู้ติดตามจากบอร์ดด้านบน</p>
        </div>
        <button className="tv-add" onClick={exportCsv}>
          <Download size={14} /> Export CSV
        </button>
      </div>

      <h3>ภาพรวม 12 เดือน</h3>
      <div className="media-kit-kpis">
        <div>ผู้ติดตามรวม<b>{shortCount(total)}</b>{full(total)} คน · {accounts.length} บัญชี</div>
        <div>วิวออนไลน์<b>{shortCount(views12)}</b>{full(kpi.posts)} โพสต์</div>
        <div>Engagement<b>{shortCount(kpi.likes + kpi.comments + kpi.shares)}</b>ไลก์ {shortCount(kpi.likes)} · คอมเมนต์ {shortCount(kpi.comments)} · แชร์ {shortCount(kpi.shares)}</div>
        <div>คลิปเกิน 1 ล้านวิว<b>{full(kpi.million)}</b>เกิน 10 ล้าน {full(kpi.tenMillion)} คลิป</div>
        {kpi.tv > 0 && <div>ผู้ชม TV<b>{shortCount(kpi.tv)}</b>One31 + GMM25</div>}
      </div>

      <h3>
        กลุ่มผู้ชม <small>YouTube: ผู้ชม 90 วัน (YouTube Analytics) · Instagram: ผู้ติดตาม (Metricool) · Facebook และ TikTok ยังไม่มีข้อมูลนี้</small>
      </h3>
      {audiences.length ? (
        <div className="media-kit-audience">
          {audiences.map(({ a, au }) => {
            const m = au.gender.male || 0;
            const f = au.gender.female || 0;
            const ageMax = Math.max(1, ...AGES.map((x) => au.age[x] || 0));
            return (
              <div key={a.id}>
                <strong>{groupOf(a)}</strong>
                <span className="media-kit-sub">{PLATFORM_LABEL[a.platform]} · {a.name}</span>
                <span className="media-kit-gender" title={Object.entries(au.gender).map(([k, v]) => `${GENDER_LABEL[k] || k} ${v.toFixed(0)}%`).join(" · ")}>
                  <i style={{ width: `${m}%`, background: "#378add" }} />
                  <i style={{ width: `${f}%`, background: "#d4537e" }} />
                </span>
                <span className="media-kit-sub">ชาย {m.toFixed(0)}% · หญิง {f.toFixed(0)}%</span>
                {AGES.filter((x) => au.age[x]).map((x) => (
                  <span key={x} className="media-kit-age">
                    <span>{x}</span>
                    <i style={{ width: `${((au.age[x] || 0) / ageMax) * 100}%` }} />
                    <span>{(au.age[x] || 0).toFixed(0)}%</span>
                  </span>
                ))}
              </div>
            );
          })}
        </div>
      ) : (
        <p className="ranking-empty">ยังไม่มีข้อมูลกลุ่มผู้ชม · sync จะเก็บให้รอบถัดไป</p>
      )}

      <h3>ผลงานแต่ละรายการ · 90 วัน</h3>
      <div className="media-kit-table">
        <table>
          <thead>
            <tr>
              <th>รายการ</th>
              <th className="num">ผู้ติดตาม</th>
              <th className="num">โพสต์</th>
              <th className="num">วิว</th>
              <th className="num">วิวเฉลี่ย/คลิป</th>
              <th className="num">ER</th>
            </tr>
          </thead>
          <tbody>
            {shows.map((s) => (
              <tr key={s.program}>
                <td>{s.program}</td>
                <td className="num">{s.followers ? shortCount(s.followers) : "–"}</td>
                <td className="num">{full(s.posts)}</td>
                <td className="num">{shortCount(s.views)}</td>
                <td className="num">{full(s.avg)}</td>
                <td className="num">{(s.er * 100).toFixed(2)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h3>คลิปเด่น 90 วัน</h3>
      <div className="media-kit-table">
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>คลิป</th>
              <th>รายการ</th>
              <th>แพลตฟอร์ม</th>
              <th className="num">วิว</th>
            </tr>
          </thead>
          <tbody>
            {top.map((r, i) => (
              <tr key={`${r.url}-${i}`}>
                <td>{i + 1}</td>
                <td className="media-kit-clip">
                  {/^https?:\/\//.test(r.url) ? (
                    <a href={r.url} target="_blank" rel="noopener noreferrer">
                      {r.topic} <ExternalLink size={12} />
                    </a>
                  ) : (
                    r.topic
                  )}
                </td>
                <td>{r.program}</td>
                <td>{r.platform}</td>
                <td className="num">{full(r.views)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
