import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { OutlineEngine } from "../src/outline/engine.ts";
import { loadStageMaterials } from "../src/stage/materials.ts";

class FauxSession {
	entries: Array<{ id: string; type: string; customType?: string; data?: unknown }> = [{ id: "leaf", type: "custom", customType: "seed", data: {} }];
	getBranch() { return this.entries; }
	getLeafId() { return "leaf"; }
	getSessionId() { return "session"; }
	appendCustomEntry(customType: string, data?: unknown) { const id = `e${this.entries.length}`; this.entries.push({ id, type: "custom", customType, data }); return id; }
	flush() {}
}

test("研究子agent 串联 outlineCorpusResearch → outlineChat 全链路", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "research-chat-"));
	try {
		const corpusDir = join(cwd, ".liyuan", "outline", "research", "corpus");
		mkdirSync(corpusDir, { recursive: true });
		const digestsDir = join(corpusDir, "digests");
		mkdirSync(digestsDir, { recursive: true });
		const cardKey = "test-card";

		writeFileSync(join(corpusDir, "documents.json"), JSON.stringify([{
			id: "doc-abc", title: "校园慢热小说", sourceKind: "upload" as const, originName: "school.txt",
			chars: 50000, encoding: "utf-8", chapterCount: 10, chunkCount: 5, status: "ready",
			cardKey, synopsisPreview: "一对高中生从误解到互信的慢热关系。",
			tropeCount: 2, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
		}], null, 2));

		writeFileSync(join(digestsDir, "doc-abc.json"), JSON.stringify({
			version: 1, docId: "doc-abc", chunks: [], arcs: [],
			synopsis: "慢热校园关系", structure: { plotSpine: "", characterArcs: "", hooksAndPacing: "" },
			extractedCount: 2, dailyPatterns: [], assets: [],
			updatedAt: "2026-01-01T00:00:00Z",
		}, null, 2));

		const cardsDir = join(cwd, ".liyuan", "outline", "research", "cards");
		mkdirSync(cardsDir, { recursive: true });
		const safeKey = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 24);
		writeFileSync(join(cardsDir, `${safeKey(cardKey)}.json`), JSON.stringify({
			version: 1, cardKey, mechanismIds: ["mech-001", "mech-002"], updatedAt: "2026-01-01T00:00:00Z"
		}, null, 2));

		writeFileSync(join(cwd, ".liyuan", "outline", "research", "mechanisms.json"), JSON.stringify([
			{ id: "mech-001", sourceIds: ["doc-abc"], mechanism: "慢热关系：用日常小事积累信任", appliesWhen: "关系初期、互信不足时", failureWarning: "小事堆积过多没有质变会拖沓" },
			{ id: "mech-002", sourceIds: ["doc-abc"], mechanism: "身份错位喜剧：用信息差制造自然误会", appliesWhen: "双方认知不对称时", failureWarning: "信息差持续太久会变拖戏" },
		], null, 2));

		const steps: string[] = [];
		let corpusUserText = "";

		const sm = new FauxSession();
		const engine = new OutlineEngine({
			cwd,
			getSessionManager: () => sm,
			loadMaterials: () => loadStageMaterials(new URL("..", import.meta.url).pathname),
			runSideModel: async (step, _system, userText) => {
				steps.push(step);
				if (step === "outlineCorpusResearch") {
					corpusUserText = userText;
					return JSON.stringify({ selections: [{ id: "mech-001", reason: "关系初期慢热适用", useWhen: "日常场景", caution: "避免拖沓" }] });
				}
				if (step === "outlineChat") {
					return JSON.stringify({ answer: "建议用日常小事自然推进", sceneAdvice: { recommendedBeat: "放学后偶遇", openingMove: "留下做作业", playerObjective: "比对方晚走", naturalReason: "作业写不完", intendedConsequence: "紧张感慢慢化开", alternatives: [], mixedRoute: "" } });
				}
				return "{}";
			},
			getContext: () => ({ cardKey }),
		});

		const result = await engine.chat("关系一直僵着怎么办", { focus: "next-beat" });

		// 调用顺序
		assert.deepStrictEqual(steps, ["outlineCorpusResearch", "outlineChat"]);

		// 子 agent 拿到了完整索引
		const index = JSON.parse(corpusUserText);
		assert.equal(index.task, "outline-corpus-research");
		assert.equal(index.researchIndex.documents.length, 1);
		assert.equal(index.researchIndex.documents[0].id, "doc-abc");
		assert.equal(index.researchIndex.items.length, 2);
		assert.equal(index.researchIndex.items[0].id, "mech-001");

		// 主导演产出正常
		assert.ok(result.sceneAdvice);
		assert.ok(result.sceneAdvice.playerObjective);
		assert.equal(result.reply.includes("日常"), true);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});
