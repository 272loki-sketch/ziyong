import assert from "node:assert/strict";
import test from "node:test";
import { buildNovelPackage } from "../src/novel-play/canon.ts";
import { extendNovelPackage } from "../src/novel-play/extend.ts";
import { novelNodeId, type NovelSource } from "../src/novel-play/source.ts";
import type { StoredNovelPackage } from "../src/novel-play/store.ts";

const oldText = "旧事件已经发生。";
const oldSource: NovelSource = { version: 1, docId: "old", title: "书", fingerprint: "old-fp", chunkChars: 100, chunks: [{ index: 0, chars: oldText.length, chapters: ["第一章"], text: oldText }] };
const oldRef = { chunkIndex: 0, start: 0, end: 3, quote: "旧事件" };
const oldNode = { id: novelNodeId(oldSource, oldRef, "old-event"), key: "old-event", stageId: "chunk-0", order: 0, title: "旧事件", summary: "旧事件摘要", visibility: "public" as const, dependsOn: [], sourceRefs: [oldRef] };
const oldPackage = buildNovelPackage(oldSource, [{ id: "chunk-0", order: 0, title: "第一章" }], [oldNode]);

test("追加作品包继承旧节点，只提取新增分块并保留旧 ID", async () => {
	const targetText = "新增事件已经发生。";
	const targetSource: NovelSource = { version: 1, docId: "new", title: "书", fingerprint: "new-fp", chunkChars: 100, chunks: [oldSource.chunks[0]!, { index: 1, chars: targetText.length, chapters: ["第二章"], text: targetText }] };
	const result = await extendNovelPackage({
		base: { version: 1, source: oldSource, package: oldPackage } satisfies StoredNovelPackage,
		target: { source: targetSource, packageDocId: "new" },
		skillBody: "只提取新增事件",
		modelCall: async ({ chunk }) => JSON.stringify({ nodes: [{ key: "new-event", title: "新事件", summary: "新事件摘要", visibility: "public", dependsOn: [], quote: chunk.text.slice(0, 3) }] }),
	});
	assert.equal(result.lineage?.parentRevision, oldPackage.revision);
	assert.ok(result.nodes.some(node => node.id === oldNode.id));
	assert.equal(result.nodes.length, 2);
	assert.equal(result.nodes[1]?.sourceRefs[0]?.chunkIndex, 1);
});

test("追加作品包拒绝改变旧分块边界", async () => {
	const targetSource: NovelSource = { version: 1, docId: "new", title: "书", fingerprint: "new-fp", chunkChars: 100, chunks: [{ index: 0, chars: 4, chapters: [], text: "旧事件被改" }, { index: 1, chars: 2, chapters: [], text: "新" }] };
	await assert.rejects(extendNovelPackage({
		base: { version: 1, source: oldSource, package: oldPackage }, target: { source: targetSource, packageDocId: "new" }, skillBody: "x", modelCall: async () => "{\"nodes\":[]}",
	}), /改变了旧作品包的分块边界/);
});
