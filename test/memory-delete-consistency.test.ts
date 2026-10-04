import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { memoryScopeRoot } from "../src/memory/config.ts";
import {
	getMemoryStatus,
	memoryClearStore,
	memoryDeleteChunk,
	memoryImportText,
	memoryManualAdd,
	memoryRemoveStore,
	updateMemoryConfig,
} from "../src/memory/service.ts";
import { loadChunks } from "../src/memory/store.ts";

const scope = { sessionId: "delete-race", card: "cards/offline.png" };
const nextLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

/** 全程 fake fetch：在 embedding 已读旧快照后暂停，不启动网络或真实模型调用。 */
function delayedEmbedding(t: TestContext, cwd: string) {
	let entered!: () => void;
	let release!: () => void;
	const started = new Promise<void>((resolve) => { entered = resolve; });
	const barrier = new Promise<void>((resolve) => { release = resolve; });
	let calls = 0;
	t.mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
		assert.equal(String(url), "https://memory-test.invalid/v1/embeddings");
		calls++;
		const body = JSON.parse(String(init?.body)) as { input: string | string[] };
		entered();
		await barrier;
		const inputs = Array.isArray(body.input) ? body.input : [body.input];
		return new Response(JSON.stringify({
			data: inputs.map((_, index) => ({ index, embedding: [1, 0, 0] })),
		}), { status: 200 });
	});
	updateMemoryConfig(cwd, {
		enabled: true,
		embedMode: "cloud",
		cloudEmbed: { baseUrl: "https://memory-test.invalid/v1", apiKey: "offline-test-only", model: "offline-vector" },
	});
	return { started, release, calls: () => calls };
}

test("memory: 延迟 embedding 写入 vs 删除，删除结算后旧条目不复活", { timeout: 5000 }, async (t) => {
	const cwd = mkdtempSync(join(tmpdir(), "liyuan-memory-delete-race-"));
	const pending: Promise<unknown>[] = [];
	let gate: ReturnType<typeof delayedEmbedding> | undefined;
	try {
		updateMemoryConfig(cwd, { enabled: true, embedMode: "local" });
		await memoryManualAdd(cwd, scope, "待删除的旧条目：旧快照不能在后续写入时把它复活。");
		const oldId = loadChunks(cwd, scope, "external")[0]!.id;
		gate = delayedEmbedding(t, cwd);
		const write = memoryImportText(cwd, scope, "external", "在途新条目：embedding 被测试屏障暂时阻塞。", "new.txt");
		pending.push(write);
		await gate.started;
		let settled = false;
		const deletion = memoryDeleteChunk(cwd, scope, "external", oldId).then((ok) => { settled = true; return ok; });
		pending.push(deletion);
		await nextLoop();
		assert.equal(settled, false, "在途写入未完成时不得提前回报删除成功");
		gate.release();
		await write;
		assert.equal(await deletion, true);
		const after = loadChunks(cwd, scope, "external");
		assert.equal(after.some((chunk) => chunk.id === oldId), false);
		assert.ok(after.some((chunk) => chunk.text.includes("在途新条目")), "删除只移除目标条目");
	} finally {
		gate?.release();
		await Promise.allSettled(pending);
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("memory: 延迟 embedding 写入 vs 清空，清空结算后旧快照和在途条目均不存在", { timeout: 5000 }, async (t) => {
	const cwd = mkdtempSync(join(tmpdir(), "liyuan-memory-clear-race-"));
	const pending: Promise<unknown>[] = [];
	let gate: ReturnType<typeof delayedEmbedding> | undefined;
	try {
		updateMemoryConfig(cwd, { enabled: true, embedMode: "local" });
		await memoryManualAdd(cwd, scope, "清空前的旧条目：必须连同此前的在途写入一起清除。");
		const otherScope = { ...scope, sessionId: "other-scope" };
		await memoryManualAdd(cwd, otherScope, "其他会话的条目：当前作用域清空不能影响它。");
		gate = delayedEmbedding(t, cwd);
		const write = memoryImportText(cwd, scope, "external", "清空前开始的新条目：embedding 尚未结束。", "new.txt");
		pending.push(write);
		await gate.started;
		let settled = false;
		const clear = memoryClearStore(cwd, scope, "external").then(() => { settled = true; });
		pending.push(clear);
		await nextLoop();
		assert.equal(settled, false, "清空回执必须等待持锁写入完成");
		gate.release();
		await write;
		await clear;
		assert.deepEqual(loadChunks(cwd, scope, "external"), []);
		assert.equal(loadChunks(cwd, otherScope, "external").length, 1);
	} finally {
		gate?.release();
		await Promise.allSettled(pending);
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("memory: 延迟 embedding 写入 vs 删库，数据/配置/旧JSONL移除且排队导入不重建", { timeout: 5000 }, async (t) => {
	const cwd = mkdtempSync(join(tmpdir(), "liyuan-memory-remove-race-"));
	const pending: Promise<unknown>[] = [];
	let gate: ReturnType<typeof delayedEmbedding> | undefined;
	const storeId = "offline_custom";
	try {
		updateMemoryConfig(cwd, {
			enabled: true, embedMode: "local",
			stores: [{ id: storeId, name: "离线自定义库", kind: "custom", enabled: true, everyNTurns: 0, maxChunks: 100 }],
		});
		// 临时旧格式数据首访迁入 SQLite，删库也必须清理旧目录以免启动后重新迁入。
		const legacyDir = join(memoryScopeRoot(cwd, scope), "stores", storeId);
		mkdirSync(legacyDir, { recursive: true });
		writeFileSync(join(legacyDir, "chunks.jsonl"), JSON.stringify({
			id: "legacy-offline", text: "旧格式自定义库条目：本测试仅使用临时数据。", embedding: [1, 0],
			meta: { source: "import", embedMode: "local", embedModel: "local-hash-v1" }, createdAt: "2026-01-01T00:00:00.000Z",
		}) + "\n");
		assert.equal(loadChunks(cwd, scope, storeId).length, 1, "旧JSONL可正常迁入");
		gate = delayedEmbedding(t, cwd);
		const write = memoryImportText(cwd, scope, storeId, "删库前开始的导入：先读取旧快照再暂停embedding。", "before-remove.txt");
		pending.push(write);
		await gate.started;
		let settled = false;
		const removal = memoryRemoveStore(cwd, scope, storeId).then((cfg) => { settled = true; return cfg; });
		pending.push(removal);
		// 此请求在删除之后排队；不能沿用入队时的旧配置重建已删除的自定义库。
		const queued = memoryImportText(cwd, scope, storeId, "删库之后排队的导入：必须重读配置并拒绝重建。", "after-remove.txt");
		pending.push(queued);
		await nextLoop();
		assert.equal(settled, false, "删库成功回执不能早于在途写入结算");
		gate.release();
		await write;
		const cfg = await removal;
		assert.equal(cfg.stores.some((store) => store.id === storeId), false);
		assert.deepEqual(await queued, { added: 0, total: 0, chunks: 0 });
		assert.equal(gate.calls(), 1, "排队导入不得再调用embedding或写库");
		assert.deepEqual(loadChunks(cwd, scope, storeId), []);
		assert.equal(existsSync(legacyDir), false);
		assert.equal(getMemoryStatus(cwd, scope).config.stores.some((store) => store.id === storeId), false);
		await assert.rejects(memoryManualAdd(cwd, scope, "手动添加也不能重建已删除的自定义库。", { storeId }), /库未启用/);
	} finally {
		gate?.release();
		await Promise.allSettled(pending);
		rmSync(cwd, { recursive: true, force: true });
	}
});
