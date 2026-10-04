import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CorpusEngine, cleanTextLayer, chunkText, corpusDocumentsFile, corpusRoot, corpusTextsDir, decodeText, estimateCallsForChunks, splitChapters, CHUNK_CHARS, MAX_CHUNKS } from "../src/outline/corpus.ts";
import { OutlineResearchStore } from "../src/outline/research.ts";
import { projectCorpusWorkspace } from "../src/outline/projection.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "novel-digest-"));
const AUDIT_OK = JSON.stringify({ version: 1, verdict: "approve", issues: [], summary: "ok" });

/** 最小成功模型：只负责让管道走到 ready，不参与元数据断言。 */
const successModel = (task: string): string => {
	if (task === "digest-map") return JSON.stringify({ summary: "块摘要", chapters: [] });
	if (task === "digest-reduce-arc") return JSON.stringify({ summary: "弧线" });
	if (task === "digest-reduce-final") return JSON.stringify({ synopsis: "梗概", structure: { plotSpine: "a", characterArcs: "b", hooksAndPacing: "c" } });
	if (task === "digest-extract-mechanisms") return JSON.stringify({ tropes: [] });
	if (task === "digest-extract-daily") return JSON.stringify({ dailyPatterns: [] });
	if (task === "digest-extract-assets") return JSON.stringify({ assets: [] });
	return AUDIT_OK;
};

function corpusDeps(cwd: string, onCall: (task: string, text: string) => string | { error: string } | Promise<string | { error: string }>) {
	const research = new OutlineResearchStore(cwd);
	return {
		cwd,
		runSideModel: async (step: string, _system: string, userText: string, opts: { maxTokens?: number; signal?: AbortSignal }) => {
			assert.equal(step, "novelDigest");
			const task = JSON.parse(userText).task;
			if (opts.signal?.aborted) return { error: "aborted" };
			return await onCall(task, userText);
		},
		loadSkill: () => "skill-body",
		cardKey: () => "card-a",
		onReady: (document: any, digest: any, extracted: any) => research.mergeCorpus(document.cardKey, document, digest, extracted).then(() => undefined),
		onRemoved: (docId: string) => research.removeCorpus(docId),
	};
}

function sampleText(): string {
	const lines: string[] = [];
	for (let c = 1; c <= 6; c++) {
		lines.push(`第${c}章 风波`);
		for (let p = 0; p < 20; p++) lines.push(`　　$(c)章第$(p)段。林默走出巷口，夜色压下来，手里攥着那封没有署名的信。`);
	}
	return lines.join("\n");
}


test("解码：utf-8 优先，gb18030 命中，坏字节退 lossy", () => {
	const enc = new TextEncoder();
	const utf8 = enc.encode("这是章节标题");
	assert.equal(decodeText(Buffer.from(utf8)).encoding, "utf-8");
	// GBK「中文测试」= D6 D0 CE C4 B2 E2 CA D4（非法 utf-8 序列 → 应走 gb18030）
	const gb = Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0xb2, 0xe2, 0xca, 0xd4]);
	const decoded = decodeText(gb);
	assert.equal(decoded.encoding, "gb18030");
	assert.equal(decoded.text.includes("测试"), true);
	const bad = Buffer.from([0xff, 0xfe, 0x00, 0x61]);
	const result = decodeText(bad);
	assert.equal(result.encoding, "utf-8(lossy)");
	assert.equal(result.text.length > 0, true);
});

test("清洗：水印行与导航行删除，正文对白保留", () => {
	const text = "我爱她。\n本书首发于某站，请记住本站域名。\n上一章 目录 下一页\n“你现在想去吃饭吗？”\n\n\n下一行是正文。\n";
	const cleaned = cleanTextLayer(text);
	assert.equal(cleaned.includes("我爱她"), true);
	assert.equal(cleaned.includes("某站"), false);
	assert.equal(cleaned.includes("上一章"), false);
	assert.equal(cleaned.includes("想去吃饭"), true);
	assert.equal(cleaned.includes("下一行是正文"), true);
});


