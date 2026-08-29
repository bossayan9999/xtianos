import { test } from "node:test";
import assert from "node:assert/strict";

import { parseJudgeJson } from "./services/critic";
import { aggregateRuns, parseFlags } from "./services/run-record";

test("parseJudgeJson parses plain JSON objects", () => {
  const obj = parseJudgeJson('{"score":85,"grounded":true,"flags":["concise"],"verdict":"ok"}');
  assert.ok(obj);
  assert.equal(obj?.["score"], 85);
  assert.equal(obj?.["grounded"], true);
  assert.deepEqual(obj?.["flags"], ["concise"]);
});

test("parseJudgeJson tolerates markdown code fences", () => {
  const obj = parseJudgeJson('```json\n{"score":45,"grounded":false}\n```');
  assert.ok(obj);
  assert.equal(obj?.["score"], 45);
  assert.equal(obj?.["grounded"], false);
});

test("parseJudgeJson extracts embedded object and rejects garbage", () => {
  const obj = parseJudgeJson('Here is the review: {"score":70,"flags":[]} thanks!');
  assert.ok(obj);
  assert.equal(obj?.["score"], 70);
  assert.equal(parseJudgeJson("the judge exploded"), null);
  assert.equal(parseJudgeJson(""), null);
  assert.equal(parseJudgeJson('{"score":90'), null);
});

test("parseJudgeJson picks the first complete JSON object", () => {
  const obj = parseJudgeJson('{"a":1} trailing {"b":2}');
  assert.equal(obj?.["a"], 1);
  assert.equal(obj?.["b"], undefined);
});

test("parseFlags parses stored flag arrays and tolerates garbage", () => {
  assert.deepEqual(parseFlags('["grounded","concise"]'), ["grounded", "concise"]);
  assert.deepEqual(parseFlags("[42, null]"), []);
  assert.deepEqual(parseFlags("not json"), []);
  assert.deepEqual(parseFlags(""), []);
});

test("aggregateRuns computes avg/p95 latency and score aggregates", () => {
  const base = { status: "done", grounded: true, revisions: 0, createdAt: new Date() };
  const rows = [
    100,
    200,
    300,
    400,
    500,
    600,
    700,
    800,
    900,
    1000,
  ].map((latencyMs, i) => ({
    latencyMs,
    qualityScore: 80 + i,
    qualityFlags: i % 3 === 0 ? '["grounded","concise"]' : null,
    ...base,
  }));
  const agg = aggregateRuns(rows);
  assert.equal(agg.runs, 10);
  assert.equal(agg.avgLatencyMs, 550);
  assert.equal(agg.p95LatencyMs, 1000);
  assert.equal(agg.avgScore, 85);
  assert.equal(agg.scoredRuns, 10);
  assert.equal(agg.groundedRuns, 10);
  assert.equal(agg.flaggedRuns, 4);
  assert.equal(agg.flagCounts["grounded"], 4);
  assert.equal(agg.errorRuns, 0);
});

test("aggregateRuns handles empty input", () => {
  const agg = aggregateRuns([]);
  assert.equal(agg.runs, 0);
  assert.equal(agg.avgLatencyMs, 0);
  assert.equal(agg.p95LatencyMs, 0);
  assert.equal(agg.avgScore, null);
  assert.equal(agg.runsLast24h, 0);
});