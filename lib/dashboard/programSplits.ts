// แยกรายการย่อย: clips of a program whose title or hashtags name a sub-show are moved
// to that sub-show (ถกใจคนค้นหมาป่า out of ถกไม่เถียง). Admins keep the rules in Firestore
// syncConfig/programSplits; what the system moved is remembered in
// syncConfig/programSplitsMoved, so turning a rule off returns only those rows to the
// parent and never touches a Program the team typed. The admin page applies the rules
// at once; the daily sync applies them to new and old rows every run.
//
// Relative imports only: the sync runs this file directly with Node.

export interface ProgramSplit {
  id: string;
  /** The sub-show the clips move to. */
  name: string;
  /** Only rows whose Program is this move. */
  parent: string;
  /** Any one in the title or hashtags, ignoring spaces and letter case. */
  keywords: string[];
  enabled: boolean;
}

/** Per rule id: the sub-show and parent at the time, and the rows (rowKey) the system moved. */
export type SplitMoved = Record<string, { name: string; parent: string; keys: string[] }>;

export interface SplitChange {
  index: number;
  from: string;
  to: string;
  /** "move" = parent → sub-show, "back" = a moved row returned to its parent. */
  kind: "move" | "back";
}

type SplitRow = { Platform?: unknown; Program?: unknown; Topic?: unknown; Hashtags?: unknown };

const squash = (v: unknown) => String(v ?? "").replace(/\s+/g, "").toLowerCase();

/** Rules that can run: a name, a different parent and at least one keyword. */
export function activeSplits(rules: ProgramSplit[]): ProgramSplit[] {
  return rules.filter((r) => r.enabled && r.name.trim() && r.parent.trim() && r.name.trim() !== r.parent.trim() && r.keywords.some((k) => squash(k)));
}

/** The first active rule for this row (its Program is the rule's parent and a keyword is in its text). */
export function splitFor(row: SplitRow, rules: ProgramSplit[]): ProgramSplit | null {
  if (row.Platform === "TV") return null;
  const program = String(row.Program ?? "");
  const text = squash(`${row.Topic ?? ""} ${row.Hashtags ?? ""}`);
  return activeSplits(rules).find((r) => r.parent === program && r.keywords.some((k) => squash(k) && text.includes(squash(k)))) || null;
}

/**
 * What the rules change, without changing anything. A moved row goes back to its parent
 * when its rule is gone, off, renamed or no longer matches, and only while it still
 * carries the sub-show the system gave it. Then every parent row a rule matches moves.
 */
export function planProgramSplits(
  rows: SplitRow[],
  rules: ProgramSplit[],
  moved: SplitMoved,
  keyOf: (row: SplitRow) => string,
  /** Rows an admin set by hand (programEdits): rules never move them. */
  locked: Set<string> = new Set(),
): { changes: SplitChange[]; moved: SplitMoved } {
  const byKey = new Map<string, number>();
  rows.forEach((r, i) => {
    const k = keyOf(r);
    if (k) byKey.set(k, i);
  });
  const program = rows.map((r) => String(r.Program ?? ""));
  const changes: SplitChange[] = [];
  const active = activeSplits(rules);

  for (const [id, entry] of Object.entries(moved)) {
    for (const k of entry.keys) {
      const i = byKey.get(k);
      if (i === undefined || program[i] !== entry.name || locked.has(k)) continue;
      const rule = active.find((r) => r.id === id);
      const still = rule && rule.name === entry.name && rule.parent === entry.parent && splitFor({ ...rows[i], Program: entry.parent }, active)?.id === id;
      if (still) continue;
      changes.push({ index: i, from: entry.name, to: entry.parent, kind: "back" });
      program[i] = entry.parent;
    }
  }

  const next: SplitMoved = {};
  for (const r of active) next[r.id] = { name: r.name, parent: r.parent, keys: [] };
  for (const [id, entry] of Object.entries(moved)) {
    const r = next[id];
    if (!r || r.name !== entry.name || r.parent !== entry.parent) continue;
    for (const k of entry.keys) {
      const i = byKey.get(k);
      if (i !== undefined && program[i] === entry.name) r.keys.push(k);
    }
  }
  rows.forEach((row, i) => {
    const rule = splitFor({ ...row, Program: program[i] }, active);
    if (!rule) return;
    const k = keyOf(row);
    if (!k || locked.has(k)) return;
    changes.push({ index: i, from: program[i], to: rule.name, kind: "move" });
    program[i] = rule.name;
    next[rule.id].keys.push(k);
  });
  return { changes, moved: next };
}

/** Apply a plan to the rows in place. */
export function applySplitChanges(rows: { Program?: unknown }[], changes: SplitChange[]): void {
  for (const c of changes) rows[c.index].Program = c.to;
}

/** For reports kept in the parent's line (the accounting team's Monthly ACC): sub-show → parent. */
export function splitParents(rules: ProgramSplit[]): Map<string, string> {
  return new Map(rules.filter((r) => r.name.trim() && r.parent.trim()).map((r) => [r.name.trim(), r.parent.trim()]));
}

/** What an admin set by hand per row (syncConfig/programEdits): rowKey → program and/or Topic_Type. */
export type ProgramEdits = Record<string, { program?: string; topicType?: string; by?: string; at?: string }>;

export function readProgramEdits(data: unknown): ProgramEdits {
  const e = (data as { edits?: unknown })?.edits;
  const out: ProgramEdits = {};
  if (!e || typeof e !== "object") return out;
  for (const [k, v] of Object.entries(e as Record<string, Record<string, unknown>>)) {
    const program = String(v?.program ?? "").trim();
    const topicType = String(v?.topicType ?? "").trim();
    if (!program && !topicType) continue;
    out[k] = { ...(program ? { program } : {}), ...(topicType ? { topicType } : {}), ...(v.by ? { by: String(v.by) } : {}), ...(v.at ? { at: String(v.at) } : {}) };
  }
  return out;
}

/** Rows whose Program an admin set: the แยกรายการย่อย rules leave them alone. */
export const lockedByEdits = (edits: ProgramEdits) => new Set(Object.entries(edits).filter(([, e]) => e.program).map(([k]) => k));

/** Firestore → rules / moved, tolerating missing or odd fields. */
export function readSplits(data: unknown): ProgramSplit[] {
  const list = (data as { rules?: unknown })?.rules;
  return (Array.isArray(list) ? list : []).map((r: Record<string, unknown>) => ({
    id: String(r.id ?? ""),
    name: String(r.name ?? "").trim(),
    parent: String(r.parent ?? "").trim(),
    keywords: (Array.isArray(r.keywords) ? r.keywords : []).map((k) => String(k).trim()).filter(Boolean),
    enabled: r.enabled !== false,
  })).filter((r) => r.id);
}

export function readSplitMoved(data: unknown): SplitMoved {
  const m = (data as { moved?: unknown })?.moved;
  const out: SplitMoved = {};
  if (!m || typeof m !== "object") return out;
  for (const [id, e] of Object.entries(m as Record<string, Record<string, unknown>>)) {
    out[id] = { name: String(e?.name ?? ""), parent: String(e?.parent ?? ""), keys: (Array.isArray(e?.keys) ? e.keys : []).map(String) };
  }
  return out;
}