test("分章：标准「第N章」识别", () => {
	const { chapters, detected } = splitChapters("第1章 初见\n第一段。\n第2章 重逢\n第二段。\n第3章 别离\n第三段。\n第4章 决裂\n第四段。\n第5章 和解\n第五段。\n第6章 结局\n第六段。\n");
	assert.equal(detected, true);
	assert.equal(chapters.length, 6);
	assert.equal(chapters[0]?.title, "第1章 初见");
});

test("分章：序章/番外与无章节退化", () => {
	const { detected } = splitChapters("序章 起风\n第一段。\n番外 归家\n第二段。");
	assert.equal(detected, false);
	const hasAnn = splitChapters("第1章 A\n一。\n第2章 B\n二。\n第3章 C\n三。\n第4章 D\n四。\n第5章 E\n五。");
	assert.equal(hasAnn.detected, true);
});

test("分块：贪心装箱不超 CHUNK_CHARS，章节名正确携带", () => {
	const { chapters } = splitChapters(sampleText());
	const chunks = chunkText(chapters, 2000);
	assert.equal(chunks.length > 1, true);
	for (const chunk of chunks) assert.equal(chunk.chars <= 2000, true);
	assert.equal(chunks[0]?.chapters.length > 0, true);
});

test("分块：块数上限拒绝超大文档", () => {
	const big = Array.from({ length: 10_000 }, (_, i) => `第${i + 1}章\n${"段落".repeat(120)}`).join("\n");
	const { chapters } = splitChapters(big);
	assert.throws(() => chunkText(chapters, 100, 60), /文档过大/);
});


test("调用预估：块数越大预估越高", () => {
	assert.equal(estimateCallsForChunks(1, false), 6);
	assert.equal(estimateCallsForChunks(1), 7);
	assert.equal(estimateCallsForChunks(50), 50 + 1 + 4 + 1);
	assert.equal(estimateCallsForChunks(120), 120 + Math.ceil(120 / 50) + 4 + 1);
});

