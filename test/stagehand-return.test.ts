import assert from "node:assert/strict";
import { test } from "node:test";

import { buildStagehandInjection, buildStagehandPrompt } from "../src/stagehand.ts";
import { DEFAULT_CONFIG } from "../src/types.ts";

test("助手提示词含 return_answer / ask_user / 完成判据", () => {
	const p = buildStagehandPrompt({ config: DEFAULT_CONFIG, skills: [] });
	assert.ok(p.includes("return_answer"));
	assert.ok(p.includes("ask_user"));
	assert.ok(p.includes("完成判据"));
	assert.ok(p.includes("放弃"));
});

test("委托回合注入提醒 return_answer", () => {
	const off = buildStagehandInjection({
		sessionId: "abcdefghijkl",
		cardName: "卡",
		userName: "用户",
		model: null,
		contextPercent: 10,
		messageCount: 3,
		streaming: false,
		delegateActive: false,
	});
	assert.ok(!off.includes("委托回合"));

	const on = buildStagehandInjection({
		sessionId: "abcdefghijkl",
		cardName: "卡",
		userName: "用户",
		model: null,
		contextPercent: 10,
		messageCount: 3,
		streaming: false,
		delegateActive: true,
	});
	assert.ok(on.includes("委托回合"));
	assert.ok(on.includes("return_answer"));
	assert.ok(on.includes("ask_user"));
});
