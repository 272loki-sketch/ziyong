import assert from "node:assert/strict";
import { test } from "node:test";

import {
	buildLiteraryDirectorPrompt,
	formatLiteraryDirection,
	parseLiteraryDirection,
} from "../src/stage/literary-director.ts";
import { defaultState } from "../src/state.ts";
import { readFileSync } from "node:fs";

test("文学导演：提示词固定唯一拍前导演及候选事实边界", () => {
	const prompt = buildLiteraryDirectorPrompt({
		state: defaultState(), history: [{ role: "user", text: "我推开门。" }],
		activatedLore: [], userText: "我推开门。", charName: "云澜", userName: "沈舟",
	});
	assert.ok(prompt.systemPrompt.includes("不写正文"));
	assert.ok(prompt.systemPrompt.includes("唯一的拍前导演"));
	assert.ok(prompt.systemPrompt.includes("不得创造新事实"));
	const skill = readFileSync(new URL("../skills/Stitches拍前导演/SKILL.md", import.meta.url), "utf8");
	assert.ok(!prompt.systemPrompt.includes("playerStop") && !skill.includes("playerStop"));
	assert.ok(!prompt.systemPrompt.includes("涉及玩家行动、思想、对白或重大选择前的停点"));
	assert.ok(!prompt.systemPrompt.includes("每一拍还必须给出"));
	assert.ok(!skill.includes("不跨到放学、夜晚、次日"), "不再追加系统级默认时间冻结");
	assert.ok(skill.includes("不重演后续"));
	assert.ok(prompt.userText.includes("我推开门"));
});

test("文学导演：只解析允许字段并限制数量和长度", () => {
	const parsed = parseLiteraryDirection(JSON.stringify({
		scenePressure: "门外的催促",
		characterInitiatives: [
			{ character: "甲", motive: "确认来意", immediateIntent: "试探", limit: "不动手" },
			{ character: "乙", motive: "等待", immediateIntent: "观察", limit: "不揭密" },
			{ character: "丙", motive: "离开", immediateIntent: "告辞", limit: "不替玩家回应" },
			{ character: "丁", motive: "超限", immediateIntent: "", limit: "" },
		],
		personalThreads: ["个人线"], offstageThreads: [], playerStop: "交还玩家",
		candidateBeats: ["候选"], relationshipLimit: "只到试探",
		unknown: "丢弃",
	}));
	assert.equal(parsed?.characterInitiatives?.length, 3);
	assert.equal(parsed?.playerStop, "交还玩家");
	assert.equal("unknown" in (parsed as object), false);
	assert.ok(formatLiteraryDirection(parsed!).includes("角色主动性"));
	assert.ok(formatLiteraryDirection(parsed!).includes("候选拍点（非事实）"));
	assert.equal(parseLiteraryDirection("not json"), undefined);
});

test("文学导演：解析脏围栏并轻量兼容旧主动性字段", () => {
	const parsed = parseLiteraryDirection("前言```json\n{\"characterInitiative\":[\"守住门口\"],\"withheldInformation\":[\"真名\"]}\n```尾注");
	assert.equal(parsed?.characterInitiatives?.[0]?.motive, "守住门口");
	assert.deepEqual(parsed?.withheldInformation, ["真名"]);
});
