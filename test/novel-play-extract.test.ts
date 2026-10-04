import assert from "node:assert/strict";
import test from "node:test";
import { extractNovelEvents, type NovelExtractionCheckpoint, type NovelExtractionModelCall } from "../src/novel-play/extract.ts";
import type { NovelSource } from "../src/novel-play/source.ts";

const skillBody = "Extract events from the supplied chunk as strict JSON.";
const source: NovelSource = {
	version: 1,
	docId: "novel-1",
	title: "测试小说",
	fingerprint: "fingerprint-a",
	chunkChars: 100,
	chunks: [
		{ index: 0, chars: 11, chapters: ["第一章"], text: "甲推开门。雨落下来。" },
		{ index: 1, chars: 11, chapters: [], text: "钟声响起。众人离开。" },
	],
};

const result = (nodes: unknown[]): string => JSON.stringify({ nodes });
const event = (overrides: Record<string, unknown> = {}) => ({
	key: "door",
	title: "开门",
	summary: "甲推开门。",
	visibility: "public",
	dependsOn: [],
	quote: "甲推开门。",
	...overrides,
});

function sequence(outputs: Array<string | Error>, calls: { count: number }): NovelExtractionModelCall {
	return async () => {
		const output = outputs[calls.count++];
		if (output instanceof Error) throw output;
		if (output === undefined) throw new Error("unexpected model call");
		return output;
	};
}

test("extracts one stage per event-containing chunk, resolves exact offsets, visibility and local dependencies", async () => {
	const calls = { count: 0 };
	const extracted = await extractNovelEvents(source, {
		skillBody,
		modelCall: sequence([
			result([
				event(),
				event({ key: "rain", title: "下雨", summary: "雨开始落下。", visibility: "secret", dependsOn: ["door"], quote: "雨落下来。" }),
			]),
			result([event({ key: "bell", title: "钟响", summary: "钟声响起。", quote: "钟声响起。" })]),
		], calls),
	});
	assert.equal(calls.count, 2);
	assert.deepEqual(extracted.package.stages.map(stage => stage.title), ["第一章", "分块 2"]);
	assert.deepEqual(extracted.package.stages.map(stage => stage.order), [0, 1]);
	assert.equal(extracted.package.nodes[0].sourceRefs[0].start, 0);
	assert.equal(extracted.package.nodes[0].sourceRefs[0].end, "甲推开门。".length);
	assert.equal(extracted.package.nodes[1].visibility, "secret");
	assert.deepEqual(extracted.package.nodes[1].dependsOn, [extracted.package.nodes[0].id]);
	assert.match(extracted.package.nodes[0].id, /^canon-[a-f0-9]{24}$/);
});

test("retries invalid JSON and stops after at most two attempts", async () => {
	const calls = { count: 0 };
	await assert.rejects(
		extractNovelEvents({ ...source, chunks: [source.chunks[0]] }, {
			skillBody,
			maxAttempts: 99,
			modelCall: sequence(["not json", "still not json", result([event()])], calls),
		}),
		/failed for chunk 0 after 2 attempt\(s\)/,
	);
	assert.equal(calls.count, 2);
});

test("rejects duplicate and nonmatching evidence quotes", async () => {
	const duplicateSource: NovelSource = {
		...source,
		chunks: [{ index: 0, chars: 6, chapters: ["重复"], text: "门开。门开。" }],
	};
	const duplicateCalls = { count: 0 };
	await assert.rejects(extractNovelEvents(duplicateSource, {
		skillBody,
		maxAttempts: 1,
		modelCall: sequence([result([event({ quote: "门开。" })])], duplicateCalls),
	}), /quote must occur exactly once/);

	const missingCalls = { count: 0 };
	await assert.rejects(extractNovelEvents({ ...source, chunks: [source.chunks[0]] }, {
		skillBody,
		maxAttempts: 1,
		modelCall: sequence([result([event({ quote: "不存在。" })])], missingCalls),
	}), /quote must occur exactly once/);
});

test("accepts an empty prefix and omits its stage without inventing an event", async () => {
	const sparse: NovelSource = {
		...source,
		chunks: [
			{ index: 0, chars: 4, chapters: ["版权"], text: "版权说明" },
			{ index: 1, chars: source.chunks[0].text.length, chapters: ["第一章"], text: source.chunks[0].text },
		],
	};
	const calls = { count: 0 };
	const extracted = await extractNovelEvents(sparse, {
		skillBody,
		modelCall: sequence([result([]), result([event()])], calls),
	});
	assert.equal(calls.count, 2);
	assert.deepEqual(extracted.package.stages.map(stage => ({ id: stage.id, order: stage.order })), [{ id: "chunk-1", order: 0 }]);
	assert.equal(extracted.package.nodes.length, 1);
	assert.equal(extracted.package.nodes[0].stageId, "chunk-1");
});

