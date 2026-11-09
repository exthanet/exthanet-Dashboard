import assert from "node:assert/strict";
import test from "node:test";
import { programLabel, programList, programMatches, programValue } from "../lib/dashboard/programFilter.ts";

const options = ["ถกไม่เถียง", "เงินทองของจริง", "Kidsfun"];

test("one, several or every program", () => {
  assert.equal(programList("ALL"), null);
  assert.deepEqual(programList("ถกไม่เถียง"), ["ถกไม่เถียง"]);
  assert.deepEqual(programList("ถกไม่เถียง|Kidsfun"), ["ถกไม่เถียง", "Kidsfun"]);
  assert.equal(programMatches("ALL", "x"), true);
  assert.equal(programMatches("ถกไม่เถียง|Kidsfun", "Kidsfun"), true);
  assert.equal(programMatches("ถกไม่เถียง|Kidsfun", "เงินทองของจริง"), false);
});

test("all picked is ALL, none is NONE; order follows the options", () => {
  assert.equal(programValue([], options), "NONE");
  assert.deepEqual(programList("NONE"), []);
  assert.equal(programMatches("NONE", "ถกไม่เถียง"), false);
  assert.equal(programLabel("NONE"), "ยังไม่ได้เลือก");
  assert.equal(programValue([...options], options), "ALL");
  assert.equal(programValue(["Kidsfun", "ถกไม่เถียง"], options), "ถกไม่เถียง|Kidsfun");
  assert.equal(programLabel("ALL"), "ทั้งหมด");
  assert.equal(programLabel("Kidsfun"), "Kidsfun");
  assert.equal(programLabel("ถกไม่เถียง|Kidsfun"), "ถกไม่เถียง, Kidsfun");
});
