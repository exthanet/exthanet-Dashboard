"use client";
// The รายการ filter as checkboxes: tick one or several programs, or ทั้งหมด.
import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { PROGRAM_NONE, programLabel, programList, programValue } from "@/lib/dashboard/programFilter";

/** `uncheckAll`: what unticking ทั้งหมด picks (the dashboard's default program); none when absent. */
export function ProgramChecks({ label, value, onChange, options, uncheckAll }: { label: string; value: string; onChange: (v: string) => void; options: string[]; uncheckAll?: string }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const list = programList(value);
  const picked = list || options;

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  const toggle = (o: string) => {
    // ทั้งหมด shows every box ticked: unticking one keeps all the others ("เฉพาะ" picks one alone);
    // unticking the last one leaves none picked.
    const next = picked.includes(o) ? picked.filter((x) => x !== o) : [...picked, o];
    onChange(programValue(next, options));
  };

  return (
    <div className="filter-box program-checks" ref={box}>
      <span>{label}</span>
      <button type="button" className="program-checks-btn" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span>{programLabel(value)}</span>
        <ChevronDown size={15} />
      </button>
      {open && (
        <div className="program-checks-menu" role="listbox" aria-multiselectable="true" aria-label={label}>
          <label className="program-checks-all">
            <input
              type="checkbox"
              checked={!list}
              ref={(el) => {
                // Some picked: the ทั้งหมด box shows a dash.
                if (el) el.indeterminate = !!list && list.length > 0;
              }}
              onChange={() => onChange(list ? "ALL" : uncheckAll && options.includes(uncheckAll) ? uncheckAll : PROGRAM_NONE)}
            />
            ทั้งหมด
          </label>
          {options.map((o) => (
            <label key={o}>
              <input type="checkbox" checked={picked.includes(o)} onChange={() => toggle(o)} />
              <span>{o}</span>
              <button
                type="button"
                className="program-checks-only"
                onClick={(e) => {
                  e.preventDefault();
                  onChange(programValue([o], options));
                  setOpen(false);
                }}
              >
                เฉพาะ
              </button>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
