import assert from "node:assert/strict";
import test from "node:test";
import { buildCharacterRehearsalPrompt, formatCharacterRehearsals, parseCharacterRehearsal } from "../src/stage/character-rehearsal.ts";

const state = { time: "傍晚", location: "社团教室", characters: { "林霜": { affinity: 20, status: "压着火气", notes: "知道昨晚的约定" } }, inventory: [], flags: {}, plot_threads: [] };
const card = { name: "青梧", description: "外冷内热", personality: "谨慎，不轻易示弱", scenario: "放学后的社团教室", firstMes: "", mesExample: "", systemPrompt: "", postHistoryInstructions: "", creatorNotes: "", alternateGreetings: [], tags: [], book: [] };

test("角色排演提示词携带角色卡、世界书、账本和近期剧情", () => {
	const prompt = buildCharacterRehearsalPrompt({
		character: card,
		role: "card-character",
		characterState: state.characters["林霜"],
		state,
		userName: "旅人",
		userText: "我想问她昨晚为什么没有赴约",
		recentHistory: [{ role: "user", text: "昨晚约好了见面" }, { role: "assistant", text: "她在门口停了很久。" }],
		lore: [{ uid: 1, keys: ["林霜"], secondaryKeys: [], comment: "林霜人设", content: "她不愿在人前示弱，但会用反问掩饰在意。", constant: false, enabled: true, selective: false, order: 1 }],
	});
	assert.match(prompt.systemPrompt, /单角色排演 agent/);
	assert.match(prompt.userText, /不愿在人前示弱/);
	assert.match(prompt.userText, /昨晚为什么没有赴约/);
	assert.match(prompt.userText, /压着火气/);
});

test("角色排演结果宽容解析并格式化为正文参考", () => {
	const rehearsal = parseCharacterRehearsal("```json\n{\"objective\":\"确认对方是否还在意约定\",\"currentEmotion\":\"嘴硬但不安\",\"likelyActions\":[\"先反问\"],\"dialogueIntent\":\"试探而非直接追问\",\"possibleLines\":[\"你倒是记得很清楚？\"],\"knowledgeBoundary\":[\"不知道对方真正原因\"],\"misreadings\":[\"以为对方只是敷衍\"],\"wontDo\":[\"当众承认在意\"]}\n```", "林霜", "active-character");
	assert.ok(rehearsal);
	assert.equal(rehearsal?.role, "active-character");
	const formatted = formatCharacterRehearsals([rehearsal!]);
	assert.match(formatted, /林霜/);
	assert.match(formatted, /可能动作：先反问/);
	assert.match(formatted, /不要替用户决定行动/);
});
