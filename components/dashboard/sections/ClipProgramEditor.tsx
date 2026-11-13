"use client";
// Admins: set which show (Program) and which content type (Topic_Type) a clip belongs to,
// on every platform it was posted to. Saved straight to masterData and kept in
// syncConfig/programEdits, so the daily sync and the แยกรายการย่อย rules leave it as set.
import { useMemo, useState } from "react";
import { Save } from "lucide-react";
import type { RecordRow } from "@/lib/dashboard/types";
import { postId } from "@/lib/dashboard/postKey";
import { setClipFieldsInFirebase } from "@/lib/firebase";
import { useAdmin } from "@/components/dashboard/shared/AdminContext";
import { track } from "@/lib/loadingBar";

const UNKNOWN = "ไม่ระบุ";
const keyOf = (r: RecordRow) => {
  const id = postId(r.platform, r.url) || postId(r.platform, r.contentId);
  return id ? `${r.platform}|${id}` : "";
};

/** Values in use on online rows, most used first, with the current one kept on the list. */
function optionsOf(allRows: RecordRow[], pick: (r: RecordRow) => string, current: string): string[] {
  const count = new Map<string, number>();
  for (const r of allRows) {
    const v = pick(r);
    if (r.platform !== "TV" && v) count.set(v, (count.get(v) || 0) + 1);
  }
  return [...new Set([current, ...[...count].sort((a, b) => b[1] - a[1]).map(([v]) => v)])];
}

export function ClipProgramEditor({ posts, allRows }: { posts: RecordRow[]; allRows: RecordRow[] }) {
  const { isAdmin, email } = useAdmin();
  const currentProgram = posts[0]?.program || UNKNOWN;
  const currentType = posts[0]?.topicType || UNKNOWN;
  const [program, setProgram] = useState(currentProgram);
  const [topicType, setTopicType] = useState(currentType);
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState("");
  const [error, setError] = useState("");
  const programs = useMemo(() => optionsOf(allRows, (r) => r.program, currentProgram), [allRows, currentProgram]);
  const types = useMemo(() => optionsOf(allRows, (r) => r.topicType, currentType), [allRows, currentType]);
  if (!isAdmin) return null;
  const keys = posts.map(keyOf).filter(Boolean);
  const platforms = [...new Set(posts.map((p) => p.platform))].join(", ");
  const changed = program !== currentProgram || topicType !== currentType;

  const save = async () => {
    if (!keys.length || !changed) return;
    setSaving(true);
    setError("");
    setDone("");
    try {
      const fields = { ...(program !== currentProgram ? { program } : {}), ...(topicType !== currentType ? { topicType } : {}) };
      const r = await track(setClipFieldsInFirebase(keys, fields, email));
      setDone(`บันทึกแล้ว ${r.rows} โพสต์ · โหลดหน้าใหม่เพื่อดูผลในรายงาน`);
    } catch {
      setError("บันทึกไม่สำเร็จ (ต้องเป็น admin)");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="clip-program-edit">
      <label>
        <b>รายการ</b>
        <select value={program} onChange={(e) => setProgram(e.target.value)} disabled={saving}>
          {programs.map((p) => (
            <option key={p}>{p}</option>
          ))}
        </select>
      </label>
      {program !== currentProgram && <span className="clip-program-was">เดิม: {currentProgram}</span>}
      <label>
        <b>ประเภท</b>
        <select value={topicType} onChange={(e) => setTopicType(e.target.value)} disabled={saving}>
          {types.map((t) => (
            <option key={t}>{t}</option>
          ))}
        </select>
      </label>
      {topicType !== currentType && <span className="clip-program-was">เดิม: {currentType}</span>}
      <button type="button" onClick={save} disabled={saving || !changed || !keys.length}>
        <Save size={14} /> {saving ? "กำลังบันทึก..." : "บันทึก"}
      </button>
      <small>
        {error || done || `เปลี่ยนทุกแพลตฟอร์มของคลิปนี้ (${platforms}) · sync และกฎแยกรายการย่อยจะไม่เปลี่ยนกลับ · admin เท่านั้น`}
      </small>
    </div>
  );
}
