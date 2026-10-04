import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildNovelEvents } from "../src/novel-play/service.ts";
import { loadNovelPackage } from "../src/novel-play/store.ts";

function setup() {
	const cwd = mkdtempSync(join(tmpdir(), "novel-service-"));
	const dir = join(cwd, "skills", "小说作品构建");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "SKILL.md"), "---\nname: 小说作品构建\ndescription: fixture\n---\nExtract events.");
	const storedText = "她进入学校。";
	const document = { id: "../fixture", title: "校园", status: "ready" as const, chars: storedText.length, chunkCount: 1 };
	const raw = JSON.stringify({ nodes: [{ key: "arrive", title: "入学", summary: "她进入学校。", visibility: "public", dependsOn: [], quote: storedText }] });
	return { cwd, storedText, document, raw };
}

test("小说构建服务：读取 Skill、保存版本并从检查点复用", async () => {
	const f = setup();
	try {
		let calls = 0;
		const modelCall = async (input: { skillBody: string }) => { calls++; assert.equal(input.skillBody, "Extract events."); return f.raw; };
		const pkg = await buildNovelEvents({ ...f, modelCall });
		assert.equal(loadNovelPackage(f.cwd, f.document.id, pkg.revision).package.revision, pkg.revision);
		const again = await buildNovelEvents({ ...f, modelCall });
		assert.equal(again.revision, pkg.revision);
		assert.equal(calls, 1);
	} finally { rmSync(f.cwd, { recursive: true, force: true }); }
});

test("小说构建服务：用户 Skill 覆盖使旧检查点失效", async () => {
	const f = setup();
	try {
		let calls = 0;
		await buildNovelEvents({ ...f, modelCall: async () => { calls++; return f.raw; } });
		const dir = join(f.cwd, ".liyuan-stage-skills", "小说作品构建");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "SKILL.md"), "---\nname: 小说作品构建\ndescription: user fixture\n---\nNew rules.");
		await buildNovelEvents({ ...f, modelCall: async input => { calls++; assert.equal(input.skillBody, "New rules."); return f.raw; } });
		assert.equal(calls, 2);
	} finally { rmSync(f.cwd, { recursive: true, force: true }); }
});

test("小说构建服务：取消不调用模型，缺失 Skill 显式失败", async () => {
	const f = setup();
	try {
		const modelCall = async () => { throw new Error("must not call"); };
		await assert.rejects(buildNovelEvents({ ...f, modelCall, signal: AbortSignal.abort() }), { name: "AbortError" });
		rmSync(join(f.cwd, "skills"), { recursive: true });
		await assert.rejects(buildNovelEvents({ ...f, modelCall }), /Skill/);
	} finally { rmSync(f.cwd, { recursive: true, force: true }); }
});

test("小说构建服务：同文档并发拒绝，失败后释放锁", async () => {
	const f = setup();
	try {
		let release!: (raw: string) => void;
		const pending = new Promise<string>(resolve => { release = resolve; });
		const first = buildNovelEvents({ ...f, modelCall: async () => pending });
		await assert.rejects(buildNovelEvents({ ...f, modelCall: async () => f.raw }), /构建中/);
		release(f.raw);
		await first;
		await buildNovelEvents({ ...f, modelCall: async () => f.raw });
	} finally { rmSync(f.cwd, { recursive: true, force: true }); }
});
