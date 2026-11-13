"use client";
// Admins: set which show (Program) a clip belongs to, on every platform it was posted to.
// Saved straight to masterData and kept in syncConfig/programEdits, so the daily sync and
// the แยกรายการย่อย rules leave it as set.
import { useMemo, useState } from "react";
import { Save } from "lucide-react";
import type { RecordRow } from "@/lib/dashboard/types";
import { postId } from "@/lib/dashboard/postKey";
import { setClipProgramInFirebase } from "@/lib/firebase";
import { useAdmin } from "@/components/dashboard/shared/AdminContext";
import { track } from "@/lib/loadingBar";

const UNKNOWN = "ไม่ระบุ";
const keyOf = (r: RecordRow) => {
  const id = postId(r.platform, r.url) || postId(r.platform, r.contentId);
  return id ? `${r.platform}|${id}` : "";
};

export function ClipProgramEditor({ posts, allRows }: { posts: RecordRow[]; allRows: RecordRow[] }) {
  const { isAdmin, email } = useAdmin();
  const current = posts[0]?.program || UNKNOWN;
  const [value, setValue] = useState(current);
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState("");
  const [error, setError] = useState("");
  // Online programs, most posts first.
  const programs = useMemo(() => {
    const count = new Map<string, number>();
    for (const r of allRows) if (r.platform !== "TV" && r.program) count.set(r.program, (count.get(r.program) || 0) + 1);
    return [...new Set([current, ...[...count].sort((a, b) => b[1] - a[1]).map(([p]) => p)])];
  }, [allRows, current]);
  if (!isAdmin) return null;
  const keys = posts.map(keyOf).filter(Boolean);
  const platforms = [...new Set(posts.map((p) => p.platform))].join(", ");

  const save = async () => {
    if (!keys.length || value === current) return;
    setSaving(true);
    setError("");
    setDone("");
    try {
      const r = await track(setClipProgramInFirebase(keys, value, email));
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
        <select value={value} onChange={(e) => setValue(e.target.value)} disabled={saving}>
          {programs.map((p) => (
            <option key={p}>{p}</option>
          ))}
        </select>
      </label>
      {value !== current && <span className="clip-program-was">เดิม: {current}</span>}
      <button type="button" onClick={save} disabled={saving || value === current || !keys.length}>
        <Save size={14} /> {saving ? "กำลังบันทึก..." : "บันทึก"}
      </button>
      <small>
        {error || done || `เปลี่ยนทุกแพลตฟอร์มของคลิปนี้ (${platforms}) · sync และกฎแยกรายการย่อยจะไม่เปลี่ยนกลับ · admin เท่านั้น`}
      </small>
    </div>
  );
}
