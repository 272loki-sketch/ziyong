import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CorpusEngine, cleanTextLayer, corpusDigestsDir, corpusDocumentsFile, corpusTextsDir, estimateCallsForChunks, loadCorpusDocuments, type CorpusDigest, type CorpusEngineDeps } from "../src/outline/corpus.ts";

const TASKS = ["digest-map", "digest-reduce-arc", "digest-reduce-final", "digest-extract-mechanisms", "digest-extract-daily", "digest-extract-assets", "digest-audit"];
const TEXT = "人物走进房间，谈起今天的天气和一封信。\n";
const json = JSON.stringify;
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
const response = (task: string, audit = true): string => {
	if (task === "digest-map" || task === "digest-reduce-arc") return json({ summary: `${task} 摘要` });
	if (task === "digest-reduce-final") return json({ synopsis: "合成梗概", structure: { plotSpine: "主线", characterArcs: "弧线", hooksAndPacing: "节奏" } });
	if (task === "digest-extract-mechanisms") return json({ tropes: audit ? [{ mechanism: "来信制造悬念", appliesWhen: "关系建立时", failureWarning: "不要拖延回收", evidenceIds: ["chunk-1"] }] : [] });
	if (task === "digest-extract-daily") return json({ dailyPatterns: [] });
	if (task === "digest-extract-assets") return json({ assets: [] });
	return json({ results: [{ index: 0, verdict: "supported" }] });
};

function fixture(gated?: string, audit = true) {
	const cwd = mkdtempSync(join(tmpdir(), "corpus-lifecycle-"));
	mkdirSync(join(cwd, ".liyuan-uploads"), { recursive: true });
	writeFileSync(join(cwd, ".liyuan-uploads", "sample.txt"), TEXT);
	const started = deferred(), release = deferred();
	const calls: string[] = [], publications = new Set<string>(), effects: string[] = [];
	let usedGate = false, readyCalls = 0;
	const deps: CorpusEngineDeps = {
		cwd, loadSkill: () => "offline skill", cardKey: () => "synthetic-card",
		runSideModel: async (_step, _skill, user) => {
			const task = JSON.parse(user).task as string;
			calls.push(task);
			// Reservations are already on disk when the actual model attempt begins.
			const doc = loadCorpusDocuments(cwd).find(d => ["mapping", "reducing", "extracting"].includes(d.status));
			assert.ok(doc?.modelUsage && doc.modelUsage.attempts > 0);
			assert.ok(doc.modelUsage.attempts <= doc.modelUsage.limit);
			if (!usedGate && task === gated) { usedGate = true; started.resolve(); await release.promise; }
			return response(task, audit);
		},
		onReady: async doc => {
			readyCalls++;
			if (!usedGate && gated === "onReady") { usedGate = true; started.resolve(); await release.promise; }
			publications.add(doc.id); effects.push("published");
		},
		onRemoved: async id => { const n = publications.delete(id) ? 1 : 0; effects.push("removed"); return n; },
	};
	return { cwd, calls, deps, started, release, publications, effects, readyCalls: () => readyCalls, clean: () => rmSync(cwd, { recursive: true, force: true }) };
}
const digest = (cwd: string, id: string): CorpusDigest => JSON.parse(readFileSync(join(corpusDigestsDir(cwd), `${id}.json`), "utf8"));
function seed(f: ReturnType<typeof fixture>, usage?: unknown, status = "pending") {
	const id = "doc-synthetic-legacy", now = new Date().toISOString();
	mkdirSync(corpusTextsDir(f.cwd), { recursive: true });
	writeFileSync(join(corpusTextsDir(f.cwd), `${id}.txt`), cleanTextLayer(TEXT));
	writeFileSync(corpusDocumentsFile(f.cwd), json([{ id, title: "synthetic", originName: "sample.txt", sourceKind: "upload", chars: TEXT.length, chunkCount: 1, chapterCount: 0, encoding: "utf-8", cardKey: "synthetic-card", status, createdAt: now, updatedAt: now, ...(usage ? { modelUsage: usage } : {}) }]));
	return id;
}

