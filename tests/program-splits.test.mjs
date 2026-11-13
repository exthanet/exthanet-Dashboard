import test from "node:test";
import assert from "node:assert/strict";
import { applySplitChanges, planProgramSplits, readSplitMoved, readSplits, splitFor, splitParents } from "../lib/dashboard/programSplits.ts";

const wolf = { id: "w", name: "ถกใจคนค้นหมาป่า", parent: "ถกไม่เถียง", keywords: ["ถกใจคนค้นหมาป่า", "WereWolf"], enabled: true };
const key = (r) => r.key || "";
const row = (key, Program, Topic, extra = {}) => ({ key, Platform: "YouTube", Program, Topic, Hashtags: "", ...extra });

test("a rule matches its parent's rows by title or hashtags, spaces and case ignored", () => {
  assert.equal(splitFor(row("a", "ถกไม่เถียง", "“ถกใจคน ค้นหมาป่า” EP.2"), [wolf])?.id, "w");
  assert.equal(splitFor(row("b", "ถกไม่เถียง", "เกม WEREWOLF"), [wolf])?.id, "w");
  assert.equal(splitFor(row("c", "ถกไม่เถียง", "ข่าว", { Hashtags: "#ถกใจคนค้นหมาป่า" }), [wolf])?.id, "w");
  // Another program, a plain "หมาป่า", TV, or the rule switched off: no match.
  assert.equal(splitFor(row("d", "PROMO", "ถกใจคนค้นหมาป่า"), [wolf]), null);
  assert.equal(splitFor(row("e", "ถกไม่เถียง", "หมาป่าเดียวดาย #หมาป่า"), [wolf]), null);
  assert.equal(splitFor(row("f", "ถกไม่เถียง", "ถกใจคนค้นหมาป่า", { Platform: "TV" }), [wolf]), null);
  assert.equal(splitFor(row("g", "ถกไม่เถียง", "ถกใจคนค้นหมาป่า"), [{ ...wolf, enabled: false }]), null);
});

test("moves parent rows, remembers them, and leaves team labels alone", () => {
  const rows = [row("a", "ถกไม่เถียง", "#ถกใจคนค้นหมาป่า"), row("b", "ถกใจคนค้นหมาป่า", "ทีมกรอกเอง"), row("c", "ถกไม่เถียง", "ข่าวทั่วไป"), row("", "ถกไม่เถียง", "werewolf ไม่มี key")];
  const plan = planProgramSplits(rows, [wolf], {}, key);
  assert.deepEqual(plan.changes, [{ index: 0, from: "ถกไม่เถียง", to: "ถกใจคนค้นหมาป่า", kind: "move" }]);
  assert.deepEqual(plan.moved, { w: { name: "ถกใจคนค้นหมาป่า", parent: "ถกไม่เถียง", keys: ["a"] } });
  applySplitChanges(rows, plan.changes);
  assert.equal(rows[0].Program, "ถกใจคนค้นหมาป่า");
  // Run again: nothing more to do, the record stays.
  const again = planProgramSplits(rows, [wolf], plan.moved, key);
  assert.deepEqual(again.changes, []);
  assert.deepEqual(again.moved, plan.moved);
  // Rule off: only the moved row goes back; the team's row stays.
  const off = planProgramSplits(rows, [{ ...wolf, enabled: false }], plan.moved, key);
  assert.deepEqual(off.changes, [{ index: 0, from: "ถกใจคนค้นหมาป่า", to: "ถกไม่เถียง", kind: "back" }]);
  assert.deepEqual(off.moved, {});
  // Rule deleted: same.
  assert.deepEqual(planProgramSplits(rows, [], plan.moved, key).changes.map((c) => c.kind), ["back"]);
});

test("a moved row the team relabelled is forgotten, not changed", () => {
  const rows = [row("a", "PROMO", "#ถกใจคนค้นหมาป่า")];
  const plan = planProgramSplits(rows, [{ ...wolf, enabled: false }], { w: { name: "ถกใจคนค้นหมาป่า", parent: "ถกไม่เถียง", keys: ["a"] } }, key);
  assert.deepEqual(plan.changes, []);
  assert.deepEqual(plan.moved, {});
});

