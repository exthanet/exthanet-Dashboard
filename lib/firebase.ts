import { getApp, getApps, initializeApp } from "firebase/app";
import { connectAuthEmulator, getAuth } from "firebase/auth";
import {
  collection,
  connectFirestoreEmulator,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  getFirestore,
  setDoc,
} from "firebase/firestore";
import type { RawRow } from "@/lib/dashboard/types";
import type { AffiliateData } from "@/lib/dashboard/affiliateParser";
import type { RevenueData } from "@/lib/dashboard/revenueParser";
import type { RevenueApiMonth } from "@/lib/dashboard/revenueApi";
import { joinFromStore, splitForStore, type AffiliateSheets, type AffiliateStoreMain, type AffiliateStoreMonth } from "@/lib/dashboard/affiliateSheets";
import { applySplitChanges, planProgramSplits, readProgramEdits, readSplitMoved, type ProgramSplit } from "@/lib/dashboard/programSplits";
import { rowKey } from "@/lib/dashboard/postKey";

export const firebaseConfig = {
  apiKey: "AIzaSyAryjQuJ7dujmHxoXtiCNFANjt5bkE3PAc",
  authDomain: "entertainment-dashboard-733e5.firebaseapp.com",
  projectId: "entertainment-dashboard-733e5",
  storageBucket: "entertainment-dashboard-733e5.firebasestorage.app",
  messagingSenderId: "109531742990",
  appId: "1:109531742990:web:d88bddbbacae0d40a10d5f",
  measurementId: "G-FLXQES7H7C",
};

const app = getApps().length ? getApp() : initializeApp(firebaseConfig);
export const auth = getAuth(app);
auth.languageCode = "th";
export const db = getFirestore(app);

// Local testing only: `FIREBASE_EMULATOR=true npm run dev` builds with this
// flag so the page talks to `firebase emulators:start` instead of production.
export const useFirebaseEmulator =
  process.env.NEXT_PUBLIC_FIREBASE_EMULATOR === "true";
if (useFirebaseEmulator) {
  connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
  connectFirestoreEmulator(db, "127.0.0.1", 8080);
}

export interface MasterDataResult {
  rows: RawRow[];
  updatedAt?: string;
}

/** Firestore collection `masterData`: one document per dashboard row or chunked documents. */
export async function loadMasterDataWithMetaFromFirebase(): Promise<MasterDataResult> {
  const snapshot = await getDocs(collection(db, "masterData"));
  if (snapshot.empty) return { rows: [] };
  const rows: RawRow[] = [];
  let latestUpdatedAt: string | undefined;

  snapshot.docs.forEach((item) => {
    const data = item.data();
    if (data.updatedAt && (!latestUpdatedAt || String(data.updatedAt) > latestUpdatedAt)) {
      latestUpdatedAt = String(data.updatedAt);
    }
    if (Array.isArray(data.rows)) {
      rows.push(...(data.rows as RawRow[]));
    } else if (item.id.startsWith("chunk_") || !item.id.startsWith("meta")) {
      rows.push(data as RawRow);
    }
  });

  return {
    rows,
    updatedAt: latestUpdatedAt,
  };
}

export async function loadMasterDataFromFirebase(): Promise<RawRow[]> {
  const result = await loadMasterDataWithMetaFromFirebase();
  return result.rows;
}

function cleanRowForFirestore(row: Record<string, unknown>): Record<string, unknown> {
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    cleaned[key] = value === undefined ? null : value;
  }
  return cleaned;
}

/**
 * Save rows to Firestore `masterData` collection partitioned in chunks.
 * Firestore rules only allow this for signed-in admins.
 */
