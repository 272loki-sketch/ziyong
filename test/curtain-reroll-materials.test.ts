import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildCurtainRerollMaterials, finalizeCurtainText } from "../src/stage/curtain-materials.ts";
import { loadStageMaterials } from "../src/stage/materials.ts";

function withCurtainFixture(run: (cwd: string) => void): void {
	const cwd = mkdtempSync(join(tmpdir(), "liyuan-curtain-materials-"));
	try {
		const card = {
			data: {
				name: "测试角色",
				description: "巨型卡填充".repeat(200_000),
				character_book: {
					entries: [
						{
							id: 1,
							name: "校园BBS格式",
							keys: ["BBS"],
							content: "<Small_theater>\nAPPname: 高度育成高中 校园BBS\n每次回复结尾输出论坛帖子。\n</Small_theater>",
							enabled: true,
						},
						{
							id: 2,
							name: "旧日历格式",
							keys: ["日历"],
							content: "<calendar>AI日历生成器：完整输出当月每一天</calendar>",
							enabled: true,
						},
						{
							id: 3,
							name: "行动选项格式",
							keys: ["选项"],
							content: "<options>1. 继续</options>",
							enabled: true,
						},
					],
				},
				extensions: {
					regex_scripts: [
						{
							scriptName: "当前状态栏",
							findRegex: "/<user_now_status>[\\s\\S]*?<\\/user_now_status>/g",
							replaceString: "$&",
							placement: [2],
							disabled: false,
							markdownOnly: true,
							promptOnly: false,
						},
					],
				},
			},
		};
		writeFileSync(join(cwd, "card.json"), JSON.stringify(card));
		writeFileSync(join(cwd, "liyuan.config.json"), JSON.stringify({ card: "card.json" }));
		mkdirSync(join(cwd, ".liyuan-stage-skills"), { recursive: true });
		run(cwd);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
}

function compactMaterials(cwd: string) {
	const materials = loadStageMaterials(cwd);
	return {
		materials,
		compact: buildCurtainRerollMaterials({
			card: materials.card,
			entries: materials.entries,
			preset: materials.preset,
			statusBarFormats: materials.statusBarFormats,
		}),
	};
}

test("状态栏重Roll：巨型卡只送有界格式材料，不送完整 rawCard/character_book", () => {
	withCurtainFixture((cwd) => {
		const { materials, compact } = compactMaterials(cwd);
		const text = JSON.stringify(compact);
		assert.ok(JSON.stringify(materials.rawCard).length > 1_000_000, "夹具应为巨型卡，才能覆盖本次事故");
		assert.ok(text.length < 60_000, `格式材料应小于 60K 字，实际 ${text.length}`);
		assert.equal(text.includes("regex_scripts"), false);
		assert.equal(text.includes("character_book"), false);
		assert.ok(compact.formatHints.length > 0);
		assert.ok(compact.formatPlan.modelTags.includes("user_now_status"));
		assert.ok(compact.formatPlan.nativeTags.includes("calendar"));
		assert.ok(compact.formatPlan.modelTags.includes("Small_theater"));
		assert.ok(compact.formatPlan.modelTags.includes("options"));
		assert.equal(compact.loreFormats.some((entry) => /AI日历生成器|完整输出当月每一天/.test(entry.content)), false, "旧日历规则不再送给模型谢幕模板");
		assert.ok(compact.loreFormats.some((entry) => /百度贴吧|Small_theater|校园BBS/i.test(`${entry.title}\n${entry.content}`)), "挂载世界书的BBS格式进入重Roll素材");
	});
});

test("普通谢幕与状态栏重Roll共用同一份挂载世界书格式材料", () => {
	withCurtainFixture((cwd) => {
		const { compact } = compactMaterials(cwd);
		const bbs = compact.loreFormats.find((entry) => /百度贴吧|Small_theater|校园BBS/i.test(`${entry.title}\n${entry.content}`));
		assert.ok(bbs, "普通谢幕调用同一 builder 时能取得BBS定义");
		assert.match(bbs.content, /每次回复结尾/);
		assert.match(bbs.content, /APPname:\s*高度育成高中 校园BBS/);
	});
});

test("谢幕收口：当前卡前端由代码补齐，禁止别卡学生证并剥离模型日历", () => {
	withCurtainFixture((cwd) => {
		const { compact } = compactMaterials(cwd);
		const output = finalizeCurtainText(`<user_now_status>错误学生证</user_now_status>\n<calendar>模型乱造日历</calendar>\n<options>1. 继续</options>`, compact.formatPlan);
		assert.match(output, /<user_now_status>错误学生证<\/user_now_status>/, "当前卡明确的状态栏由模型保留");
		assert.doesNotMatch(output, /<calendar>|模型乱造日历/);
		assert.match(output, /<options>1\. 继续<\/options>/);
	});
});

test("谢幕收口：抢跑选项保留，正式谢幕后置且一份", () => {
	const plan = {
		modelTags: ["options", "Small_theater"],
		nativeTags: ["calendar"],
		deterministicTags: ["StatusPlaceHolderImpl"],
		forbiddenTags: ["user_now_status"],
	};
	const onlyBbsLater = finalizeCurtainText(`<options>抢跑选项</options>\n元话语\n<Small_theater>正式BBS</Small_theater>`, plan);
	assert.match(onlyBbsLater, /抢跑选项/);
	assert.match(onlyBbsLater, /正式BBS/);
	assert.doesNotMatch(onlyBbsLater, /元话语/);

	const repeated = finalizeCurtainText(`<options>旧选项</options>\n<options>正式新选项</options>\n<Small_theater>BBS</Small_theater>`, plan);
	assert.doesNotMatch(repeated, /旧选项/);
	assert.match(repeated, /正式新选项/);
	assert.equal((repeated.match(/<options>/g) ?? []).length, 1);
});
