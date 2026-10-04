import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildCurtainRerollMaterials } from "../src/stage/curtain-materials.ts";
import { buildEcologyCardPrompt, loadEcologyPools } from "../src/stage/literary-ecology.ts";
import { loadStageMaterials } from "../src/stage/materials.ts";
import { defaultState } from "../src/state.ts";

function withLargeCard(run: (cwd: string) => void): void {
	const cwd = mkdtempSync(join(tmpdir(), "liyuan-prompt-budget-"));
	try {
		writeFileSync(join(cwd, "card.json"), JSON.stringify({ data: {
			name: "预算测试角色",
			description: "巨型角色卡".repeat(200_000),
			character_book: { entries: [{ id: 1, name: "场景格式", keys: ["场景"], content: "<options>1. 继续</options>", enabled: true }] },
		} }));
		writeFileSync(join(cwd, "liyuan.config.json"), JSON.stringify({ card: "card.json" }));
		run(cwd);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
}

test("模型调用预算：巨型卡生态适配不再重复发送完整 card.book", () => {
	withLargeCard((cwd) => {
		const materials = loadStageMaterials(cwd);
		const pools = loadEcologyPools(cwd, materials.config.card, materials.card.name);
		const prompt = buildEcologyCardPrompt("规则", { global: pools.global, cardPool: pools.card, card: materials.card, lore: materials.entries, state: defaultState(), history: Array.from({ length: 20 }, (_, index) => ({ role: index % 2 ? "assistant" as const : "user" as const, text: "长历史".repeat(10_000) })) });
		assert.ok(JSON.stringify(materials.rawCard).length > 1_000_000, "夹具必须保持巨型原始卡");
		assert.ok(prompt.userText.length < 140_000, `生态适配 prompt 应有界，实际 ${prompt.userText.length}`);
		assert.equal(prompt.userText.includes('"book"'), false);
	});
});

test("模型调用预算：状态栏重Roll材料保持小于60K", () => {
	withLargeCard((cwd) => {
		const materials = loadStageMaterials(cwd);
		const compact = buildCurtainRerollMaterials({ card: materials.card, entries: materials.entries, preset: materials.preset, statusBarFormats: materials.statusBarFormats });
		assert.ok(JSON.stringify(compact).length < 60_000);
	});
});
