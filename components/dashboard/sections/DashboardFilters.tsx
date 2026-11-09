"use client";
import { SelectBox } from "@/components/dashboard/shared/SelectBox";
import { ProgramChecks } from "@/components/dashboard/shared/ProgramChecks";
import { programLabel } from "@/lib/dashboard/programFilter";
import { Input } from "@/components/ui/input";
import type { DashboardModel } from "@/hooks/useDashboard";
import { bangkokToday, datePresetGroups } from "@/lib/dashboard/dates";
import { DateRangePicker } from "@/components/dashboard/shared/DateRangePicker";
import type { DatePreset } from "@/lib/dashboard/types";
import { Search, X } from "lucide-react";
import { searchTerms } from "@/lib/dashboard/search";

/** The program the dashboard opens with; "ล้างทั้งหมด" goes back to it. */
const DEFAULT_PROGRAM = "ถกไม่เถียง";
const shiftDay = (iso: string, days: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
const thDay = (iso: string, withYear: boolean) =>
  new Intl.DateTimeFormat("th-TH", { timeZone: "UTC", day: "numeric", month: "short", ...(withYear ? { year: "numeric" } : {}) }).format(
    new Date(`${iso}T00:00:00Z`),
  );
/** "3 ก.ย. – 30 ก.ย. 2569" for the selected range; one day: "10 ต.ค. 2569". */
const rangeLabel = (start: string, end: string) =>
  !start || !end ? "" : start === end ? thDay(end, true) : `${thDay(start, start.slice(0, 4) !== end.slice(0, 4))} – ${thDay(end, true)}`;

export function DashboardFilters({
  program,
  setProgram,
  platform,
  setPlatform,
  vdoType,
  setVdoType,
  topicType,
  setTopicType,
  search,
  setSearch,
  startDate,
  setStartDate,
  endDate,
  setEndDate,
  datePreset,
  setDatePreset,
  options,
  applyDatePreset,
  dataFirstDate,
  onSearch,
  busy = false,
  programLocked = false,
}: {
  /** The page shows every program (รวมรายการ): the program filter is locked. */
  programLocked?: boolean;
  /** Enter in the search box / the button beside it: open รายงาน → ผลการค้นหา. */
  onSearch?: () => void;
  /** The report is being worked out for new filters (shown in words, not only the thin top bar). */
  busy?: boolean;
} & Pick<
  DashboardModel,
  | "program"
  | "setProgram"
  | "platform"
  | "setPlatform"
  | "vdoType"
  | "setVdoType"
  | "topicType"
  | "setTopicType"
  | "search"
  | "setSearch"
  | "startDate"
  | "setStartDate"
  | "endDate"
  | "setEndDate"
  | "datePreset"
  | "setDatePreset"
  | "options"
  | "applyDatePreset"
  | "dataFirstDate"
>) {
  const groups = datePresetGroups(dataFirstDate);
  // Today has no numbers until tomorrow morning's sync: the calendar stops at yesterday.
  const yesterday = shiftDay(bangkokToday(), -1);
  // Every filter that is not the default, each with its own ×; search terms one by one.
  const terms = searchTerms(search);
  const chips: { key: string; label: string; clear: () => void }[] = [
    ...terms.map((t) => ({
      key: `q-${t}`,
      label: `ค้นหา: ${t}`,
      clear: () => setSearch(terms.filter((x) => x !== t).join(", ")),
    })),
    ...(!programLocked && program !== DEFAULT_PROGRAM ? [{ key: "program", label: `รายการ: ${programLabel(program)}`, clear: () => setProgram(DEFAULT_PROGRAM) }] : []),
    ...(platform !== "ALL" ? [{ key: "platform", label: `แพลตฟอร์ม: ${platform}`, clear: () => setPlatform("ALL") }] : []),
    ...(vdoType !== "ALL" ? [{ key: "vdo", label: `VDO Type: ${vdoType}`, clear: () => setVdoType("ALL") }] : []),
    ...(topicType !== "ALL" ? [{ key: "topic", label: `Topic Type: ${topicType}`, clear: () => setTopicType("ALL") }] : []),
  ];
  const clearAll = () => {
    setSearch("");
    setProgram(DEFAULT_PROGRAM);
    setPlatform("ALL");
    setVdoType("ALL");
    setTopicType("ALL");
  };
  return (
    <>
      {/* Phones keep only รายการ and วันเดือนปี; app/dashboard.tsx resets the rest */}
      <div className="topbar">
        {programLocked ? (
          <SelectBox label="รายการทั้งหมด" value={program} onChange={setProgram} options={options.programs} locked="ทุกรายการ (หน้านี้แสดงทุกรายการ)" />
        ) : (
          <ProgramChecks label="รายการทั้งหมด" value={program} onChange={setProgram} options={options.programs} uncheckAll={DEFAULT_PROGRAM} />
        )}
        <div className="filter-box date-filter" role="group" aria-label="วันเดือนปี">
          <span>วันเดือนปี</span>
          <div>
            <select
              className="quick-range"
              value={datePreset}
              aria-label="ช่วงวันที่"
              onChange={(e) => applyDatePreset(e.target.value as DatePreset)}
            >
              {groups.map((g) => (
                <optgroup key={g.label} label={g.label}>
                  {g.options.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
            {/* The range label opens the calendar; picking a range there makes the menu "กำหนดเอง". */}
            <DateRangePicker
              start={startDate}
              end={endDate}
              min={dataFirstDate}
              max={yesterday}
              label={rangeLabel(startDate, endDate) || "เลือกช่วงวันที่"}
              onPick={(s, e) => {
                setStartDate(s);
                setEndDate(e);
                setDatePreset("CUSTOM");
              }}
            />
          </div>
        </div>
        <SelectBox
          className="mobile-hide"
          label="Cross Platform"
          value={platform}
          onChange={setPlatform}
          options={options.platforms}
        />
        <SelectBox
          className="mobile-hide"
          label="VDO Type"
          value={vdoType}
          onChange={setVdoType}
          options={options.vdoTypes}
        />
        <SelectBox
          className="mobile-hide"
          label="Topic Type"
          value={topicType}
          onChange={setTopicType}
          options={options.topicTypes}
        />
        <label className="search-box mobile-hide">
          <Search />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && onSearch) onSearch();
              if (e.key === "Escape") setSearch("");
            }}
            placeholder="ค้นหา: ประเด็น / #hashtag (หลายคำคั่นด้วย ,)"
            title="ค้นจากชื่อคลิป รายการ ช่อง และ hashtag · หลายคำคั่นด้วยจุลภาค = เจอคำใดคำหนึ่ง · กด Enter เพื่อดูสรุปผลการค้นหา"
          />
          {search && (
            <button type="button" className="search-clear" onClick={() => setSearch("")} aria-label="ล้างคำค้น" title="ล้างคำค้น (Esc)">
              <X size={14} />
            </button>
          )}
          {onSearch && search.trim() && (
            <button type="button" className="search-go" onClick={onSearch}>
              ดูสรุป
            </button>
          )}
        </label>
      </div>
      {(chips.length > 0 || busy) && (
        <div className="active-filters" aria-label="ตัวกรองที่ใช้อยู่">
          {busy && (
            <span className="filter-busy" role="status">
              กำลังคำนวณตัวเลขใหม่…
            </span>
          )}
          {chips.length > 0 && <span>กำลังกรอง:</span>}
          {chips.map((c) => (
            <button key={c.key} type="button" className="filter-chip" onClick={c.clear} title="ยกเลิกตัวกรองนี้">
              {c.label} <X size={12} />
            </button>
          ))}
          {chips.length > 0 && (
            <button type="button" className="filter-clear-all" onClick={clearAll}>
              ล้างทั้งหมด
            </button>
          )}
        </div>
      )}
    </>
  );
}
