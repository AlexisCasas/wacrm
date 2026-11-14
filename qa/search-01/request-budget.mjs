#!/usr/bin/env node
/**
 * SEARCH-01 request-cost model. No network or database access.
 * Based on the pagination/request structure in PR #120 (30244a7)
 * and PR #121 (cdc50b3). NOT a real latency benchmark.
 */
import assert from "node:assert/strict";

const SEARCH_PAGE = 1000;
const HYDRATION_BATCH = 100;
const HYDRATION_PARALLEL = 4;

function pageRequests(n) {
  assert(Number.isSafeInteger(n) && n >= 0);
  // A full page requires an additional request to discover completion.
  return Math.floor(n / SEARCH_PAGE) + 1;
}

function compare({ label, contacts, messages, overlap }) {
  assert(contacts >= overlap && messages >= overlap && overlap >= 0);
  const unique = contacts + messages - overlap;
  const searchRequests = pageRequests(contacts) + pageRequests(messages);
  const hydrationRequests = Math.ceil(unique / HYDRATION_BATCH);
  return {
    label,
    unique,
    baseline: searchRequests,
    candidate: searchRequests + hydrationRequests,
    additionalSequentialWaves: Math.ceil(hydrationRequests / HYDRATION_PARALLEL),
  };
}

const scenarios = [
  { label: "Phone only in contact", contacts: 1, messages: 0, overlap: 0 },
  { label: "Phone in contact and last message", contacts: 1, messages: 1, overlap: 1 },
  { label: "Name, 10 contacts", contacts: 10, messages: 0, overlap: 0 },
  { label: "Short term, 1,500 unique", contacts: 1000, messages: 1000, overlap: 500 },
  { label: "Broad term, 20,000 unique", contacts: 10000, messages: 10000, overlap: 0 },
  { label: "Broad term, all branch results duplicate", contacts: 10000, messages: 10000, overlap: 10000 },
];

const rows = scenarios.map(compare);
assert.deepEqual(rows.map((r) => r.baseline), [2, 2, 2, 4, 22, 22]);
assert.deepEqual(rows.map((r) => r.candidate), [3, 3, 3, 19, 222, 122]);

console.log("| Scenario | Unique results | #120 requests | #121 requests | Extra sequential hydration waves |");
console.log("|---|---:|---:|---:|---:|");
for (const r of rows) {
  console.log(`| ${r.label} | ${r.unique} | ${r.baseline} | ${r.candidate} | ${r.additionalSequentialWaves} |`);
}
console.log("\nCost model only: no actual SQL, p50/p95, bytes, RLS or network latency measured.");