test("omits an empty chunk between event stages and keeps stage order contiguous", async () => {
	const sparse: NovelSource = {
		...source,
		chunks: [
			source.chunks[0],
			{ index: 1, chars: 3, chapters: ["题记"], text: "题记。" },
			{ index: 2, chars: source.chunks[1].text.length, chapters: ["第二章"], text: source.chunks[1].text },
		],
	};
	const calls = { count: 0 };
	const extracted = await extractNovelEvents(sparse, {
		skillBody,
		modelCall: sequence([
			result([event()]),
			result([]),
			result([event({ key: "bell", title: "钟响", summary: "钟声响起。", quote: "钟声响起。" })]),
		], calls),
	});
	assert.deepEqual(extracted.package.stages.map(stage => ({ id: stage.id, order: stage.order })), [
		{ id: "chunk-0", order: 0 },
		{ id: "chunk-2", order: 1 },
	]);
	assert.deepEqual(extracted.package.nodes.map(node => node.order), [0, 1]);
});

test("caches an empty successful chunk and resumes without another model call", async () => {
	const sparse: NovelSource = {
		...source,
		chunks: [
			{ index: 0, chars: 4, chapters: ["版权"], text: "版权说明" },
			{ index: 1, chars: source.chunks[0].text.length, chapters: ["第一章"], text: source.chunks[0].text },
		],
	};
	const calls = { count: 0 };
	const first = await extractNovelEvents(sparse, {
		skillBody,
		modelCall: sequence([result([]), result([event()])], calls),
	});
	assert.equal(first.checkpoint.completed["0"], result([]));
	let resumedCalls = 0;
	const resumed = await extractNovelEvents(sparse, {
		skillBody,
		checkpoint: first.checkpoint,
		modelCall: async () => { resumedCalls++; throw new Error("must not run"); },
	});
	assert.equal(resumedCalls, 0);
	assert.equal(resumed.package.revision, first.package.revision);
});

test("rejects a complete source with no playable events after checkpointing empty chunks", async () => {
	const emptySource: NovelSource = {
		...source,
		chunks: [
			{ index: 0, chars: 4, chapters: ["版权"], text: "版权说明" },
			{ index: 1, chars: 3, chapters: ["题记"], text: "题记。" },
		],
	};
	const checkpoints: NovelExtractionCheckpoint[] = [];
	await assert.rejects(extractNovelEvents(emptySource, {
		skillBody,
		modelCall: async () => result([]),
		onCheckpoint: checkpoint => { checkpoints.push(checkpoint); },
	}), /found no playable events in the complete source/);
	assert.equal(checkpoints.length, 2);
	assert.deepEqual(Object.keys(checkpoints.at(-1)!.completed), ["0", "1"]);
});

test("rejects an all-secret package because it has no public starting point", async () => {
	await assert.rejects(extractNovelEvents({ ...source, chunks: [source.chunks[0]] }, {
		skillBody,
		modelCall: async () => result([event({ visibility: "secret" })]),
	}), /no public starting point; all evidenced events are secret/);
});

test("honors an already aborted signal without calling the model", async () => {
	const controller = new AbortController();
	controller.abort();
	let called = false;
	await assert.rejects(extractNovelEvents(source, {
		skillBody,
		signal: controller.signal,
		modelCall: async () => { called = true; return result([event()]); },
	}), (error: unknown) => error instanceof Error && error.name === "AbortError");
	assert.equal(called, false);
});

test("reuses valid checkpoint chunks only when the fingerprint, layout and skill hash key match", async () => {
	const firstCalls = { count: 0 };
	const first = await extractNovelEvents(source, {
		skillBody,
		modelCall: sequence([
			result([event()]),
			result([event({ key: "bell", title: "钟响", summary: "钟声响起。", quote: "钟声响起。" })]),
		], firstCalls),
	});
	let resumedCalls = 0;
	const resumed = await extractNovelEvents(source, {
		skillBody,
		checkpoint: first.checkpoint,
		modelCall: async () => { resumedCalls++; throw new Error("must not run"); },
	});
	assert.equal(resumedCalls, 0);
	assert.equal(resumed.package.revision, first.package.revision);

	const changedCalls = { count: 0 };
	await extractNovelEvents({ ...source, fingerprint: "fingerprint-b" }, {
		skillBody,
		checkpoint: first.checkpoint,
		modelCall: sequence([
			result([event()]),
			result([event({ key: "bell", title: "钟响", summary: "钟声响起。", quote: "钟声响起。" })]),
		], changedCalls),
	});
	assert.equal(changedCalls.count, 2);
});

