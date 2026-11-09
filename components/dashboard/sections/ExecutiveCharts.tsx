"use client";
import { useEffect, useState } from "react";
import { ViewPie } from "@/components/dashboard/charts/ViewPie";
import { Empty } from "@/components/dashboard/shared/Empty";
import type { DashboardModel } from "@/hooks/useDashboard";
import { PLATFORM_COLORS, TOPIC_COLORS } from "@/lib/dashboard/constants";
import { compact, dateLabel, num } from "@/lib/dashboard/format";
import {
  Area,
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

const TV_COLOR = "#f59e0b";
const TV_KEY = "TV Audience";

/** เส้น / แท่ง / พื้นที่ซ้อน / สัดส่วน 100% (one switch for both charts here). */
export type ExecutiveChartType = "line" | "bar" | "area" | "pct";
const CHART_TYPES: { id: ExecutiveChartType; label: string }[] = [
  { id: "line", label: "เส้น" },
  { id: "bar", label: "แท่ง" },
  { id: "area", label: "พื้นที่ซ้อน" },
  { id: "pct", label: "สัดส่วน 100%" },
];

/** `stack`: the series adds up with the others (platforms, VDO types); TV audience stays its own line. */
type Series = { key: string; color: string; stack?: string };

/** Motion follows the computer's "reduce motion" setting. */
function useMotion() {
  const [on, setOn] = useState(true);
  useEffect(() => {
    const mql = window.matchMedia("(prefers-reduced-motion: reduce)");
    const apply = () => setOn(!mql.matches);
    apply();
    mql.addEventListener("change", apply);
    return () => mql.removeEventListener("change", apply);
  }, []);
  return on;
}

/** Each period's stacked series as % of their total (TV audience, another unit, is left out). */
function toShares(data: Record<string, number | string>[], keys: string[]) {
  return data.map((row) => {
    const sum = keys.reduce((a, k) => a + (Number(row[k]) || 0), 0);
    const out: Record<string, number | string> = { date: row.date };
    for (const k of keys) out[k] = sum > 0 ? ((Number(row[k]) || 0) / sum) * 100 : 0;
    return out;
  });
}

/** One trend chart with the period axis shared by both charts here. */
function TrendChart({
  data,
  series,
  type,
  grain,
}: {
  data: Record<string, number | string>[];
  series: Series[];
  type: ExecutiveChartType;
  grain: "day" | "month";
}) {
  const motion = useMotion();
  // Click a name in the legend to hide / show that series (at least one stays).
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const stacked = series.filter((s) => s.stack);
  const shown = (key: string) => !hidden.has(key);
  const pct = type === "pct";
  // A period without a series counts as 0 for stacking (otherwise stacked areas break at that point).
  const filled = type === "line" ? data : data.map((row) => Object.fromEntries([...Object.entries(row), ...stacked.filter((s) => row[s.key] === undefined).map((s) => [s.key, 0])]));
  const chartData = pct ? toShares(filled, stacked.filter((s) => shown(s.key)).map((s) => s.key)) : filled;
  if (!data.length || !series.length) return <Empty />;

  const anim = { isAnimationActive: motion, animationDuration: 600, animationEasing: "ease-out" as const };
  const toggle = (key: string) =>
    setHidden((h) => {
      const next = new Set(h);
      if (next.has(key)) next.delete(key);
      else if (series.filter((s) => !next.has(s.key)).length > 1) next.add(key);
      return next;
    });
  const xAxis = <XAxis dataKey="date" tickFormatter={(v) => (grain === "day" ? dateLabel(v) : v)} tick={{ fontSize: 11 }} />;
  const yAxis = pct ? <YAxis domain={[0, 100]} tickFormatter={(v) => `${v}%`} tick={{ fontSize: 11 }} /> : <YAxis tickFormatter={compact} tick={{ fontSize: 11 }} />;
  const tooltip = (
    <Tooltip
      formatter={(v) => (pct ? `${Number(v).toFixed(1)}%` : num(Number(v)))}
      labelFormatter={(v) => (grain === "day" ? dateLabel(String(v)) : String(v))}
    />
  );
  const legend = (
    <Legend
      onClick={(e) => e.dataKey && toggle(String(e.dataKey))}
      formatter={(value) => (
        <span className={`chart-legend-item${hidden.has(String(value)) ? " off" : ""}`} title="คลิกเพื่อซ่อน / แสดง">
          {value}
        </span>
      )}
      wrapperStyle={{ cursor: "pointer" }}
      // Same order as the series (biggest first), not alphabetical.
      itemSorter={(item) => series.findIndex((s) => s.key === item.dataKey)}
    />
  );
  const grid = <CartesianGrid vertical={false} stroke="#e8edf5" />;
  const tvLine = (s: Series) => (
    <Line key={s.key} type="monotone" dataKey={s.key} stroke={s.color} strokeWidth={3} strokeDasharray="6 3" dot={false} connectNulls hide={!shown(s.key)} {...anim} />
  );

  return (
    <ResponsiveContainer>
      {type === "line" ? (
        <LineChart data={chartData}>
          {grid}
          {xAxis}
          {yAxis}
          {tooltip}
          {legend}
          {series.map((s) =>
            s.key === TV_KEY ? (
              tvLine(s)
            ) : (
              <Line key={s.key} type="monotone" dataKey={s.key} stroke={s.color} strokeWidth={2.2} dot={false} connectNulls hide={!shown(s.key)} {...anim} />
            ),
          )}
        </LineChart>
      ) : type === "bar" ? (
        <BarChart data={chartData}>
          {grid}
          {xAxis}
          {yAxis}
          {tooltip}
          {legend}
          {series.map((s) => (
            <Bar key={s.key} dataKey={s.key} fill={s.color} stackId={s.stack} radius={s.stack ? undefined : [4, 4, 0, 0]} hide={!shown(s.key)} {...anim} />
          ))}
        </BarChart>
      ) : (
        // Area and 100% share one chart, so switching between them morphs the shapes.
        <ComposedChart data={chartData}>
          {grid}
          {xAxis}
          {yAxis}
          {tooltip}
          {legend}
          {series.map((s) =>
            s.stack ? (
              <Area key={s.key} type="monotone" dataKey={s.key} stackId={s.stack} stroke={s.color} fill={s.color} fillOpacity={0.7} strokeWidth={1.5} hide={!shown(s.key)} {...anim} />
            ) : pct ? null : (
              tvLine(s)
            ),
          )}
        </ComposedChart>
      )}
    </ResponsiveContainer>
  );
}

/** Totals of the periods in the chart, per series, with each stacked series' share. */
/** Totals under a chart; with onPick each total is a button (Cross Platform opens that platform's report). */
function SeriesTotals({ data, series, onPick }: { data: Record<string, number | string>[]; series: Series[]; onPick?: (key: string) => void }) {
  const totals = series.map((s) => ({ ...s, total: data.reduce((a, row) => a + (Number(row[s.key]) || 0), 0) }));
  const stackedSum = totals.filter((t) => t.stack).reduce((a, t) => a + t.total, 0);
  if (!data.length) return null;
  return (
    <div className="series-totals">
      {totals.map((t) => {
        const body = (
          <>
            <small>{t.key}</small>
            <b>{compact(t.total)}</b>
            {t.stack && stackedSum > 0 && <span>{((t.total / stackedSum) * 100).toFixed(0)}%</span>}
          </>
        );
        return onPick ? (
          <button key={t.key} type="button" className="series-total-pick" style={{ borderColor: t.color }} onClick={() => onPick(t.key)} title={`ดูรายงาน ${t.key}`}>
            {body}
            <em>ดูรายงาน ›</em>
          </button>
        ) : (
          <div key={t.key} style={{ borderColor: t.color }}>
            {body}
          </div>
        );
      })}
    </div>
  );
}

export function ExecutiveCharts({
  executiveChartType,
  setExecutiveChartType,
  executiveGrain,
  digitalVsTv,
  digitalPlatforms,
  vdoTypeTrend,
  accountPie,
  programPie,
  platformPie,
  vdoTypePie,
  onOpenPlatform,
}: { onOpenPlatform?: (platform: string) => void } & Pick<
  DashboardModel,
  | "executiveChartType"
  | "setExecutiveChartType"
  | "executiveGrain"
  | "digitalVsTv"
  | "digitalPlatforms"
  | "vdoTypeTrend"
  | "accountPie"
  | "programPie"
  | "platformPie"
  | "vdoTypePie"
>) {
  const grainText = executiveGrain === "day" ? "รายวัน" : "รายเดือน";
  // Digital platforms stack (bars, areas, 100%); TV audience is another unit, so it stays a line of its own.
  const platformSeries: Series[] = [
    ...digitalPlatforms.map((p) => ({ key: p, color: PLATFORM_COLORS[p] || "#64748b", stack: "digital" })),
    { key: TV_KEY, color: TV_COLOR },
  ];
  const vdoSeries: Series[] = vdoTypeTrend.keys.map((k, i) => ({
    key: k,
    color: k === "อื่นๆ" ? "#94a3b8" : TOPIC_COLORS[i % TOPIC_COLORS.length],
    stack: "vdo",
  }));
  const toggle = (
    <div className="segmented chart-type-toggle" role="group" aria-label="รูปแบบกราฟ">
      {CHART_TYPES.map((t) => (
        <button key={t.id} className={executiveChartType === t.id ? "active" : ""} onClick={() => setExecutiveChartType(t.id)}>
          {t.label}
        </button>
      ))}
    </div>
  );
  const pctNote = executiveChartType === "pct" ? " · สัดส่วน 100% = % ของออนไลน์ในแต่ละช่วง (ไม่รวมผู้ชมทีวี)" : "";

  return (
    <section className="executive-view-grid executive-paired">
      <article className="panel executive-line">
        <div className="panel-head">
          <div>
            <h2>Cross Platform</h2>
            <p>
              แยกแต่ละแพลตฟอร์มเทียบผู้ชมทีวี · {grainText} · ผู้ชมทีวีนับเป็นจำนวนคน (เส้นประ) · คลิกชื่อเพื่อซ่อน/แสดง · กดตัวเลขด้านล่างเพื่อดูรายงานแพลตฟอร์ม{pctNote}
            </p>
          </div>
          {toggle}
        </div>
        <div className="chart-lg">
          <TrendChart data={digitalVsTv} series={platformSeries} type={executiveChartType} grain={executiveGrain} />
        </div>
        <SeriesTotals data={digitalVsTv} series={platformSeries} onPick={onOpenPlatform && ((k) => onOpenPlatform(k === TV_KEY ? "TV" : k))} />
      </article>
      {/* Phones skip the pies: each repeats a panel further down */}
      <div className="mobile-hide executive-side">
        <ViewPie
          id="platforms"
          title="สัดส่วน Cross Platform"
          subtitle="สัดส่วน Views / TV Audience"
          data={platformPie}
          colors={{ ...PLATFORM_COLORS, TV: TV_COLOR }}
        />
      </div>

      <article className="panel executive-line">
        <div className="panel-head">
          <div>
            <h2>VDO Type</h2>
            <p>
              ยอดวิวแยกรูปแบบวิดีโอ · {grainText} · ทีวีนับผู้ชม · คลิกชื่อเพื่อซ่อน/แสดง{executiveChartType === "pct" ? " · สัดส่วน 100% = % ของทุกรูปแบบในแต่ละช่วง" : ""}
            </p>
          </div>
          {toggle}
        </div>
        <div className="chart-lg">
          <TrendChart data={vdoTypeTrend.data} series={vdoSeries} type={executiveChartType} grain={executiveGrain} />
        </div>
      </article>
      <div className="mobile-hide executive-side">
        <ViewPie title="สัดส่วน VDO Type" subtitle="สัดส่วนยอดวิวตามรูปแบบวิดีโอ" data={vdoTypePie} />
      </div>

      {/* Views by account / page (left) beside views by program (right), same size. */}
      <div className="executive-pair-row">
        <ViewPie title="สัดส่วนยอดวิวตามบัญชี/เพจ" subtitle="เฉพาะออนไลน์ · ทุกแพลตฟอร์ม" data={accountPie} />
        {/* Shown on phones too: the Program panel further down was removed. */}
        <div className="executive-side">
          <ViewPie title="สัดส่วนรายการทั้งหมด" subtitle="สัดส่วนยอดวิวตาม Program" data={programPie} />
        </div>
      </div>
    </section>
  );
}
