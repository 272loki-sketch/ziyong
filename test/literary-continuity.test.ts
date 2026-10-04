import assert from "node:assert/strict";
import { test } from "node:test";

import {
	buildLiteraryContinuityPrompt,
	formatLiteraryContinuity,
	parseLiteraryContinuity,
	shouldRunContinuity,
} from "../src/stage/literary-continuity.ts";
import { defaultState } from "../src/state.ts";

test("文学连续性：提示词不越过状态与正文边界", () => {
	const prompt = buildLiteraryContinuityPrompt({
		state: defaultState(),
		history: [{ role: "assistant", text: "她仍站在门边。" }],
		summary: "两人刚刚会面。",
		activatedLore: [],
		userText: "我等她回答。",
		charName: "云澜",
		userName: "沈舟",
	});
	assert.ok(prompt.systemPrompt.includes("不重述或改写 rp-state"));
	assert.ok(prompt.systemPrompt.includes("不写正文"));
	assert.ok(prompt.systemPrompt.includes("绝不成为事实"));
	const payload = JSON.parse(prompt.userText);
	assert.equal(payload.latest_user_input, "我等她回答。");
});

test("文学连续性：解析围栏、丢弃未知字段并执行项数长度上限", () => {
	const long = "长".repeat(240);
	const parsed = parseLiteraryContinuity(`说明\n\`\`\`json\n${JSON.stringify({
		positions: [long, "门边", "窗边", "桌旁", "超限"],
		ongoingActions: ["等待回答"],
		uncertainties: ["来客身份未证实"],
		unknown: ["丢弃"],
	})}\n\`\`\``);
	assert.equal(parsed?.positions?.length, 4);
	assert.equal(parsed?.positions?.[0]?.length, 180);
	assert.equal("unknown" in (parsed as object), false);
	assert.ok(formatLiteraryContinuity(parsed!).includes("候选不等于事实"));
	assert.equal(parseLiteraryContinuity("not json"), undefined);
});

test("文学连续性：简单拍跳过，复杂拍运行", () => {
	const state = defaultState();
	assert.equal(shouldRunContinuity({ state, history: [], userText: "我点点头。" }), false);
	assert.equal(shouldRunContinuity({ state, history: [], summary: "此前已有长线剧情", userText: "继续。" }), true);
	assert.equal(shouldRunContinuity({ state, history: [], userText: "第二天清晨，我抵达车站。" }), true);
	assert.equal(shouldRunContinuity({
		state: {
			...state,
			characters: {
				甲: { affinity: 0, status: "在场", notes: "" },
				乙: { affinity: 0, status: "在场", notes: "" },
			},
		},
		history: [],
		userText: "我点点头。",
	}), true);
});