for (const stage of [...TASKS, "onReady"]) {
	test(`全阶段暂停/恢复：${stage} 完成当前调用后停，不重跑已完成步骤或入库`, { timeout: 5000 }, async () => {
		const f = fixture(stage);
		try {
			const engine = new CorpusEngine(f.deps);
			const { doc } = await engine.create("sample.txt");
			await f.started.promise;
			engine.pause(doc.id);
			assert.equal(engine.getDoc(doc.id)?.status, "paused");
			f.release.resolve(); await engine.waitIdle();
			assert.equal(engine.getDoc(doc.id)?.status, "paused");
			assert.equal(engine.getDoc(doc.id)?.error, undefined);
			assert.equal(f.readyCalls(), stage === "onReady" ? 1 : 0);
			assert.equal(digest(f.cwd, doc.id).chunks.length, 1);
			// Restore reads the same ledger/checkpoint, not just this engine's memory.
			const restarted = new CorpusEngine(f.deps);
			restarted.restore(); await restarted.waitIdle();
			assert.equal(restarted.getDoc(doc.id)?.status, "paused");
			restarted.resume(doc.id); await restarted.waitIdle();
			assert.equal(restarted.getDoc(doc.id)?.status, "ready");
			assert.equal(f.readyCalls(), 1);
			assert.equal(f.calls.length, 7);
			for (const task of TASKS) assert.equal(f.calls.filter(call => call === task).length, 1);
			assert.equal(restarted.getDoc(doc.id)?.modelUsage?.attempts, 7);
			assert.equal(digest(f.cwd, doc.id).pipeline?.onReadyComplete, true);
		} finally { f.clean(); }
	});
}

for (const stage of TASKS) {
	test(`全阶段删除：${stage} 中取消后不重试、不入库，忽略晚到结果`, { timeout: 5000 }, async () => {
		const f = fixture(stage);
		try {
			const engine = new CorpusEngine(f.deps);
			const { doc } = await engine.create("sample.txt");
			await f.started.promise;
			const before = f.calls.length;
			// The faux provider intentionally ignores abort until released. Local
			// cancellation must still release the worker and never accept its result.
			await engine.remove(doc.id); await engine.waitIdle();
			assert.equal(engine.getDoc(doc.id), undefined);
			assert.equal(f.readyCalls(), 0);
			assert.deepEqual(f.effects, ["removed"]);
			f.release.resolve(); await new Promise(resolve => setImmediate(resolve));
			assert.equal(f.calls.length, before);
			assert.equal(existsSync(join(corpusDigestsDir(f.cwd), `${doc.id}.json`)), false);
			assert.equal(existsSync(join(corpusTextsDir(f.cwd), `${doc.id}.txt`)), false);
			assert.deepEqual(loadCorpusDocuments(f.cwd), []);
		} finally { f.release.resolve(); f.clean(); }
	});
}

test("删除 onReady 中的文档：清理必须在晚到入库之后，不留下僵尸机制", { timeout: 5000 }, async () => {
	const f = fixture("onReady");
	try {
		const engine = new CorpusEngine(f.deps), { doc } = await engine.create("sample.txt");
		await f.started.promise;
		const removing = engine.remove(doc.id);
		assert.equal(engine.getDoc(doc.id), undefined);
		assert.deepEqual(f.effects, []);
		f.release.resolve(); assert.equal(await removing, 1); await engine.waitIdle();
		assert.deepEqual(f.effects, ["published", "removed"]);
		assert.equal(f.publications.size, 0);
		assert.equal(existsSync(join(corpusDigestsDir(f.cwd), `${doc.id}.json`)), false);
	} finally { f.release.resolve(); f.clean(); }
});

test("快速 pause→resume 不丢失入队、不重复 onReady", { timeout: 5000 }, async () => {
	const f = fixture("digest-reduce-arc");
	try {
		const engine = new CorpusEngine(f.deps), { doc } = await engine.create("sample.txt");
		await f.started.promise; engine.pause(doc.id); engine.resume(doc.id); f.release.resolve(); await engine.waitIdle();
		assert.equal(engine.getDoc(doc.id)?.status, "ready"); assert.equal(f.calls.length, 7); assert.equal(f.readyCalls(), 1);
	} finally { f.release.resolve(); f.clean(); }
});

