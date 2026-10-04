import assert from "node:assert/strict";
import { test } from "node:test";
import { prepareNovelSource, novelNodeId, assertNovelEvidence } from "../src/novel-play/source.ts";
import { buildNovelPackage, projectNovelCandidates } from "../src/novel-play/canon.ts";
import { projectNovelSceneRecall } from "../src/novel-play/canon.ts";
import type { NovelNode } from "../src/novel-play/canon.ts";

function fixture() {
	const text = "她走进学校。她收到邀请。她参加聚会。";
	const doc = { id: "doc-fixture", title: "校园", status: "ready" as const, chars: text.length, chunkCount: 1 };
	const source = prepareNovelSource(doc, text);
	const ref = { chunkIndex: 0, start: 0, end: 7, quote: "她走进学校。她" };
	const nodes: NovelNode[] = [0, 1, 2].map(order => ({
		id: novelNodeId(source, ref, `event-${order}`), key: `event-${order}`,
		stageId: "school", order, title: `事件${order}`, summary: `原著候选${order}`,
		visibility: "public", dependsOn: [], sourceRefs: [ref],
	}));
	nodes[2].dependsOn = [nodes[1].id];
	const stages = [{ id: "school", order: 0, title: "入学" }];
	const pkg = buildNovelPackage(source, stages, nodes);
	const anchor = { packageRevision: pkg.revision, nodeId: nodes[0].id, position: "before" as const };
	const options = { ancestorEntryIds: new Set(["reply-a"]), conflicts: [], conflictsReady: true, maxChars: 4000 };
	return { text, doc, source, ref, nodes, stages, pkg, anchor, options };
}

test("小说作品：复用现有分块并按内容区分同名同大小原文", () => {
	const f = fixture();
	const changed = prepareNovelSource(f.doc, f.text.replace("学校", "公园"));
	assert.notEqual(changed.fingerprint, f.source.fingerprint);
	assert.throws(() => prepareNovelSource({ ...f.doc, status: "mapping" }, f.text));
	assert.throws(() => prepareNovelSource({ ...f.doc, chunkCount: 2 }, f.text));
	assert.throws(() => prepareNovelSource(f.doc, "不同长度"));
});

test("小说作品：证据必须精确回指，节点 ID 不依赖数组顺序", () => {
	const f = fixture();
	assertNovelEvidence(f.source, f.ref);
	assert.throws(() => assertNovelEvidence(f.source, { ...f.ref, quote: "伪造证据" }));
	assert.throws(() => assertNovelEvidence(f.source, { ...f.ref, start: -1 }));
	assert.equal(buildNovelPackage(f.source, f.stages, [...f.nodes].reverse()).revision, f.pkg.revision);
});

test("小说作品：拒绝重复节点、失效因果引用和未来依赖", () => {
	const f = fixture();
	assert.throws(() => buildNovelPackage(f.source, f.stages, [...f.nodes, f.nodes[0]]));
	assert.throws(() => buildNovelPackage(f.source, f.stages, f.nodes.map((n, i) => i === 0 ? { ...n, dependsOn: [f.nodes[2].id] } : n)));
	assert.throws(() => buildNovelPackage(f.source, f.stages, f.nodes.map((n, i) => i === 2 ? { ...n, dependsOn: ["missing"] } : n)));
});

test("小说候选：当前节点前后语义及版本绑定", () => {
	const f = fixture();
	assert.equal(projectNovelCandidates(f.pkg, f.anchor, f.options).candidates.length, 3);
	const result = projectNovelCandidates(f.pkg, { ...f.anchor, position: "after" }, f.options);
	assert.equal(result.candidates.length, 2);
	assert.ok(result.candidates.every(n => n.actuality === "candidate"));
	assert.throws(() => projectNovelCandidates(f.pkg, { ...f.anchor, packageRevision: "old" }, f.options));
});

test("小说候选：分支冲突只沿显式因果传播，回档后不再生效", () => {
	const f = fixture();
	const conflicts = [{ packageRevision: f.pkg.revision, nodeId: f.nodes[1].id, sourceEntryIds: ["reply-a"] }];
	const result = projectNovelCandidates(f.pkg, f.anchor, { ...f.options, conflicts });
	assert.deepEqual(result.candidates.map(n => n.nodeId), [f.nodes[0].id]);
	assert.deepEqual(new Set(result.blockedNodeIds), new Set([f.nodes[1].id, f.nodes[2].id]));
	const rewound = projectNovelCandidates(f.pkg, f.anchor, { ...f.options, conflicts, ancestorEntryIds: new Set() });
	assert.equal(rewound.candidates.length, 3);
	assert.equal(projectNovelCandidates(f.pkg, f.anchor, { ...f.options, conflicts: [{ ...conflicts[0], sourceEntryIds: [] }] }).candidates.length, 3);
});

test("小说候选：不跨阶段、不暴露秘密节点、未完成校准时不提供候选", () => {
	const f = fixture();
	const nodes = f.nodes.map((n, i) => i === 1 ? { ...n, visibility: "secret" as const } : i === 2 ? { ...n, stageId: "later" } : n);
	const pkg = buildNovelPackage(f.source, [...f.stages, { id: "later", order: 1, title: "后续" }], nodes);
	const anchor = { ...f.anchor, packageRevision: pkg.revision };
	assert.deepEqual(projectNovelCandidates(pkg, anchor, f.options).candidates.map(n => n.nodeId), [f.nodes[0].id]);
	assert.equal(projectNovelCandidates(pkg, anchor, { ...f.options, conflictsReady: false }).candidates.length, 0);
});

test("小说候选：预算包括序列化结构，超限省略且不截断事件", () => {
	const f = fixture();
	const full = projectNovelCandidates(f.pkg, f.anchor, f.options);
	const maxChars = JSON.stringify([full.candidates[0]]).length;
	const bounded = projectNovelCandidates(f.pkg, f.anchor, { ...f.options, maxChars });
	assert.equal(bounded.candidates.length, 1);
	assert.equal(bounded.usedChars, maxChars);
	assert.equal(bounded.omittedNodeIds.length, 2);
	assert.equal(projectNovelCandidates(f.pkg, f.anchor, { ...f.options, maxChars: 0 }).candidates.length, 0);
	assert.deepEqual(f.pkg.nodes, buildNovelPackage(f.source, f.stages, f.nodes).nodes);
});

test("小说当前场景召回保留同阶段并行事件和原文证据，但仍标记为候选", () => {
	const f = fixture();
	const recall = projectNovelSceneRecall(f.pkg, f.anchor);
	assert.equal(recall.length, 3);
	assert.ok(recall.every(item => item.actuality === "candidate"));
	assert.ok(recall.every(item => item.quote));
});
