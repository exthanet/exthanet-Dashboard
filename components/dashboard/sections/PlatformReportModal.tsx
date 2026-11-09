"use client";
// One platform's board from รายงานรวมแพลตฟอร์ม (PlatformStudio / TvStudio), opened over the
// overview from the Cross Platform totals. Same rows, range and comparison as that report;
// a switch at the top moves between platforms without closing.
import { useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";
import type { RecordRow } from "@/lib/dashboard/types";
import { inRange } from "@/lib/dashboard/platformReport";
import { DIGITAL } from "@/lib/dashboard/platformStudio";
import { PLATFORM_COLORS } from "@/lib/dashboard/constants";
import { PlatformStudio, TvStudio } from "@/components/dashboard/sections/PlatformStudio";
import { ClipDetailPanel } from "@/components/dashboard/sections/ClipDetailPanel";

const thDate = (iso: string) => (iso ? new Intl.DateTimeFormat("th-TH", { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" }).format(new Date(`${iso}T00:00:00Z`)) : "");
const PLATFORMS = [...DIGITAL, "TV"] as const;

export function PlatformReportModal({
  platform,
  onClose,
  rows,
  allRows,
  startDate,
  endDate,
  comparePeriod,
  latestDate,
  canDeepDive,
}: {
  /** "Facebook", "TikTok", "YouTube", "Instagram" or "TV"; null = closed. */
  platform: string | null;
  onClose: () => void;
  /** Rows passing the filters except platform and date (as รายงานรวมแพลตฟอร์ม). */
  rows: RecordRow[];
  allRows: RecordRow[];
  startDate: string;
  endDate: string;
  comparePeriod: { start: string; end: string } | null;
  latestDate: string;
  canDeepDive: boolean;
}) {
  const [shown, setShown] = useState(platform);
  const [opened, setOpened] = useState<RecordRow | null>(null);
  useEffect(() => setShown(platform), [platform]);
  useEffect(() => {
    if (!platform) return;
    const esc = (e: KeyboardEvent) => e.key === "Escape" && !opened && onClose();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [platform, opened, onClose]);

  const cur = useMemo(() => inRange(rows, startDate, endDate), [rows, startDate, endDate]);
  const prev = useMemo(() => (comparePeriod ? inRange(rows, comparePeriod.start, comparePeriod.end) : []), [rows, comparePeriod]);
  if (!platform || !shown) return null;
  const of = (list: RecordRow[]) => list.filter((r) => r.platform === shown);
  const c = of(cur);
  const compareText = comparePeriod ? `เทียบ ${thDate(comparePeriod.start)} – ${thDate(comparePeriod.end)}` : "";

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <section className="source-modal platform-modal platform-report" onClick={(e) => e.stopPropagation()}>
        {opened && <ClipDetailPanel clip={opened} allRows={allRows} latestDate={latestDate} onClose={() => setOpened(null)} />}
        <button className="close" onClick={onClose} aria-label="ปิด">
          <X size={18} />
        </button>
        <div className="platform-modal-head">
          <div>
            <h2>{shown === "TV" ? "TV Rating" : shown}</h2>
            <p className="growth-sub">
              {thDate(startDate)} – {thDate(endDate)} · ตามตัวกรองด้านบน{compareText ? ` · % ${compareText}` : ""}
            </p>
          </div>
          <div className="segmented">
            {PLATFORMS.map((p) => (
              <button key={p} className={shown === p ? "active" : ""} onClick={() => setShown(p)}>
                <i className="platform-modal-dot" style={{ background: p === "TV" ? "#f59e0b" : PLATFORM_COLORS[p] }} />
                {p === "TV" ? "TV" : p}
              </button>
            ))}
          </div>
        </div>
        {!c.length ? (
          <p className="growth-notice">ไม่มีข้อมูล {shown} ในช่วงและตัวกรองนี้</p>
        ) : shown === "TV" ? (
          <TvStudio cur={c} prev={of(prev)} mine={of(rows)} startDate={startDate} endDate={endDate} compareText={compareText} />
        ) : (
          <PlatformStudio
            platform={shown as (typeof DIGITAL)[number]}
            cur={c}
            prev={of(prev)}
            mine={of(rows)}
            startDate={startDate}
            endDate={endDate}
            latestDate={latestDate}
            compareText={compareText}
            canDeepDive={canDeepDive}
            onOpen={setOpened}
          />
        )}
      </section>
    </div>
  );
}
