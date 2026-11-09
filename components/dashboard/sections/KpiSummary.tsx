"use client";
import { Growth } from "@/components/dashboard/shared/Growth";
import { Kpi } from "@/components/dashboard/shared/Kpi";
import type { DashboardModel } from "@/hooks/useDashboard";
import { compact, num, pct } from "@/lib/dashboard/format";
import { COMPARE_OPTIONS } from "@/lib/dashboard/dates";
import type { ComparePreset } from "@/lib/dashboard/types";
import { Activity, Gauge, Globe2, Heart, Sparkles, Tv, Upload } from "lucide-react";
import { PLATFORM_COLORS } from "@/lib/dashboard/constants";
const shortDate = (iso: string, withYear = false) =>
  new Intl.DateTimeFormat("th-TH", {
    timeZone: "UTC",
    day: "numeric",
    month: "short",
    ...(withYear ? { year: "numeric" } : {}),
  }).format(new Date(`${iso}T00:00:00Z`));

export function KpiSummary({
  tvMode,
  performanceFiltered,
  metrics,
  types,
  growth,
  comparePeriod,
  compareMode,
  setCompareMode,
  compareStart,
  setCompareStart,
  compareEnd,
  setCompareEnd,
  dataFirstDate,
}: Pick<
  DashboardModel,
  | "tvMode"
  | "performanceFiltered"
  | "metrics"
  | "types"
  | "growth"
  | "comparePeriod"
  | "compareMode"
  | "setCompareMode"
  | "compareStart"
  | "setCompareStart"
  | "compareEnd"
  | "setCompareEnd"
  | "dataFirstDate"
>) {
  const modeLabel = COMPARE_OPTIONS.find((o) => o.value === compareMode)?.label || "";
  const rangeText = comparePeriod
    ? `${shortDate(comparePeriod.start, comparePeriod.start.slice(0, 4) !== comparePeriod.end.slice(0, 4))} – ${shortDate(comparePeriod.end, true)}`
    : "";
  const compareText = comparePeriod ? `เทียบกับ${modeLabel} ${rangeText}` : "";
  // Only render a badge when there is a previous value to compare with.
  const badge = (value: number | null | undefined, label?: string) =>
    growth && value !== null && value !== undefined ? (
      <Growth value={value} label={label} title={compareText} />
    ) : undefined;
  return (
    <>
      <div className="kpi-compare-note">
        <span className="kpi-growth up">▲</span> <span className="kpi-growth down">▼</span> = % เปลี่ยนแปลงเทียบกับ
        <select
          className="compare-select"
          value={compareMode}
          onChange={(e) => setCompareMode(e.target.value as ComparePreset)}
          aria-label="เปรียบเทียบกับ"
        >
          {COMPARE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        {compareMode === "CUSTOM" ? (
          <>
            <input className="compare-date" type="date" value={compareStart} onChange={(e) => setCompareStart(e.target.value)} />
            <b>–</b>
            <input className="compare-date" type="date" value={compareEnd} onChange={(e) => setCompareEnd(e.target.value)} />
          </>
        ) : (
          rangeText && <span>{rangeText}</span>
        )}
        {comparePeriod && !growth && <span className="compare-empty">· ไม่มีข้อมูลในช่วงที่เทียบ</span>}
        {comparePeriod && growth && dataFirstDate && comparePeriod.start < dataFirstDate && (
          <span className="compare-empty">· ข้อมูลช่วงที่เทียบมีตั้งแต่ {shortDate(dataFirstDate, true)} เท่านั้น (ไม่ครบช่วง)</span>
        )}
      </div>
      {/* แถวที่ 1: Reach & Viewership (ยอดวิวรวมทั้งหมด, Digital Views, TV Audience, TV Rating) */}
      <section
        className="kpi-grid kpi-reach"
        style={{
          gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
          marginBottom: 10,
        }}
      >
        <Kpi
          growth={badge(growth?.totalCombinedViews)}
          tone="lead"
          icon={<Globe2 />}
          label="ยอดวิวรวม TV + Digital"
          value={compact(metrics.totalCombinedViews)}
          detail={
            <SplitBar
              parts={[
                { name: "Digital", total: metrics.digitalViews, color: DIGITAL_INK },
                { name: "TV", total: metrics.tvAudience, color: TV_COLOR },
              ]}
            />
          }
        />
        <Kpi
          growth={badge(growth?.views)}
          tone="plain"
          icon={<Activity />}
          label={tvMode ? "TV Audience ตามช่วงเวลา" : "ยอดวิว Digital"}
          value={compact(metrics.views)}
          detail={
            tvMode ? (
              `ONE31 + GMM25 · เฉลี่ย ${compact(metrics.avgDaily)} คน/วัน`
            ) : metrics.digitalViewsByPlatform?.length ? (
              <>
                <SplitBar parts={metrics.digitalViewsByPlatform.map((x) => ({ ...x, color: PLATFORM_COLORS[x.name] || "#9ca3af" }))} short />
                <span className="kpi-note">
                  เฉลี่ย {compact(metrics.avgDaily)} วิว/วัน · {num(performanceFiltered.length)} คอนเทนต์
                </span>
              </>
            ) : (
              "ไม่รวม TV Audience"
            )
          }
        />
        <Kpi
          growth={badge(growth?.tvAudience)}
          tone="plain"
          icon={<Tv />}
          label="ผู้ชม TV"
          value={compact(metrics.tvAudience)}
          detail={`${num(metrics.tvEpisodes)} ตอน · One31 ${num(metrics.one31Episodes)} · GMM25 ${num(metrics.gmm25Episodes)} · เฉลี่ย ${compact(metrics.tvAudienceAvg)} คน/ตอน`}
        />
        <Kpi
          tone="plain"
          icon={<Gauge />}
          label="TV Rating เฉลี่ย"
          value={
            <span className="kpi-pair">
              <span>
                {metrics.ratingAvgOne31 > 0 ? metrics.ratingAvgOne31.toFixed(3) : "-"}
                <small>One31 {badge(growth?.ratingOne31)}</small>
              </span>
              <span>
                {metrics.ratingAvgGmm25 > 0 ? metrics.ratingAvgGmm25.toFixed(3) : "-"}
                <small>GMM25 {badge(growth?.ratingGmm25)}</small>
              </span>
            </span>
          }
          detail={`One31 ${num(metrics.one31Episodes)} ตอน · GMM25 ${num(metrics.gmm25Episodes)} ตอน · เฉลี่ยแยกแต่ละช่อง`}
        />
      </section>

      {/* แถวที่ 2: Engagement & Content Production (Engagement รวม, Engagement Rate, Total Upload) */}
      <section
        className="kpi-grid kpi-engage"
        style={{
          gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
          marginBottom: 12,
        }}
      >
        <Kpi
          growth={badge(growth?.engagement)}
          tone="plain"
          icon={<Heart />}
          label="Engagement"
          value={compact(metrics.engagement)}
          detail={
            tvMode
              ? "TV ไม่มี Social Engagement"
              : `Likes ${compact(metrics.likes)} · Comments ${compact(metrics.comments)} · Shares ${compact(metrics.shares)}`
          }
        />
        <Kpi
          growth={badge(growth?.engagementRate)}
          tone="plain"
          icon={<Sparkles />}
          label="Engagement Rate"
          value={pct(metrics.engagementRate)}
          detail={tvMode ? "TV ไม่มี Social Engagement" : "(Likes + Comments + Shares) ÷ Digital Views"}
        />
        <Kpi
          tone="plain"
          icon={<Upload />}
          label="โพสต์ทั้งหมด"
          value={num(metrics.uploads)}
          detail={
            <>
              {metrics.uploadByPlatform?.length ? (
                <SplitBar parts={metrics.uploadByPlatform.map((x) => ({ ...x, color: PLATFORM_COLORS[x.name] || "#9ca3af" }))} short whole />
              ) : (
                "ไม่มีข้อมูล"
              )}
              {metrics.latestDate && metrics.latestUploadByPlatform?.length ? (
                <span className="kpi-note">
                  ล่าสุด {shortDate(metrics.latestDate)} · {num(metrics.latestUploads)} คลิป ({metrics.latestUploadByPlatform.map((p) => `${p.name} ${num(p.total)}`).join(" · ")})
                </span>
              ) : null}
            </>
          }
        />
      </section>
    </>
  );
}

const DIGITAL_INK = "#111827";
const TV_COLOR = "#f59e0b";
const SHORT: Record<string, string> = { Facebook: "FB", TikTok: "TT", YouTube: "YT", Instagram: "IG" };

/** One thin bar split by share, with a legend: dot, name, number. */
function SplitBar({ parts, short, whole }: { parts: { name: string; total: number; color: string }[]; short?: boolean; whole?: boolean }) {
  const sum = parts.reduce((a, p) => a + (p.total || 0), 0);
  if (!sum) return null;
  return (
    <span className="kpi-split">
      <span className="kpi-split-bar">
        {parts.map((p) => (
          <i key={p.name} style={{ width: `${(p.total / sum) * 100}%`, background: p.color }} title={`${p.name} ${((p.total / sum) * 100).toFixed(0)}%`} />
        ))}
      </span>
      <span className="kpi-split-legend">
        {parts.map((p) => (
          <span key={p.name}>
            <i style={{ background: p.color }} />
            {short ? SHORT[p.name] || p.name : p.name} <b>{whole ? num(p.total) : compact(p.total)}</b>
          </span>
        ))}
      </span>
    </span>
  );
}
