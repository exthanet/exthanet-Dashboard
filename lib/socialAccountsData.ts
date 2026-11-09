// ผู้ติดตาม board data: socialAccounts/config (admins edit) and accountStats/{id} (the sync writes).
import { collection, doc, getDoc, getDocs, setDoc } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { readAccounts, type AccountStat, type SocialAccount } from "@/lib/dashboard/socialAccounts";

export async function loadSocialAccounts(): Promise<SocialAccount[]> {
  const snap = await getDoc(doc(db, "socialAccounts", "config"));
  return snap.exists() ? readAccounts(snap.data()) : [];
}

export async function loadAccountStats(): Promise<Record<string, AccountStat>> {
  const snap = await getDocs(collection(db, "accountStats"));
  const out: Record<string, AccountStat> = {};
  for (const d of snap.docs) {
    const x = d.data();
    out[d.id] = {
      series: (x.series || {}) as Record<string, number>,
      ...(x.latest ? { latest: { date: String(x.latest.date), value: Number(x.latest.value) } } : {}),
      ...(x.sources ? { sources: x.sources } : {}),
      ...(x.chosen ? { chosen: x.chosen } : {}),
      ...(x.check ? { check: String(x.check) } : {}),
      ...(x.error ? { error: String(x.error) } : {}),
      ...(x.updatedAt ? { updatedAt: String(x.updatedAt) } : {}),
    };
  }
  return out;
}

export interface Audience {
  platform: string;
  gender: Record<string, number>;
  age: Record<string, number>;
  from: string;
  to: string;
  source: string;
}

/** audienceStats/{accountId}: who follows / watches each account (the sync writes it). */
export async function loadAudience(): Promise<Record<string, Audience>> {
  const snap = await getDocs(collection(db, "audienceStats"));
  return Object.fromEntries(snap.docs.map((d) => [d.id, d.data() as Audience]));
}

export async function saveSocialAccounts(accounts: SocialAccount[], updatedBy: string): Promise<void> {
  // Firestore refuses undefined: drop empty optional fields.
  const clean = accounts.map((a) => Object.fromEntries(Object.entries(a).filter(([, v]) => v !== undefined && v !== "")));
  await setDoc(doc(db, "socialAccounts", "config"), { accounts: clean, updatedAt: new Date().toISOString(), updatedBy });
}

/** An uploaded logo as a small square PNG data URL (fits many logos in one document). */
export function logoDataUrl(file: File, size = 96): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext("2d")!;
      const scale = Math.min(size / img.width, size / img.height);
      const w = img.width * scale;
      const h = img.height * scale;
      ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL("image/png"));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("อ่านรูปไม่ได้"));
    };
    img.src = url;
  });
}