export async function saveMasterDataToFirebase(
  rows: RawRow[],
  onProgress?: (current: number, total: number) => void
): Promise<{ success: boolean; message: string; totalChunks: number }> {
  if (!rows || rows.length === 0) {
    throw new Error("ไม่มีข้อมูลสำหรับบันทึก");
  }

  // Firestore doc limit is 1MB. 250 rows is ~250KB, ensuring zero payload failures.
  const CHUNK_SIZE = 250;
  const totalChunks = Math.ceil(rows.length / CHUNK_SIZE);

  // 0. The fast-open dashboard copy stops matching before masterData changes
  //    (rebuilt at the end; until then the dashboard reads masterData).
  await deleteDoc(doc(db, "dashboardCache", "meta"));

  // 1. Fetch existing chunks to track any leftover chunks
  const existingSnap = await getDocs(collection(db, "masterData"));
  const existingChunkIds = new Set<string>();
  existingSnap.docs.forEach((docItem) => {
    if (docItem.id.startsWith("chunk_")) existingChunkIds.add(docItem.id);
  });

  const now = new Date().toISOString();

  // 2. Upload chunks sequentially
  for (let i = 0; i < totalChunks; i++) {
    const start = i * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, rows.length);
    const chunkRows = rows.slice(start, end).map((r) => cleanRowForFirestore(r as Record<string, unknown>));
    const docId = `chunk_${String(i).padStart(3, "0")}`;
    existingChunkIds.delete(docId);

    const docRef = doc(db, "masterData", docId);
    await setDoc(docRef, {
      chunkIndex: i,
      rowCount: chunkRows.length,
      updatedAt: now,
      rows: chunkRows,
    });

    if (onProgress) {
      onProgress(i + 1, totalChunks);
    }
  }

  // 3. Clear any obsolete leftover chunk docs from previous runs
  for (const obsoleteId of existingChunkIds) {
    const docRef = doc(db, "masterData", obsoleteId);
    await setDoc(docRef, {
      chunkIndex: -1,
      rowCount: 0,
      updatedAt: now,
      rows: [],
    });
  }

  // 4. Rebuild the fast-open copy for this version (failure is harmless).
  try {
    const { writeDashboardCache } = await import("@/lib/dashboardCache");
    await writeDashboardCache(rows, now, now);
  } catch (e) {
    console.warn("dashboard copy not written; the dashboard will read masterData:", e);
  }

  return {
    success: true,
    message: `บันทึกข้อมูล ${rows.length.toLocaleString()} แถวขึ้น Firebase Firestore เรียบร้อยแล้ว`,
    totalChunks,
  };
}

/**
 * แยกรายการย่อย now: save the rules, read masterData fresh (not the page's copy, which may
 * be older than the last sync), change Program only in the chunks that need it, remember
 * the moved rows, and rebuild the fast-open copy. Admins only (firestore.rules).
 */
export async function applyProgramSplitsToFirebase(
  rules: ProgramSplit[],
  updatedBy: string,
): Promise<{ moved: number; back: number; chunks: number }> {
  const now = new Date().toISOString();
  await setDoc(doc(db, "syncConfig", "programSplits"), { rules, updatedAt: now, updatedBy });
  const movedSnap = await getDoc(doc(db, "syncConfig", "programSplitsMoved"));
  const editsSnap = await getDoc(doc(db, "syncConfig", "programEdits"));
  const snapshot = await getDocs(collection(db, "masterData"));
  const chunks = snapshot.docs.filter((d) => d.id.startsWith("chunk_") && Array.isArray(d.data().rows));
  const rows: RawRow[] = [];
  const chunkOf: number[] = [];
  chunks.forEach((d, c) => {
    for (const r of d.data().rows as RawRow[]) {
      rows.push(r);
      chunkOf.push(c);
    }
  });
  const plan = planProgramSplits(rows, rules, readSplitMoved(movedSnap.data()), rowKey, new Set(Object.keys(readProgramEdits(editsSnap.data()))));
  await setDoc(doc(db, "syncConfig", "programSplitsMoved"), { moved: plan.moved, updatedAt: now });
  if (!plan.changes.length) return { moved: 0, back: 0, chunks: 0 };

  applySplitChanges(rows, plan.changes);
  const touched = [...new Set(plan.changes.map((c) => chunkOf[c.index]))];
  await deleteDoc(doc(db, "dashboardCache", "meta"));
  for (const c of touched) {
    await setDoc(doc(db, "masterData", chunks[c].id), { rows: rows.filter((_, i) => chunkOf[i] === c).map((r) => cleanRowForFirestore(r as Record<string, unknown>)), updatedAt: now }, { merge: true });
  }
  try {
    const { writeDashboardCache } = await import("@/lib/dashboardCache");
    await writeDashboardCache(rows, now, now);
  } catch (e) {
    console.warn("dashboard copy not written; the dashboard will read masterData:", e);
  }
  return { moved: plan.changes.filter((c) => c.kind === "move").length, back: plan.changes.filter((c) => c.kind === "back").length, chunks: touched.length };
}

