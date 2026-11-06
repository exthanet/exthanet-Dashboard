"use client";
// Admins: the accounts on the ผู้ติดตาม board — name, platform, logo, where the number comes
// from (Metricool brand, YouTube channel id, or typed with its date), order and on/off.
import { useEffect, useState } from "react";
import { ArrowDown, ArrowUp, Plus, Save, Trash2, Users, X } from "lucide-react";
import { PLATFORM_LABEL, SEED_ACCOUNTS, SOCIAL_PLATFORMS, accountProblem, accountLogo, accountUrl, type SocialAccount, type SocialPlatform, type SocialSource } from "@/lib/dashboard/socialAccounts";
import { loadSocialAccounts, logoDataUrl, saveSocialAccounts } from "@/lib/socialAccountsData";
import { track } from "@/lib/loadingBar";

/** Metricool brands of this account (config/metricool-brands.json and the rest of the Metricool account). */
const METRICOOL_BRANDS: [number, string][] = [
  [6487104, "TERO Digital"],
  [6499952, "ถกไม่เถียง"],
  [6499961, "เงินทองของจริง"],
  [6499969, "TERO News"],
  [6499994, "Kids Fun คิดฝัน"],
  [6500109, "Popolay"],
  [6500128, "HITZ Thailand"],
  [7916751, "Off Script Off Record"],
];
const SOURCE_LABEL: Record<SocialSource, string> = { metricool: "Metricool (อัตโนมัติ)", youtube: "YouTube Channel ID (อัตโนมัติ)", manual: "กรอกเอง" };
const today = () => new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10);
const blank = (): SocialAccount => ({ id: `acc-${Date.now().toString(36)}`, name: "", platform: "facebook", source: "manual", enabled: true });

