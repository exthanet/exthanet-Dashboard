"use client";
// วิเคราะห์เชิงลึก → รายงานรวมแพลตฟอร์ม: every platform on one page, laid out as
// output/platform-report-demo.html: headline tiles, Cross Platform, Digital vs TV,
// share / bars / top topics by views, competitors on both
// TV channels (PlatformTop.tsx), a board per platform in its own look (PlatformStudio.tsx),
// TV, Platform Insight and the Hashtag Report (PlatformInsight.tsx).
// Filters at the top apply, except the platform filter (every platform is shown).
import { useMemo, useState } from "react";
import { BarChart3 } from "lucide-react";
import type { RecordRow } from "@/lib/dashboard/types";
import { inRange } from "@/lib/dashboard/platformReport";
import { DIGITAL, type PageMetric } from "@/lib/dashboard/platformStudio";
import { PlatformStudio, TvStudio } from "@/components/dashboard/sections/PlatformStudio";
import { CrossPlatform, HashtagReport, PlatformInsight } from "@/components/dashboard/sections/PlatformInsight";
import { CompetitorLines, DigitalVsTv, PlatformBars, PlatformShare, TopKpis, TopTopics } from "@/components/dashboard/sections/PlatformTop";
import { ClipDetailPanel } from "@/components/dashboard/sections/ClipDetailPanel";

const thDate = (iso: string) => (iso ? new Intl.DateTimeFormat("th-TH", { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" }).format(new Date(`${iso}T00:00:00Z`)) : "");

interface Props {
  /** Rows passing the filters except platform and date. */
  rows: RecordRow[];
  /** Every row, for the clip analysis panel. */
  allRows: RecordRow[];
  startDate: string;
  endDate: string;
  comparePeriod: { start: string; end: string } | null;
  latestDate: string;
  /** YouTube Analytics boxes (watch time, subscribers, retention, traffic sources). */
  canDeepDive: boolean;
}

export function PlatformReportSection({ rows, allRows, startDate, endDate, comparePeriod, latestDate, canDeepDive }: Props) {
  const [opened, setOpened] = useState<RecordRow | null>(null);
  // The share, bars and top topics follow views (the ยอดวิว / จำนวนโพสต์ / ER switch was taken off).
  const metric: PageMetric = "views";
  const cur = useMemo(() => inRange(rows, startDate, endDate), [rows, startDate, endDate]);
  const prev = useMemo(() => (comparePeriod ? inRange(rows, comparePeriod.start, comparePeriod.end) : []), [rows, comparePeriod]);
  const compareText = comparePeriod ? `เทียบ ${thDate(comparePeriod.start)} – ${thDate(comparePeriod.end)}` : "";
  const of = (list: RecordRow[], p: string) => list.filter((r) => r.platform === p);
  const tvCur = useMemo(() => of(cur, "TV"), [cur]);
  const tvAll = useMemo(() => of(rows, "TV"), [rows]);

  return (
    <section className="panel platform-report" id="platform-report">
      {opened && <ClipDetailPanel clip={opened} allRows={allRows} latestDate={latestDate} onClose={() => setOpened(null)} />}
      <div className="panel-head pr-head">
        <div>
          <h2>
            <BarChart3 size={18} /> รายงานรวมแพลตฟอร์ม
          </h2>
          <p className="growth-sub">
            {thDate(startDate)} – {thDate(endDate)} · ตามตัวกรองด้านบน (ยกเว้นแพลตฟอร์ม: แสดงทุกแพลตฟอร์ม){compareText ? ` · % ${compareText}` : ""}
          </p>
        </div>
      </div>

      {!cur.length && <p className="growth-notice">ไม่มีข้อมูลในช่วงและตัวกรองนี้</p>}

      {cur.length > 0 && (
        <>
          <CrossPlatform cur={cur} startDate={startDate} endDate={endDate} />
          <TopKpis cur={cur} prev={prev} compareText={compareText} />
          <div className="pt-grid g2">
            <DigitalVsTv cur={cur} startDate={startDate} endDate={endDate} />
            <PlatformShare cur={cur} metric={metric} />
          </div>
          <div className="pt-grid g11">
            <PlatformBars cur={cur} metric={metric} />
            <TopTopics cur={cur} metric={metric} />
          </div>
          <CompetitorLines tvRows={tvAll} startDate={startDate} endDate={endDate} />

          {DIGITAL.map((p) => {
            const c = of(cur, p);
            return (
              <div key={p} className="pr-block">
                <h2 className="pr-sec">
                  {p}
                </h2>
                {c.length ? (
                  <PlatformStudio
                    platform={p}
                    cur={c}
                    prev={of(prev, p)}
                    mine={of(rows, p)}
                    startDate={startDate}
                    endDate={endDate}
                    latestDate={latestDate}
                    compareText={compareText}
                    canDeepDive={canDeepDive}
                    onOpen={setOpened}
                  />
                ) : (
                  <p className="growth-notice">ไม่มีข้อมูล {p} ในช่วงและตัวกรองนี้</p>
                )}
              </div>
            );
          })}

          <div className="pr-block">
            <h2 className="pr-sec">
              TV Rating <small>One31 และ GMM25</small>
            </h2>
            {tvCur.length ? (
              <TvStudio cur={tvCur} prev={of(prev, "TV")} mine={tvAll} startDate={startDate} endDate={endDate} compareText={compareText} />
            ) : (
              <p className="growth-notice">ไม่มีข้อมูล TV ในช่วงและตัวกรองนี้</p>
            )}
          </div>

          <div className="pr-block">
            <h2 className="pr-sec">
              Platform Insight <small>เปรียบเทียบทุกแพลตฟอร์ม</small>
            </h2>
            <PlatformInsight cur={cur} prev={prev} startDate={startDate} endDate={endDate} compareText={compareText} />
          </div>

          <div className="pr-block">
            <h2 className="pr-sec">
              Hashtag Report <small>รวมทุกแพลตฟอร์ม และแยกแพลตฟอร์ม</small>
            </h2>
            <HashtagReport cur={cur} prev={prev} endDate={endDate} onOpen={setOpened} />
          </div>
        </>
      )}
    </section>
  );
}