/**
 * An admin sets the Program of one clip (every platform's post of it): masterData read
 * fresh, only the chunks holding those rows written, the fast-open copy rebuilt, and the
 * choice kept in syncConfig/programEdits so the sync and the split rules leave it as set.
 */
export async function setClipProgramInFirebase(keys: string[], program: string, updatedBy: string): Promise<{ rows: number }> {
  const now = new Date().toISOString();
  const want = new Set(keys.filter(Boolean));
  const snapshot = await getDocs(collection(db, "masterData"));
  const chunks = snapshot.docs.filter((d) => d.id.startsWith("chunk_") && Array.isArray(d.data().rows));
  const rows: RawRow[] = [];
  const touched = new Set<number>();
  // data() returns a new copy each call: keep the copy that is changed.
  const perChunk = chunks.map((d) => d.data().rows as RawRow[]);
  perChunk.forEach((list, c) => {
    for (const r of list) {
      if (r.Platform !== "TV" && want.has(rowKey(r)) && r.Program !== program) {
        r.Program = program;
        touched.add(c);
      }
      rows.push(r);
    }
  });
  await setDoc(
    doc(db, "syncConfig", "programEdits"),
    { edits: Object.fromEntries([...want].map((k) => [k, { program, by: updatedBy, at: now }])), updatedAt: now, updatedBy },
    { merge: true },
  );
  if (!touched.size) return { rows: 0 };
  await deleteDoc(doc(db, "dashboardCache", "meta"));
  for (const c of touched) {
    const own = perChunk[c].map((r) => cleanRowForFirestore(r as Record<string, unknown>));
    await setDoc(doc(db, "masterData", chunks[c].id), { rows: own, updatedAt: now }, { merge: true });
  }
  try {
    const { writeDashboardCache } = await import("@/lib/dashboardCache");
    await writeDashboardCache(rows, now, now);
  } catch (e) {
    console.warn("dashboard copy not written; the dashboard will read masterData:", e);
  }
  return { rows: rows.filter((r) => want.has(rowKey(r))).length };
}

/**
 * Load Affiliate data from Firestore `affiliateData` collection
 */
export async function loadAffiliateDataFromFirebase(): Promise<AffiliateData | null> {
  const snapshot = await getDocs(collection(db, "affiliateData"));
  if (snapshot.empty) return null;

  const summaryDoc = snapshot.docs.find((d) => d.id === "summary");
  const metaDoc = snapshot.docs.find((d) => d.id === "meta");

  const summary = summaryDoc?.data()?.summary || [];
  const generatedAt = metaDoc?.data()?.generatedAt || new Date().toISOString();

  const contents: AffiliateData["contents"] = [];
  const products: AffiliateData["products"] = [];
  const daily: AffiliateData["daily"] = [];

  snapshot.docs.forEach((item) => {
    const data = item.data();
    if (item.id.startsWith("content_") && Array.isArray(data.rows)) {
      contents.push(...data.rows);
    } else if (item.id.startsWith("product_") && Array.isArray(data.rows)) {
      products.push(...data.rows);
    } else if (item.id.startsWith("daily_") && Array.isArray(data.rows)) {
      daily.push(...data.rows);
    }
  });

  if (summary.length === 0 && contents.length === 0 && daily.length === 0) {
    return null;
  }

  return {
    generatedAt,
    summary,
    contents,
    products,
    daily,
  };
}

/**
 * Save Affiliate data to Firestore `affiliateData` collection
 */