export function SocialAccountsModal({ open, onClose, userEmail }: { open: boolean; onClose: () => void; userEmail: string }) {
  const [list, setList] = useState<SocialAccount[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    setList(null);
    setMessage("");
    setError("");
    track(loadSocialAccounts())
      .then(setList)
      .catch(() => {
        setList([]);
        setError("โหลดการตั้งค่าไม่สำเร็จ");
      });
  }, [open]);

  if (!open) return null;

  const update = (id: string, patch: Partial<SocialAccount>) => setList((l) => (l || []).map((a) => (a.id === id ? { ...a, ...patch } : a)));
  const shift = (i: number, by: number) =>
    setList((l) => {
      const next = [...(l || [])];
      const j = i + by;
      if (j < 0 || j >= next.length) return next;
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  const invalid = (list || []).some((a) => accountProblem(a));
  // Accounts the starting list gained after this list was saved (e.g. Off Script), off until turned on.
  const missingSeeds = SEED_ACCOUNTS.filter((s) => !(list || []).some((a) => a.id === s.id)).map((a) => ({ ...a, enabled: false }));
  const seed = () => setList(SEED_ACCOUNTS.map((a) => (a.source === "manual" ? { ...a, manualDate: today() } : { ...a })));
  const pickLogo = async (id: string, file?: File) => {
    if (!file) return;
    try {
      update(id, { logo: await logoDataUrl(file) });
    } catch {
      setError("อ่านรูปโลโก้ไม่ได้ (ใช้ PNG หรือ JPG)");
    }
  };
  const save = async () => {
    if (!list || invalid) return;
    setSaving(true);
    setError("");
    setMessage("");
    try {
      await saveSocialAccounts(list, userEmail);
      setMessage("บันทึกแล้ว · ตัวเลขอัตโนมัติจะมาในรอบ sync ถัดไป ส่วนที่กรอกเองแสดงทันที");
    } catch {
      setError("บันทึกไม่สำเร็จ (ต้องเป็น admin หรือรูปโลโก้รวมกันใหญ่เกินไป)");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <section className="source-modal sync-modal" onClick={(e) => e.stopPropagation()}>
        <button className="close" onClick={onClose} aria-label="ปิด">
          <X size={18} />
        </button>
        <div className="sync-heading">
          <div className="modal-icon">
            <Users size={22} />
          </div>
          <div>
            <h2>บัญชีโซเชียล (หน้าผู้ติดตาม)</h2>
            <p>บัญชีที่แสดงบนหน้าผู้ติดตาม เรียงตามลำดับในรายการนี้ · ปิด “แสดง” เพื่อไม่นับรวม</p>
          </div>
        </div>
        <p className="sync-muted tv-note">
          โลโก้: ถ้าไม่อัปโหลด ใช้รูปโปรไฟล์เพจ Facebook ของ brand ใน Metricool หรือของลิงก์ Facebook ที่ใส่ · Metricool: ผู้ติดตามรายวันของเพจที่เชื่อมใน Metricool (ย้อนหลังได้ตั้งแต่ ม.ค. 2025) · YouTube Channel ID: จำนวน subscriber จาก YouTube (ปัดเลข) ·
          กรอกเอง: บัญชีที่ไม่มี API เช่น LINE OA, X หรือเพจที่ไม่ได้อยู่ใน Metricool ให้ใส่ตัวเลขพร้อมวันที่อ่าน (หน้าผู้ติดตามจะติดป้าย “รอตรวจสอบ”) · รายการ: ใช้จัดกลุ่มบนหน้าผู้ติดตาม
        </p>

        {error && <p className="sync-error">{error}</p>}
        {list === null && <p className="sync-muted">กำลังโหลด...</p>}
        {list?.length === 0 && (
          <p className="sync-muted">
            ยังไม่มีบัญชี ·{" "}
            <button className="tv-add" onClick={seed}>
              เริ่มจากรายการตั้งต้น (ตามสไลด์)
            </button>
          </p>
        )}

        {list?.map((a, i) => {
          const problem = accountProblem(a);
          return (
            <div key={a.id} className={`tv-source social-row ${a.enabled ? "" : "off"}`}>
              <label className="social-logo-pick" title={a.logo ? "โลโก้ที่อัปโหลด · กดเพื่อเปลี่ยน" : accountLogo(a) ? "รูปโปรไฟล์เพจ Facebook (อัตโนมัติ) · กดเพื่ออัปโหลดโลโก้แทน" : "อัปโหลดโลโก้"}>
                {a.logo ? <img src={a.logo} alt="" /> : accountLogo(a) ? <img src={accountLogo(a)} alt="" referrerPolicy="no-referrer" className="auto" /> : "โลโก้"}
                <input type="file" accept="image/*" hidden onChange={(e) => pickLogo(a.id, e.target.files?.[0])} />
              </label>
              <div>
                <div className="tv-source-grid social-grid">
                  <label>
                    <span>ชื่อที่แสดง</span>
                    <input value={a.name} onChange={(e) => update(a.id, { name: e.target.value })} placeholder="TERO Digital" />
                  </label>
                  <label>
                    <span>รายการ (จัดกลุ่ม)</span>
                    <input value={a.group || ""} onChange={(e) => update(a.id, { group: e.target.value || undefined })} placeholder={a.name || "ถกไม่เถียง"} list="social-groups" />
                  </label>
                  <label>
                    <span>แพลตฟอร์ม</span>
                    <select value={a.platform} onChange={(e) => update(a.id, { platform: e.target.value as SocialPlatform })}>
                      {SOCIAL_PLATFORMS.map((p) => (
                        <option key={p} value={p}>
                          {PLATFORM_LABEL[p]}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <span>ที่มาของตัวเลข</span>
                    <select value={a.source} onChange={(e) => update(a.id, { source: e.target.value as SocialSource })}>
                      {(Object.keys(SOURCE_LABEL) as SocialSource[]).map((s) => (
                        <option key={s} value={s}>
                          {SOURCE_LABEL[s]}
                        </option>
                      ))}
                    </select>
                  </label>
                  {a.source === "metricool" && (
                    <label>
                      <span>Metricool brand</span>
                      <select value={a.blogId || ""} onChange={(e) => update(a.id, { blogId: Number(e.target.value) || undefined })}>
                        <option value="">เลือก</option>
                        {METRICOOL_BRANDS.map(([id, name]) => (
                          <option key={id} value={id}>
                            {name}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  {a.source === "youtube" && (
                    <label>
                      <span>Channel ID</span>
                      <input value={a.channelId || ""} onChange={(e) => update(a.id, { channelId: e.target.value.trim() })} placeholder="UC…" />
                    </label>
                  )}
                  {a.source === "manual" && (
                    <label>
                      <span>ผู้ติดตาม · วันที่</span>
                      <span style={{ display: "flex", gap: 4 }}>
                        <input
                          inputMode="numeric"
                          value={a.manualValue ?? ""}
                          onChange={(e) => {
                            const v = e.target.value.replace(/[^\d]/g, "");
                            update(a.id, { manualValue: v === "" ? undefined : Number(v) });
                          }}
                          placeholder="250310"
                        />
                        <input type="date" value={a.manualDate || ""} onChange={(e) => update(a.id, { manualDate: e.target.value || undefined })} />
                      </span>
                    </label>
                  )}
                  <label className="social-url">
                    <span>ลิงก์บัญชี (เปิดจากหน้าผู้ติดตาม)</span>
                    <input value={a.url || ""} onChange={(e) => update(a.id, { url: e.target.value.trim() || undefined })} placeholder={accountUrl(a) || "https://www.facebook.com/…"} />
                  </label>
                </div>
                <div className="tv-source-foot">
                  <label className="tv-toggle">
                    <input type="checkbox" checked={a.enabled} onChange={(e) => update(a.id, { enabled: e.target.checked })} />
                    แสดง
                  </label>
                  {problem && <span className="tv-bad">{problem}</span>}
                  {a.logo && (
                    <button className="tv-add" onClick={() => update(a.id, { logo: undefined })}>
                      ลบโลโก้
                    </button>
                  )}
                  <span className="split-order">
                    <button onClick={() => shift(i, -1)} aria-label="เลื่อนขึ้น" disabled={i === 0}>
                      <ArrowUp size={14} />
                    </button>
                    <button onClick={() => shift(i, 1)} aria-label="เลื่อนลง" disabled={i === list.length - 1}>
                      <ArrowDown size={14} />
                    </button>
                  </span>
                  <button className="tv-remove" onClick={() => setList((l) => (l || []).filter((x) => x.id !== a.id))} aria-label="ลบ">
                    <Trash2 size={15} />
                  </button>
                </div>
              </div>
            </div>
          );
        })}

        <datalist id="social-groups">
          {[...new Set((list || []).map((a) => a.group).filter(Boolean))].map((g) => (
            <option key={g} value={g} />
          ))}
        </datalist>

        <div className="tv-actions">
          <button className="tv-add" onClick={() => setList((l) => [...(l || []), blank()])} disabled={list === null}>
            <Plus size={15} /> เพิ่มบัญชี
          </button>
          {!!list?.length && missingSeeds.length > 0 && (
            <button className="tv-add" onClick={() => setList((l) => [...(l || []), ...missingSeeds.map((a) => ({ ...a }))])} title={missingSeeds.map((a) => `${a.name} (${PLATFORM_LABEL[a.platform]})`).join(", ")}>
              <Plus size={15} /> เพิ่มบัญชีใหม่จากรายการตั้งต้น ({missingSeeds.length})
            </button>
          )}
          {message &&<span className="tv-ok">{message}</span>}
          <button className="sync-run-link" onClick={save} disabled={saving || invalid || list === null}>
            <Save size={14} /> {saving ? "กำลังบันทึก..." : "บันทึก"}
          </button>
        </div>
      </section>
    </div>
  );
}