test("暂停后的模型错误不是 failed，也不启动 provider/文档重试", { timeout: 5000 }, async () => {
	const f = fixture(); let fail = true;
	const started = deferred(), release = deferred();
	f.deps.runSideModel = async (_s, _p, u) => {
		const task = JSON.parse(u).task as string; f.calls.push(task);
		if (fail) { started.resolve(); await release.promise; return { error: "faux provider failure" }; }
		return response(task);
	};
	try {
		const engine = new CorpusEngine(f.deps), { doc } = await engine.create("sample.txt");
		await started.promise; engine.pause(doc.id); release.resolve(); await engine.waitIdle();
		assert.equal(engine.getDoc(doc.id)?.status, "paused"); assert.equal(f.calls.length, 1);
		assert.equal(existsSync(join(corpusDigestsDir(f.cwd), `${doc.id}.json`)), false);
		fail = false; engine.resume(doc.id); await engine.waitIdle();
		assert.equal(engine.getDoc(doc.id)?.status, "ready"); assert.equal(engine.getDoc(doc.id)?.modelUsage?.attempts, 8);
	} finally { release.resolve(); f.clean(); }
});

test("预算 4 的上传回归：六步/可能 audit 的预估先拒绝，实际调用为 0", async () => {
	const f = fixture();
	try {
		assert.equal(estimateCallsForChunks(1, false), 6); assert.equal(estimateCallsForChunks(1), 7);
		const engine = new CorpusEngine(f.deps, 4);
		await assert.rejects(engine.create("sample.txt"), /超过上限 4/);
		assert.equal(f.calls.length, 0); assert.equal(engine.view().documents.length, 0);
	} finally { f.clean(); }
});

test("预算 4 实调硬顶：剩余 1 次时并发 extract 只准一个申请；重启/手动 retry 不重置", { timeout: 5000 }, async () => {
	const f = fixture();
	try {
		const id = seed(f, { version: 1, attempts: 0, limit: 4 });
		const engine = new CorpusEngine(f.deps, 4); engine.restore(); await engine.waitIdle();
		assert.deepEqual(f.calls, TASKS.slice(0, 4));
		assert.equal(engine.getDoc(id)?.status, "failed"); assert.equal(f.readyCalls(), 0);
		assert.deepEqual(engine.getDoc(id)?.modelUsage, { version: 1, attempts: 4, limit: 4, exhausted: true });
		assert.ok(digest(f.cwd, id).pipeline?.extractions["digest-extract-mechanisms"]);
		assert.throws(() => engine.retry(id), /提高/); assert.equal(f.calls.length, 4);
		const sameBudget = new CorpusEngine(f.deps, 4); sameBudget.restore(); await sameBudget.waitIdle();
		assert.throws(() => sameBudget.resume(id), /提高/); assert.equal(f.calls.length, 4);
		// Explicit config increase grants only the difference, not a fresh budget.
		const raised = new CorpusEngine(f.deps, 7); raised.resume(id); await raised.waitIdle();
		assert.equal(raised.getDoc(id)?.status, "ready"); assert.equal(raised.getDoc(id)?.modelUsage?.attempts, 7);
		assert.deepEqual(f.calls, TASKS); assert.equal(f.readyCalls(), 1);
	} finally { f.clean(); }
});

test("无 audit 六次实调可以恰好用完预算；有 audit 时第七次不得越界", { timeout: 5000 }, async () => {
	for (const audit of [false, true]) {
		const f = fixture(undefined, audit);
		try {
			const id = seed(f, { version: 1, attempts: 0, limit: 6 });
			const engine = new CorpusEngine(f.deps, 6); engine.restore(); await engine.waitIdle();
			assert.equal(f.calls.length, 6); assert.equal(engine.getDoc(id)?.modelUsage?.attempts, 6);
			assert.equal(engine.getDoc(id)?.status, audit ? "failed" : "ready");
			if (audit) {
				const raised = new CorpusEngine(f.deps, 7); raised.resume(id); await raised.waitIdle();
				assert.equal(raised.getDoc(id)?.status, "ready"); assert.deepEqual(f.calls, TASKS); assert.equal(f.readyCalls(), 1);
			}
		} finally { f.clean(); }
	}
});