export async function saveAffiliateDataToFirebase(
  data: AffiliateData,
  onProgress?: (current: number, total: number) => void
): Promise<{ success: boolean; message: string }> {
  const CHUNK_SIZE = 400;

  const contentChunks: AffiliateData["contents"][] = [];
  for (let i = 0; i < data.contents.length; i += CHUNK_SIZE) {
    contentChunks.push(data.contents.slice(i, i + CHUNK_SIZE));
  }

  const productChunks: AffiliateData["products"][] = [];
  for (let i = 0; i < data.products.length; i += CHUNK_SIZE) {
    productChunks.push(data.products.slice(i, i + CHUNK_SIZE));
  }

  const dailyChunks: AffiliateData["daily"][] = [];
  for (let i = 0; i < data.daily.length; i += CHUNK_SIZE) {
    dailyChunks.push(data.daily.slice(i, i + CHUNK_SIZE));
  }

  const totalSteps =
    2 + contentChunks.length + productChunks.length + dailyChunks.length;
  let currentStep = 0;

  // 1. Save Meta doc
  await setDoc(doc(db, "affiliateData", "meta"), {
    generatedAt: data.generatedAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  currentStep++;
  if (onProgress) onProgress(currentStep, totalSteps);

  // 2. Save Summary doc
  await setDoc(doc(db, "affiliateData", "summary"), {
    summary: data.summary.map((s) => cleanRowForFirestore(s as Record<string, unknown>)),
    updatedAt: new Date().toISOString(),
  });
  currentStep++;
  if (onProgress) onProgress(currentStep, totalSteps);

  // 3. Save Content chunks
  for (let i = 0; i < contentChunks.length; i++) {
    const docId = `content_${String(i).padStart(3, "0")}`;
    await setDoc(doc(db, "affiliateData", docId), {
      index: i,
      rows: contentChunks[i].map((r) => cleanRowForFirestore(r as Record<string, unknown>)),
      updatedAt: new Date().toISOString(),
    });
    currentStep++;
    if (onProgress) onProgress(currentStep, totalSteps);
  }

  // 4. Save Product chunks
  for (let i = 0; i < productChunks.length; i++) {
    const docId = `product_${String(i).padStart(3, "0")}`;
    await setDoc(doc(db, "affiliateData", docId), {
      index: i,
      rows: productChunks[i].map((r) => cleanRowForFirestore(r as Record<string, unknown>)),
      updatedAt: new Date().toISOString(),
    });
    currentStep++;
    if (onProgress) onProgress(currentStep, totalSteps);
  }

  // 5. Save Daily chunks
  for (let i = 0; i < dailyChunks.length; i++) {
    const docId = `daily_${String(i).padStart(3, "0")}`;
    await setDoc(doc(db, "affiliateData", docId), {
      index: i,
      rows: dailyChunks[i].map((r) => cleanRowForFirestore(r as Record<string, unknown>)),
      updatedAt: new Date().toISOString(),
    });
    currentStep++;
    if (onProgress) onProgress(currentStep, totalSteps);
  }

  return {
    success: true,
    message: "บันทึกข้อมูล Affiliate ขึ้น Firebase เรียบร้อยแล้ว",
  };
}

/**
 * Load YouTube Revenue data from Firestore `revenueData` collection
 */
export async function loadRevenueDataFromFirebase(): Promise<RevenueData | null> {
  const snapshot = await getDocs(collection(db, "revenueData"));
  if (snapshot.empty) return null;

  const metaDoc = snapshot.docs.find((d) => d.id === "meta");
  const monthlyDoc = snapshot.docs.find((d) => d.id === "monthly");

  const generatedAt = metaDoc?.data()?.generatedAt || new Date().toISOString();
  const monthly = (monthlyDoc?.data()?.monthly || []) as RevenueData["monthly"];
  // Per company (revenueData/digital, revenueData/entertainment): only once a file with those sheets was imported.
  const company = (id: string) => {
    const list = snapshot.docs.find((d) => d.id === id)?.data()?.monthly as RevenueData["monthly"] | undefined;
    return list && list.length ? list : undefined;
  };

  if (monthly.length === 0) {
    return null;
  }

  return {
    generatedAt,
    monthly,
    digital: company("digital"),
    entertainment: company("entertainment"),
    rates: (snapshot.docs.find((d) => d.id === "rates")?.data()?.rates as Record<string, number> | undefined) || undefined,
  };
}

/** Affiliate from the three Studio exports in Google Sheets (affiliateSheets/current); null when none or not readable. */
export async function loadAffiliateSheets(collectionName = "affiliateSheets"): Promise<(AffiliateSheets & { readAt?: string }) | null> {
  try {
    const snap = await getDocs(collection(db, collectionName));
    const main = snap.docs.find((d) => d.id === "current");
    if (!main) return null;
    const months = snap.docs.filter((d) => d.id.startsWith("m_")).map((d) => d.data() as AffiliateStoreMonth);
    return joinFromStore(main.data() as AffiliateStoreMain, months);
  } catch {
    return null;
  }
}

/** Import Affiliate: the draft the sync read, saved as the affiliate data (current + one document per month; months gone are removed). */
export async function saveAffiliateSheets(data: AffiliateSheets & { readAt?: string }): Promise<void> {
  // Firestore refuses undefined fields: a JSON round trip drops them.
  const plain = <T,>(x: T): T => JSON.parse(JSON.stringify(x));
  const { main, months } = splitForStore(data);
  for (const m of months) await setDoc(doc(db, "affiliateSheets", `m_${m.month}`), plain(m));
  await setDoc(doc(db, "affiliateSheets", "current"), plain({ ...main, importedAt: new Date().toISOString() }));
  const keep = new Set(["current", ...months.map((m) => `m_${m.month}`)]);
  for (const d of (await getDocs(collection(db, "affiliateSheets"))).docs) if (!keep.has(d.id)) await deleteDoc(d.ref);
}

/** YouTube Revenue from the API (revenueApi/{YYYY-MM}, the daily sync); [] when none or not readable. */
export async function loadRevenueApiMonths(): Promise<RevenueApiMonth[]> {
  try {
    const snapshot = await getDocs(collection(db, "revenueApi"));
    return snapshot.docs.map((d) => d.data() as RevenueApiMonth);
  } catch {
    return [];
  }
}

/**
 * Save YouTube Revenue data to Firestore `revenueData` collection
 */
export async function saveRevenueDataToFirebase(
  data: RevenueData,
  onProgress?: (current: number, total: number) => void
): Promise<{ success: boolean; message: string }> {
  const companies = (["digital", "entertainment"] as const).filter((c) => data[c]?.length);
  const hasRates = !!data.rates && Object.keys(data.rates).length > 0;
  const totalSteps = 2 + companies.length + (hasRates ? 1 : 0);
  let currentStep = 0;

  // 1. Save Meta doc
  await setDoc(doc(db, "revenueData", "meta"), {
    generatedAt: data.generatedAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  currentStep++;
  if (onProgress) onProgress(currentStep, totalSteps);

  // 2. Save Monthly doc
  await setDoc(doc(db, "revenueData", "monthly"), {
    monthly: data.monthly.map((m) => cleanRowForFirestore(m as Record<string, unknown>)),
    updatedAt: new Date().toISOString(),
  });
  currentStep++;
  if (onProgress) onProgress(currentStep, totalSteps);

  // 3. Per company, only when the import carried those sheets (others stay as they are).
  for (const c of companies) {
    await setDoc(doc(db, "revenueData", c), {
      monthly: data[c]!.map((m) => cleanRowForFirestore(m as Record<string, unknown>)),
      updatedAt: new Date().toISOString(),
    });
    currentStep++;
    if (onProgress) onProgress(currentStep, totalSteps);
  }

  // 4. THB per USD by month, from the file (kept as they are when the file has none).
  if (hasRates) {
    await setDoc(doc(db, "revenueData", "rates"), { rates: data.rates, updatedAt: new Date().toISOString() });
    currentStep++;
    if (onProgress) onProgress(currentStep, totalSteps);
  }

  return {
    success: true,
    message: `บันทึกข้อมูล Revenue ${data.monthly.length} เดือน ขึ้น Firebase เรียบร้อยแล้ว`,
  };
}

