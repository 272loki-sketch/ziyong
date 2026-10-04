import assert from "node:assert/strict";
import test from "node:test";
import { buildSceneConductorPrompt, formatSceneConductor, parseSceneConductor } from "../src/stage/scene-conductor.ts";

test("场面编排将导演与候选事件约束为一拍行动链", () => {
	const prompt = buildSceneConductorPrompt({
		plot: { version: 1, cardGrammar: "校园资源冲突应从日常细节进入", selected: { id: "p1", name: "账目异常", adaptedEvent: "终端显示异常扣除", whyNow: "课后结算", involvedCharacters: ["青梧", "林霜"], causalLinks: [], foreshadowing: [], entryPoint: "提示音", progressLimit: "只出现疑点", playerAgency: "用户决定是否查看", status: "selected" }, reserves: [], rejected: [] },
		direction: { version: 1, playerStop: "把终端递给用户", candidateBeats: ["角色先试探"] },
		outline: { revision: 1, hash: "hash", premise: "", currentFocus: [], collections: {} },
	});
	assert.match(prompt.systemPrompt, /不能替用户行动/);
	assert.match(prompt.userText, /账目异常/);
});

test("场面编排结果保留信息边界和玩家停点", () => {
	const value = parseSceneConductor(JSON.stringify({ sceneObjective: "让异常进入对话", turnOrder: ["提示音响起 → 林霜停顿 → 用户注意到终端"], pressureShift: "普通闲聊变成试探", informationBoundary: ["林霜不能说出未知内幕"], playerStop: "用户决定是否点开终端", avoid: ["直接揭露真相"] }));
	assert.equal(value?.turnOrder.length, 1);
	const text = formatSceneConductor(value);
	assert.match(text ?? "", /不是正文或已发生事实/);
	assert.match(text ?? "", /用户决定是否点开终端/);
});