test("真实 attempts 包含 #call provider 重试，额度耗尽不盲自动重入", { timeout: 5000 }, async () => {
	const f = fixture(); let throws = true;
	f.deps.runSideModel = async (_s, _p, u) => { const task = JSON.parse(u).task as string; f.calls.push(task); if (throws) { throws = false; throw new Error("faux transient"); } return response(task); };
	try {
		const engine = new CorpusEngine(f.deps, 7), { doc } = await engine.create("sample.txt"); await engine.waitIdle();
		assert.equal(f.calls.length, 7); assert.equal(f.calls.filter(t => t === "digest-map").length, 2);
		assert.equal(engine.getDoc(doc.id)?.status, "failed"); assert.equal(f.readyCalls(), 0);
		const raised = new CorpusEngine(f.deps, 8); raised.resume(doc.id); await raised.waitIdle();
		assert.equal(raised.getDoc(doc.id)?.status, "ready"); assert.equal(raised.getDoc(doc.id)?.modelUsage?.attempts, 8);
		assert.equal(f.calls.length, 8); assert.equal(f.calls.at(-1), "digest-audit");
	} finally { f.clean(); }
});

test("解析/文档自动重入队/手动 retry 均累计，失败 chunk 修复不重复 index", { timeout: 5000 }, async () => {
	const f = fixture(undefined, false); let invalid = true;
	f.deps.runSideModel = async (_s, _p, u) => { const task = JSON.parse(u).task as string; f.calls.push(task); return invalid ? "not json" : response(task, false); };
	try {
		const engine = new CorpusEngine(f.deps, 10), { doc } = await engine.create("sample.txt"); await engine.waitIdle();
		assert.equal(f.calls.length, 8); assert.equal(engine.getDoc(doc.id)?.status, "failed");
		engine.retry(doc.id); await engine.waitIdle();
		assert.equal(f.calls.length, 10); assert.equal(engine.getDoc(doc.id)?.modelUsage?.attempts, 10);
		assert.equal(engine.getDoc(doc.id)?.modelUsage?.exhausted, true);
		invalid = false;
		const raised = new CorpusEngine(f.deps, 16); raised.resume(doc.id); await raised.waitIdle();
		assert.equal(raised.getDoc(doc.id)?.status, "ready"); assert.equal(raised.getDoc(doc.id)?.modelUsage?.attempts, 16);
		assert.equal(digest(f.cwd, doc.id).chunks.length, 1); assert.equal(f.readyCalls(), 1);
	} finally { f.clean(); }
});

test("旧文档明确迁移 unknown；已知/未知版本账本重启不可重置", { timeout: 5000 }, async () => {
	const f = fixture();
	try {
		const id = seed(f); const engine = new CorpusEngine(f.deps, 7); engine.restore(); await engine.waitIdle();
		assert.equal(engine.getDoc(id)?.modelUsage?.legacyAttemptsUnknown, true); assert.equal(engine.getDoc(id)?.modelUsage?.attempts, 7);
		const restarted = new CorpusEngine(f.deps, 7); restarted.restore(); await restarted.waitIdle(); assert.equal(f.calls.length, 7);
	} finally { f.clean(); }
	for (const usage of [{ version: 2, attempts: 9, limit: 10 }, { version: 1, attempts: -1, limit: 10 }]) {
		const f = fixture();
		try {
			const id = seed(f, usage); const engine = new CorpusEngine(f.deps); engine.restore(); await engine.waitIdle();
			assert.equal(f.calls.length, 0); assert.equal(engine.getDoc(id)?.status, "failed"); assert.throws(() => engine.resume(id), /版本\/计数/);
			assert.equal(loadCorpusDocuments(f.cwd)[0]?.modelUsage?.attempts, usage.attempts);
		} finally { f.clean(); }
	}
});