test("renamed rule or edited keywords: back to the parent, then moved again where it still matches", () => {
  const moved = { w: { name: "ถกใจคนค้นหมาป่า", parent: "ถกไม่เถียง", keys: ["a", "b"] } };
  const rows = [row("a", "ถกใจคนค้นหมาป่า", "#ถกใจคนค้นหมาป่า"), row("b", "ถกใจคนค้นหมาป่า", "werewolf")];
  const renamed = planProgramSplits(rows, [{ ...wolf, name: "หมาป่า" }], moved, key);
  assert.deepEqual(renamed.changes.map((c) => [c.index, c.kind, c.to]), [[0, "back", "ถกไม่เถียง"], [1, "back", "ถกไม่เถียง"], [0, "move", "หมาป่า"], [1, "move", "หมาป่า"]]);
  const fewer = planProgramSplits(rows, [{ ...wolf, keywords: ["ถกใจคนค้นหมาป่า"] }], moved, key);
  assert.deepEqual(fewer.changes, [{ index: 1, from: "ถกใจคนค้นหมาป่า", to: "ถกไม่เถียง", kind: "back" }]);
  assert.deepEqual(fewer.moved.w.keys, ["a"]);
});

test("the first rule wins when two match", () => {
  const sly = { id: "s", name: "ถกใจคนค้นคนเหลี่ยม", parent: "ถกไม่เถียง", keywords: ["คนค้นคนเหลี่ยม"], enabled: true };
  const r = row("a", "ถกไม่เถียง", "#ถกใจคนค้นคนเหลี่ยม werewolf");
  assert.equal(splitFor(r, [wolf, sly]).id, "w");
  assert.equal(splitFor(r, [sly, wolf]).id, "s");
});

test("reading Firestore data and the parent map", () => {
  assert.deepEqual(readSplits({ rules: [{ id: "w", name: " ถกใจคนค้นหมาป่า ", parent: "ถกไม่เถียง", keywords: [" WereWolf ", ""] }, { name: "no id" }] }), [
    { id: "w", name: "ถกใจคนค้นหมาป่า", parent: "ถกไม่เถียง", keywords: ["WereWolf"], enabled: true },
  ]);
  assert.deepEqual(readSplits(null), []);
  assert.deepEqual(readSplitMoved({ moved: { w: { name: "x", parent: "y", keys: ["a", 1] } } }), { w: { name: "x", parent: "y", keys: ["a", "1"] } });
  assert.deepEqual([...splitParents([wolf])], [["ถกใจคนค้นหมาป่า", "ถกไม่เถียง"]]);
});

test("a row an admin set by hand is never moved by a rule; edits are read from Firestore", async () => {
  const { readProgramEdits } = await import("../lib/dashboard/programSplits.ts");
  const rows = [row("a", "ไม่ระบุ", "#bettertrade2026"), row("b", "ไม่ระบุ", "#bettertrade2026")];
  const bt = { id: "bt", name: "BetterTrade 2026", parent: "ไม่ระบุ", keywords: ["bettertrade"], enabled: true };
  const plan = planProgramSplits(rows, [bt], {}, key, new Set(["b"]));
  assert.deepEqual(plan.changes.map((c) => c.index), [0]);
  // A moved row the admin later locked is not sent back either.
  const back = planProgramSplits([row("a", "BetterTrade 2026", "x")], [], { bt: { name: "BetterTrade 2026", parent: "ไม่ระบุ", keys: ["a"] } }, key, new Set(["a"]));
  assert.deepEqual(back.changes, []);
  assert.deepEqual(readProgramEdits({ edits: { "TikTok|1": { program: " Off Script Off Record ", by: "x" }, "TikTok|2": { program: "" }, "TikTok|3": { topicType: "ข่าวการเมือง" } } }), { "TikTok|1": { program: "Off Script Off Record", by: "x" }, "TikTok|3": { topicType: "ข่าวการเมือง" } });
  // Only a hand-set Program locks a row against the rules; a hand-set type alone does not.
  const { lockedByEdits } = await import("../lib/dashboard/programSplits.ts");
  assert.deepEqual([...lockedByEdits({ a: { program: "x" }, b: { topicType: "y" } })], ["a"]);
});
