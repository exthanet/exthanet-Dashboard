// The รายการ filter picks one, several, every or no program. It stays one string so the
// rest of the dashboard keeps working unchanged: "ALL", "NONE", one name, or several names
// joined by PROGRAM_SEP.
//
// Relative imports only: tests run this file directly with Node.

export const PROGRAM_SEP = "|";
/** Every box unticked: no program, so nothing is shown until one is picked. */
export const PROGRAM_NONE = "NONE";

/** The picked programs; null = every program, [] = none. */
export function programList(value: string): string[] | null {
  if (!value || value === "ALL") return null;
  if (value === PROGRAM_NONE) return [];
  return value.split(PROGRAM_SEP).filter(Boolean);
}

export function programMatches(value: string, program: string): boolean {
  const list = programList(value);
  return !list || list.includes(program);
}

/** Back to a filter value: all picked = "ALL", none picked = "NONE". */
export function programValue(picked: string[], options: string[]): string {
  const keep = options.filter((o) => picked.includes(o));
  if (!keep.length) return PROGRAM_NONE;
  return keep.length === options.length ? "ALL" : keep.join(PROGRAM_SEP);
}

/** "ทั้งหมด", "ยังไม่ได้เลือก", or the names: "ถกไม่เถียง, Kidsfun". */
export function programLabel(value: string): string {
  const list = programList(value);
  if (!list) return "ทั้งหมด";
  if (!list.length) return "ยังไม่ได้เลือก";
  return list.join(", ");
}