test("追加版本不继承父文档已用预算，冻结 layout/旧块复用跨两次追加仍不额外扣额", { timeout: 5000 }, async () => {
	const f = fixture(undefined, false);
	try {
		const engine = new CorpusEngine(f.deps, 7), { doc: parent } = await engine.create("sample.txt"); await engine.waitIdle();
		const original = digest(f.cwd, parent.id).chunks[0];
		let base = parent, text = TEXT;
		for (let n = 1; n <= 2; n++) {
			text += `追加段 ${n}：新的一封信到达。\n`; writeFileSync(join(f.cwd, ".liyuan-uploads", `append-${n}.txt`), text);
			const built = await engine.createVersion(base.id, `append-${n}.txt`); await engine.waitIdle();
			assert.equal(built.reusedChunks, n); assert.equal(built.newChunks, 1); assert.equal(built.estimatedCalls, 7);
			assert.equal(engine.getDoc(built.doc.id)?.status, "ready"); assert.equal(built.doc.modelUsage?.attempts, 6);
			assert.deepEqual(digest(f.cwd, built.doc.id).chunks[0], original);
			assert.equal(digest(f.cwd, built.doc.id).layout?.length, n + 1);
			assert.equal(engine.getDoc(base.id)?.modelUsage?.attempts, 6); base = built.doc;
		}
		assert.equal(f.calls.length, 18); assert.equal(f.calls.filter(t => t === "digest-map").length, 3);
	} finally { f.clean(); }
});

test("排队文档暂停会移出 runnable 队列；恢复时不漏文档", { timeout: 5000 }, async () => {
	const f = fixture("digest-map");
	try {
		const engine = new CorpusEngine(f.deps), { doc: first } = await engine.create("sample.txt");
		await f.started.promise;
		writeFileSync(join(f.cwd, ".liyuan-uploads", "queued.txt"), TEXT);
		const { doc: queued } = await engine.create("queued.txt"); engine.pause(queued.id);
		f.release.resolve(); await engine.waitIdle();
		assert.equal(engine.getDoc(first.id)?.status, "ready"); assert.equal(engine.getDoc(queued.id)?.status, "paused");
		assert.equal(f.calls.length, 7); assert.equal(queued.modelUsage?.attempts, 0);
		engine.resume(queued.id); await engine.waitIdle();
		assert.equal(engine.getDoc(queued.id)?.status, "ready"); assert.equal(f.calls.length, 14); assert.equal(f.readyCalls(), 2);
	} finally { f.release.resolve(); f.clean(); }
});

test("onReady 失败不伪装 ready；手动 retry 只补入库，已用模型预算不变", { timeout: 5000 }, async () => {
	const f = fixture(); let invocations = 0;
	f.deps.onReady = async doc => { invocations++; if (invocations === 1) throw new Error("faux publish failure"); f.publications.add(doc.id); };
	try {
		const engine = new CorpusEngine(f.deps, 7), { doc } = await engine.create("sample.txt"); await engine.waitIdle();
		assert.equal(engine.getDoc(doc.id)?.status, "failed"); assert.match(engine.getDoc(doc.id)?.error ?? "", /研究入库失败/);
		assert.equal(doc.modelUsage?.attempts, 7); assert.equal(invocations, 1); assert.equal(f.publications.size, 0);
		engine.retry(doc.id); await engine.waitIdle();
		assert.equal(engine.getDoc(doc.id)?.status, "ready"); assert.equal(doc.modelUsage?.attempts, 7);
		assert.equal(f.calls.length, 7); assert.equal(invocations, 2); assert.equal(f.publications.size, 1);
		const restarted = new CorpusEngine(f.deps, 7); restarted.restore(); await restarted.waitIdle(); assert.equal(invocations, 2);
	} finally { f.clean(); }
});

