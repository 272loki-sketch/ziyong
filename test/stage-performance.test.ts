import assert from "node:assert/strict";
import { test } from "node:test";
import { TurnPerformanceCollector, projectTurnPerformance } from "../src/stage/performance.ts";

test("performance total is wall time, overlapping phases are not summed", () => {
	let now = 0;
	const collector = new TurnPerformanceCollector(() => now);
	const prep = collector.beginPhase("prep");
	const a = collector.beginCall("prep.arrival");
	now = 5; const b = collector.beginCall("prep.continuity");
	now = 10; a.usage({ input: 10, cacheRead: 5, output: 3, secret: "ignored" }); a.end("success");
	now = 15; b.end("success"); prep("success");
	const data = collector.finish("a1");
	assert.equal(data.totalMs, 15);
	assert.equal(data.phases["prep.arrival"]?.durationMs, 10);
	assert.equal(data.phases["prep.continuity"]?.durationMs, 10);
	assert.equal(data.phases.prep?.durationMs, 15);
	assert.equal(data.phases["prep.arrival"]?.inputTokens, 15);
	assert.equal(data.phases["prep.continuity"]?.inputTokens, undefined);
});
test("collector belongs to its originating turn and ignores late completions after finish", () => {
	let now = 0;
	const first = new TurnPerformanceCollector(() => now), call = first.beginCall("prep.director");
	now = 5; first.narrative(); now = 10; const original = first.finish("a1");
	const second = new TurnPerformanceCollector(() => now); now = 20;
	call.usage({ input: 999, output: 999 }); call.end("success");
	assert.equal(original.phases["prep.director"]?.inputTokens, undefined);
	assert.equal(original.timeToFirstNarrativeMs, 5);
	assert.deepEqual(second.finish("a2").phases, {});
});
test("performance projection binds source and strips arbitrary prompts/secrets/phase names", () => {
	const raw = { version: 1, narrativeEntryId: "a1", totalMs: 20, timeToFirstNarrativeMs: 30, prompt: "secret", phases: { writer: { durationMs: 10, calls: 2, inputTokens: 10, prompt: "secret", status: "success" }, "secret-key": { durationMs: 1, calls: 1 }, curtain: { durationMs: NaN, calls: 1 } } };
	assert.equal(projectTurnPerformance(raw, "other"), undefined);
	const data = projectTurnPerformance(raw, "a1")!;
	assert.equal(data.timeToFirstNarrativeMs, undefined);
	assert.deepEqual(Object.keys(data.phases), ["writer"]);
	assert.equal(JSON.stringify(data).includes("secret"), false);
});