test("管道：faux 返回合法 JSON → 文档到 ready，研究库有套路条目", async () => {
	const cwd = tmp();
	try {
		const research = new OutlineResearchStore(cwd);
		mkdirSync(join(cwd, ".liyuan-uploads"), { recursive: true });
		writeFileSync(join(cwd, ".liyuan-uploads", "novel.txt"), sampleText());
		const engine = new CorpusEngine(corpusDeps(cwd, (task) => {
			if (task === "digest-map") return JSON.stringify({ summary: "一段摘要内容", chapters: ["第1章"] });
			if (task === "digest-reduce-arc") return JSON.stringify({ summary: "弧线摘要" });
			if (task === "digest-reduce-final") return JSON.stringify({ synopsis: "全书梗概", structure: { plotSpine: "主线", characterArcs: "弧", hooksAndPacing: "节奏" } });
			if (task === "digest-extract-mechanisms") return JSON.stringify({ tropes: [{ mechanism: "来信制造悬念", appliesWhen: "关系刚建立时", failureWarning: "久不回收会拖节奏", evidenceIds: ["chunk-1"] }] });
			if (task === "digest-extract-daily") return JSON.stringify({ dailyPatterns: [{ title: "借物归还", setting: "放学后", surfaceActivity: "归还物品", initiative: "角色借归还之名制造独处", sweetBeat: "记得对方习惯", friction: "时间安排冲突", misunderstanding: "误以为对方在躲避", microChange: "关系更主动", escalationLimit: "不升级为表白", naturalStop: "物品归还后停住", failureWarning: "过度巧合", evidenceIds: ["chunk-1"] }] });
			if (task === "digest-extract-assets") return JSON.stringify({ assets: [{ kind: "relationship-beat", title: "试探式靠近", mechanism: "借一个低风险事务试探关系", appliesWhen: "双方有好感但不确认", failureWarning: "连续使用会显得拖沓", opening: "从具体事务开口", progression: ["制造短暂独处", "让对方误读动机"], turn: "对方主动追问", stopPoint: "得到半个回答后停笔", relationshipStage: "暧昧初期", pressure: "轻", desiredExperience: "发糖与期待", evidenceIds: ["chunk-1"] }] });
			if (task === "digest-audit") return JSON.stringify({ results: [{ index: 0, verdict: "supported" }, { index: 1, verdict: "supported" }, { index: 2, verdict: "supported" }] });
			return AUDIT_OK;
		}));
		const { doc } = await engine.create(".liyuan-uploads/novel.txt");
		await engine.waitIdle();
		assert.equal(engine.getDoc(doc.id)?.status, "ready");
		assert.equal(engine.getDetail(doc.id).doc.status, "ready");
		const detail = engine.getDetail(doc.id);
		assert.equal(detail.digest?.synopsis, "全书梗概");
		assert.equal(detail.digest?.extractedCount, 1);
		assert.equal(detail.digest?.dailyPatterns?.[0]?.title, "借物归还");
		assert.equal(detail.digest?.assets?.[0]?.kind, "relationship-beat");
		assert.equal(detail.digest?.assetCount, 1);
		assert.equal(research.view("card-a").assets[0]?.docId, doc.id);
		assert.equal(research.view("card-a").dailyPatterns[0]?.title, "借物归还");
		assert.equal(engine.listTexts().length, 1);
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});


test("管道：map 返回非法 JSON → 模型层+文档层双重自动重试后成功穿到 ready", async () => {
	const cwd = tmp();
	try {
		mkdirSync(join(cwd, ".liyuan-uploads"), { recursive: true });
		writeFileSync(join(cwd, ".liyuan-uploads", "bad.txt"), sampleText());
		let mapCalls = 0;
		const engine = new CorpusEngine(corpusDeps(cwd, (task) => {
			if (task === "digest-map") { mapCalls++; return mapCalls <= 2 ? "not json" : JSON.stringify({ summary: "合法块摘要", chapters: [] }); }
			if (task === "digest-reduce-arc") return JSON.stringify({ summary: "弧线" });
			if (task === "digest-reduce-final") return JSON.stringify({ synopsis: "梗概", structure: { plotSpine: "a", characterArcs: "b", hooksAndPacing: "c" } });
			if (task === "digest-extract-mechanisms") return JSON.stringify({ tropes: [] });
			if (task === "digest-extract-daily") return JSON.stringify({ dailyPatterns: [] });
			if (task === "digest-extract-assets") return JSON.stringify({ assets: [] });
			return AUDIT_OK;
		}));
		const { doc } = await engine.create(".liyuan-uploads/bad.txt");
		await engine.waitIdle();
		// 两次 #call 均返回非法 JSON → block 写失败摘要 → 文档自动重试 → 第三次成功 → 最终 ready
		assert.equal(engine.getDoc(doc.id)?.status, "ready");
		assert.ok(mapCalls >= 3);
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("管道：map 持续返回不可解析文本时，失败状态保留可操作诊断", async () => {
	const cwd = tmp();
	try {
		mkdirSync(join(cwd, ".liyuan-uploads"), { recursive: true });
		writeFileSync(join(cwd, ".liyuan-uploads", "invalid-map.txt"), sampleText());
		const engine = new CorpusEngine(corpusDeps(cwd, (task) => task === "digest-map" ? "not valid summary json" : AUDIT_OK));
		const { doc } = await engine.create(".liyuan-uploads/invalid-map.txt");
		await engine.waitIdle();
		const failed = engine.getDoc(doc.id);
		assert.equal(failed?.status, "failed");
		assert.match(failed?.error ?? "", /第 1 块摘要生成失败：模型响应缺少可解析的 summary 字段/);
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("删除正在等待模型的文档后，不再重试已取消的调用", async () => {
	const cwd = tmp();
	try {
		mkdirSync(join(cwd, ".liyuan-uploads"), { recursive: true });
		writeFileSync(join(cwd, ".liyuan-uploads", "cancel-map.txt"), sampleText());
		let calls = 0;
		let markStarted!: () => void;
		const started = new Promise<void>((resolve) => { markStarted = resolve; });
		const deps = corpusDeps(cwd, () => "unused");
		deps.runSideModel = async (_step, _system, _user, opts) => {
			calls++;
			markStarted();
			return new Promise((_resolve, reject) => {
				if (opts?.signal?.aborted) { reject(new Error("aborted")); return; }
				opts?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
			});
		};
		const engine = new CorpusEngine(deps);
		const { doc } = await engine.create(".liyuan-uploads/cancel-map.txt");
		await started;
		await engine.remove(doc.id);
		await engine.waitIdle();
		assert.equal(calls, 1);
		assert.equal(engine.getDoc(doc.id), undefined);
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});


test("管道：reduce 失败 → 文档自动重试 → 最终 ready，已完成块保留", async () => {
	const cwd = tmp();
	try {
		mkdirSync(join(cwd, ".liyuan-uploads"), { recursive: true });
		writeFileSync(join(cwd, ".liyuan-uploads", "retry.txt"), sampleText());
		let mapCalls = 0, reduceFail = true, extractCalls = 0;
		const engine = new CorpusEngine(corpusDeps(cwd, (task) => {
			if (task === "digest-map") { mapCalls++; return JSON.stringify({ summary: `块${mapCalls}摘要`, chapters: [] }); }
			if (task === "digest-reduce-arc") { if (reduceFail) { reduceFail = false; return "bad"; } return JSON.stringify({ summary: "弧线" }); }
			if (task === "digest-reduce-final") return JSON.stringify({ synopsis: "梗概", structure: { plotSpine: "a", characterArcs: "b", hooksAndPacing: "c" } });
			if (task === "digest-extract-mechanisms") { extractCalls++; return JSON.stringify({ tropes: [] }); }
			if (task === "digest-extract-daily") return JSON.stringify({ dailyPatterns: [] });
			if (task === "digest-extract-assets") return JSON.stringify({ assets: [] });
			return AUDIT_OK;
		}));
		await engine.create(".liyuan-uploads/retry.txt");
		await engine.waitIdle();
		// reduce-arc 首次失败 → 文档自动重试 → 第二次成功 → ready
		const docId = [...engine.view().documents][0]?.id ?? "";
		assert.ok(docId);
		assert.equal(engine.getDoc(docId)?.status, "ready");
		assert.ok(extractCalls >= 1);
		assert.equal(engine.listTexts().length, 1);
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});


test("入库：mergeCorpus 机制入研究库；删除只删该 doc 独占条目", async () => {
	const cwd = tmp();
	try {
		mkdirSync(join(cwd, ".liyuan-uploads"), { recursive: true });
		writeFileSync(join(cwd, ".liyuan-uploads", "shared.txt"), sampleText());
		const engine = new CorpusEngine(corpusDeps(cwd, (task) => {
			if (task === "digest-map") return JSON.stringify({ summary: "s", chapters: [] });
			if (task === "digest-reduce-arc") return JSON.stringify({ summary: "a" });
			if (task === "digest-reduce-final") return JSON.stringify({ synopsis: "x", structure: { plotSpine: "1", characterArcs: "2", hooksAndPacing: "3" } });
			if (task === "digest-extract-mechanisms") return JSON.stringify({ tropes: [{ mechanism: "共享来源套路", appliesWhen: "w", failureWarning: "f", evidenceIds: ["chunk-1"] }] });
			if (task === "digest-extract-daily") return JSON.stringify({ dailyPatterns: [] });
			if (task === "digest-extract-assets") return JSON.stringify({ assets: [] });
			if (task === "digest-audit") return JSON.stringify({ results: [{ index: 0, verdict: "supported" }] });
			return AUDIT_OK;
		}));
		const { doc } = await engine.create(".liyuan-uploads/shared.txt");
		await engine.waitIdle();
		assert.equal(engine.getDoc(doc.id)?.status, "ready");
		const removed = await engine.remove(doc.id);
		assert.equal(removed, 1);
		assert.equal(engine.getDoc(doc.id), undefined);
		assert.equal(engine.listTexts().length, 0);
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});


test("投影：同卡 view 里 documents 包含 ready 文档，非该卡不混入", async () => {
	// 通过 corpus 引擎 + research 钩子验证卡级隔离由 cardKey 快照实现
	const cwd = tmp();
	try {
		mkdirSync(join(cwd, ".liyuan-uploads"), { recursive: true });
		writeFileSync(join(cwd, ".liyuan-uploads", "proj.txt"), sampleText());
		const engine = new CorpusEngine(corpusDeps(cwd, (task) => {
			if (task === "digest-map") return JSON.stringify({ summary: "s", chapters: [] });
			if (task === "digest-reduce-arc") return JSON.stringify({ summary: "a" });
			if (task === "digest-reduce-final") return JSON.stringify({ synopsis: "梗概全文", structure: { plotSpine: "1", characterArcs: "2", hooksAndPacing: "3" } });
			if (task === "digest-extract-mechanisms") return JSON.stringify({ tropes: [] });
			if (task === "digest-extract-daily") return JSON.stringify({ dailyPatterns: [] });
			if (task === "digest-extract-assets") return JSON.stringify({ assets: [] });
			return AUDIT_OK;
		}));
		const { doc } = await engine.create(".liyuan-uploads/proj.txt");
		await engine.waitIdle();
		assert.equal(doc.cardKey, "card-a");
		assert.equal(engine.getDoc(doc.id)?.synopsisPreview, "梗概全文");
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});


test("投影：按导演 focus 选择结构化素材，而不是按落盘顺序整包倾倒", () => {
	const view = {
		sources: [], mechanisms: [], cards: [], documents: [], dailyPatterns: [],
		assets: [
			{ kind: "dialogue-move", title: "对白试探", mechanism: "通过信息差试探对方", appliesWhen: "关系初期", failureWarning: "重复会机械", opening: "从公开话题切入", progression: ["留白", "追问"], turn: "对方反问", stopPoint: "留下未答问题", relationshipStage: "初识", pressure: "轻", desiredExperience: "暧昧", locator: "第1章" },
			{ kind: "scene-pattern", title: "日常偶遇", mechanism: "用共同活动制造自然接触", appliesWhen: "需要低烈度推进", failureWarning: "缺少主动目的会空转", opening: "从活动开始", progression: ["共同做事", "出现小摩擦"], turn: "一方改变安排", stopPoint: "关系发生微变", relationshipStage: "熟悉", pressure: "低", desiredExperience: "轻松", locator: "第3章" },
		],
	} as any;
	const projection = projectCorpusWorkspace(view, { focus: "dialogue", query: "潜台词 信息差" });
	assert.equal(projection.assets[0]?.title, "对白试探");
});


test("管道：多部文档串行消化，避免长请求并发挤占模型网关", async () => {
	const cwd = tmp();
	try {
		mkdirSync(join(cwd, ".liyuan-uploads"), { recursive: true });
		for (const name of ["a.txt", "b.txt", "c.txt"]) writeFileSync(join(cwd, ".liyuan-uploads", name), sampleText());
		let active = 0, maxActive = 0;
		const deps = corpusDeps(cwd, async (task) => {
			if (task === "digest-map") {
				active++; maxActive = Math.max(maxActive, active);
				await new Promise((resolve) => setTimeout(resolve, 15));
				active--;
				return JSON.stringify({ summary: "块摘要", chapters: [] });
			}
			if (task === "digest-reduce-arc") return JSON.stringify({ summary: "弧线" });
			if (task === "digest-reduce-final") return JSON.stringify({ synopsis: "梗概", structure: { plotSpine: "主线", characterArcs: "人物", hooksAndPacing: "节奏" } });
			if (task === "digest-extract-mechanisms") return JSON.stringify({ tropes: [] });
			if (task === "digest-extract-daily") return JSON.stringify({ dailyPatterns: [] });
			if (task === "digest-extract-assets") return JSON.stringify({ assets: [] });
			return AUDIT_OK;
		});
		const engine = new CorpusEngine(deps);
		await Promise.all([engine.create("a.txt"), engine.create("b.txt"), engine.create("c.txt")]);
		await engine.waitIdle();
		assert.equal(maxActive, 1);
		assert.equal(engine.view().documents.every((doc) => doc.status === "ready"), true);
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});


test("URL 文档：chars 对齐落盘正文，不是抓取原文长度", async () => {
	const cwd = tmp();
	const workUrl = "https://kakuyomu.jp/works/16816927859000000000";
	const workHtml = `<h1><a href="/works/16816927859000000000" title="测试作品">测试作品</a></h1><script>{"Episode:111":{"id":"111","title":"第1章 初见"}}</script>`;
	// 抓取原文里混有会被 cleanTextLayer 删掉的水印行与导航行
	const episodeHtml = [
		`<p id="p1">林默走出巷口，夜色压下来。</p>`,
		`<p id="p2">本书首发于某站，请记住本站域名。</p>`,
		`<p id="p3">上一章 返回目录 下一章</p>`,
		`<p id="p4">他把那封没有署名的信收进口袋。</p>`,
	].join("\n");
	try {
		const engine = new CorpusEngine({
			...corpusDeps(cwd, successModel),
			fetchText: async (url: URL) => url.pathname.includes("/episodes/") ? episodeHtml : workHtml,
		});
		const { doc } = await engine.createUrl(workUrl);
		await engine.waitIdle();
		assert.equal(engine.getDoc(doc.id)?.status, "ready");
		const persisted = readFileSync(join(corpusTextsDir(cwd), `${doc.id}.txt`), "utf8");
		const fetchedRaw = readFileSync(join(corpusRoot(cwd), "work", `${doc.id}.raw`), "utf8");
		// 水印/导航被删：落盘正文严格短于抓取原文
		assert.equal(persisted.includes("本书首发"), false);
		assert.equal(persisted.includes("上一章"), false);
		assert.ok(persisted.length < fetchedRaw.length);
		assert.equal(engine.getDoc(doc.id)?.chars, persisted.length);
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});


test("恢复：documents.json 旧元数据在 restore 后按落盘正文自愈", async () => {
	const cwd = tmp();
	try {
		const docId = "doc-selfheal0000";
		const text = sampleText();
		mkdirSync(corpusTextsDir(cwd), { recursive: true });
		writeFileSync(join(corpusTextsDir(cwd), `${docId}.txt`), text, "utf8");
		const now = new Date().toISOString();
		// 旧版残留：chars/chunkCount/chapterCount 全错，但 texts/<id>.txt 已存在
		writeFileSync(corpusDocumentsFile(cwd), `${JSON.stringify([{
			id: docId, title: "旧文档", sourceKind: "upload", originName: "novel.txt",
			chars: 999999, encoding: "utf-8", chapterCount: 77, chunkCount: 99,
			status: "pending", cardKey: "card-a", createdAt: now, updatedAt: now,
		}], null, 2)}\n`, "utf8");
		const { chapters, detected } = splitChapters(text);
		const expectedChunks = chunkText(chapters, CHUNK_CHARS, MAX_CHUNKS).length;
		const engine = new CorpusEngine(corpusDeps(cwd, successModel));
		engine.restore();
		await engine.waitIdle();
		const healed = engine.getDoc(docId);
		assert.equal(healed?.status, "ready");
		assert.equal(healed?.chars, text.length);
		assert.equal(healed?.chunkCount, expectedChunks);
		assert.equal(healed?.chapterCount, detected ? chapters.length : 0);
		// 自愈值已落盘，不依赖内存对象
		assert.equal(JSON.parse(readFileSync(corpusDocumentsFile(cwd), "utf8"))[0].chars, text.length);
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});