test("pause 可唤醒 provider 重试退避，不等待下一次请求，不扣额", { timeout: 5000 }, async () => {
	const f = fixture(); const started = deferred(); let failing = true;
	f.deps.runSideModel = async (_s, _p, u) => { const task = JSON.parse(u).task as string; f.calls.push(task); if (failing) { started.resolve(); return { error: "faux retry delay" }; } return response(task); };
	try {
		const engine = new CorpusEngine(f.deps), { doc } = await engine.create("sample.txt");
		await started.promise; await new Promise(resolve => setImmediate(resolve)); engine.pause(doc.id);
		let timer: ReturnType<typeof setTimeout>;
		try { await Promise.race([engine.waitIdle(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("pause 未唤醒退避")), 200); })]); }
		finally { clearTimeout(timer!); }
		assert.equal(f.calls.length, 1); assert.equal(doc.modelUsage?.attempts, 1); assert.equal(doc.status, "paused");
		failing = false; engine.resume(doc.id); await engine.waitIdle(); assert.equal(doc.status, "ready"); assert.equal(doc.modelUsage?.attempts, 8);
	} finally { f.clean(); }
});

test("删除后同 ID 重建不会让旧 onRemoved 删除新入库结果", { timeout: 5000 }, async () => {
	const f = fixture(); const cleanupStarted = deferred(), cleanupRelease = deferred();
	f.deps.onRemoved = async id => { cleanupStarted.resolve(); await cleanupRelease.promise; const removed = f.publications.delete(id); f.effects.push("removed"); return removed ? 1 : 0; };
	try {
		const engine = new CorpusEngine(f.deps), { doc } = await engine.create("sample.txt"); await engine.waitIdle();
		const removing = engine.remove(doc.id); await cleanupStarted.promise;
		const rebuilt = await engine.create("sample.txt"); assert.equal(rebuilt.doc.id, doc.id); assert.equal(f.calls.length, 7);
		cleanupRelease.resolve(); await removing; await engine.waitIdle();
		assert.equal(rebuilt.doc.status, "ready"); assert.equal(rebuilt.doc.modelUsage?.attempts, 7);
		assert.deepEqual(f.effects, ["published", "removed", "published"]); assert.equal(f.publications.size, 1);
	} finally { cleanupRelease.resolve(); f.clean(); }
});

test("未知 pipeline checkpoint 版本先拒绝，不覆盖 checkpoint 或发模型请求", { timeout: 5000 }, async () => {
	const f = fixture();
	try {
		const id = seed(f, { version: 1, attempts: 0, limit: 7 });
		mkdirSync(corpusDigestsDir(f.cwd), { recursive: true });
		writeFileSync(join(corpusDigestsDir(f.cwd), `${id}.json`), json({ version: 1, docId: id, chunks: [], arcs: [], synopsis: "", structure: {}, extractedCount: 0, pipeline: { version: 2, inputHash: "future", extractions: {} } }));
		const engine = new CorpusEngine(f.deps, 7); engine.restore(); await engine.waitIdle();
		assert.equal(f.calls.length, 0); assert.equal(engine.getDoc(id)?.status, "failed");
		assert.match(engine.getDoc(id)?.error ?? "", /checkpoint 版本/);
		assert.equal((JSON.parse(readFileSync(join(corpusDigestsDir(f.cwd), `${id}.json`), "utf8")) as { pipeline: { version: number } }).pipeline.version, 2);
	} finally { f.clean(); }
});

test("模拟活跃任务重启：已知 attempts 原样累计，余额只有一次不能重获预算", { timeout: 5000 }, async () => {
	const f = fixture();
	try {
		const id = seed(f, { version: 1, attempts: 3, limit: 4 }, "mapping");
		const restored = new CorpusEngine(f.deps, 4); restored.restore(); await restored.waitIdle();
		assert.deepEqual(f.calls, ["digest-map"]); assert.equal(restored.getDoc(id)?.modelUsage?.attempts, 4);
		assert.equal(restored.getDoc(id)?.modelUsage?.legacyAttemptsUnknown, undefined);
		assert.equal(restored.getDoc(id)?.status, "failed"); assert.equal(digest(f.cwd, id).chunks.length, 1);
		const again = new CorpusEngine(f.deps, 4); again.restore(); await again.waitIdle(); assert.equal(f.calls.length, 1);
	} finally { f.clean(); }
});