test("validates cached output with the same rules and replaces an invalid cached chunk", async () => {
	const seedCalls = { count: 0 };
	const seed = await extractNovelEvents({ ...source, chunks: [source.chunks[0]] }, {
		skillBody,
		modelCall: sequence([result([event()])], seedCalls),
	});
	seed.checkpoint.completed["0"] = result([event({ quote: "不存在。" })]);
	const retryCalls = { count: 0 };
	const recovered = await extractNovelEvents({ ...source, chunks: [source.chunks[0]] }, {
		skillBody,
		checkpoint: seed.checkpoint,
		modelCall: sequence([result([event()])], retryCalls),
	});
	assert.equal(retryCalls.count, 1);
	assert.equal(recovered.package.nodes.length, 1);
});

test("publishes the first validated chunk before a later failure and resumes without repeating it", async () => {
	const checkpoints: NovelExtractionCheckpoint[] = [];
	const failingCalls = { count: 0 };
	await assert.rejects(extractNovelEvents(source, {
		skillBody,
		maxAttempts: 1,
		modelCall: sequence([result([event()]), "invalid second chunk"], failingCalls),
		onCheckpoint: async checkpoint => { checkpoints.push(checkpoint); },
	}), /failed for chunk 1/);
	assert.equal(checkpoints.length, 1);
	assert.deepEqual(Object.keys(checkpoints[0].completed), ["0"]);

	const resumedCalls = { count: 0 };
	const resumed = await extractNovelEvents(source, {
		skillBody,
		checkpoint: checkpoints[0],
		modelCall: sequence([
			result([event({ key: "bell", title: "钟响", summary: "钟声响起。", quote: "钟声响起。" })]),
		], resumedCalls),
	});
	assert.equal(resumedCalls.count, 1);
	assert.equal(resumed.package.nodes.length, 2);
});

test("rejects and retries a forward dependency before publishing a checkpoint", async () => {
	const single = { ...source, chunks: [source.chunks[0]] };
	const forward = result([
		event({ key: "rain", title: "下雨", summary: "雨开始落下。", dependsOn: ["door"], quote: "雨落下来。" }),
		event(),
	]);
	const valid = result([
		event(),
		event({ key: "rain", title: "下雨", summary: "雨开始落下。", dependsOn: ["door"], quote: "雨落下来。" }),
	]);
	const calls = { count: 0 };
	const checkpoints: NovelExtractionCheckpoint[] = [];
	const extracted = await extractNovelEvents(single, {
		skillBody,
		modelCall: sequence([forward, valid], calls),
		onCheckpoint: checkpoint => { checkpoints.push(checkpoint); },
	});
	assert.equal(calls.count, 2);
	assert.equal(checkpoints.length, 1);
	assert.equal(checkpoints[0].completed["0"], valid);
	assert.deepEqual(extracted.package.nodes[1].dependsOn, [extracted.package.nodes[0].id]);
});

test("rejects out-of-source-order events and retries before checkpointing", async () => {
	const outOfOrder = result([
		event({ key: "rain", title: "下雨", summary: "雨开始落下。", quote: "雨落下来。" }),
		event(),
	]);
	const valid = result([
		event(),
		event({ key: "rain", title: "下雨", summary: "雨开始落下。", quote: "雨落下来。" }),
	]);
	const calls = { count: 0 };
	const checkpoints: NovelExtractionCheckpoint[] = [];
	const extracted = await extractNovelEvents({ ...source, chunks: [source.chunks[0]] }, {
		skillBody,
		modelCall: sequence([outOfOrder, valid], calls),
		onCheckpoint: checkpoint => { checkpoints.push(checkpoint); },
	});
	assert.equal(calls.count, 2);
	assert.equal(checkpoints.length, 1);
	assert.equal(checkpoints[0].completed["0"], valid);
	assert.deepEqual(extracted.package.nodes.map(node => node.key), ["door", "rain"]);
});

test("rejects a non-finite maxAttempts value before calling the model", async () => {
	let called = false;
	await assert.rejects(extractNovelEvents(source, {
		skillBody,
		maxAttempts: Number.NaN,
		modelCall: async () => { called = true; return result([event()]); },
	}), /maxAttempts must be finite/);
	assert.equal(called, false);
});
