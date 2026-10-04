import assert from "node:assert/strict";
import test from "node:test";
import { buildPlotAdaptationPrompt, formatPlotAdaptation, parsePlotAdaptation } from "../src/stage/plot-adaptation.ts";

const card = { name: "青梧", description: "克制的校园角色扮演", personality: "谨慎，不轻易示弱", scenario: "放学后的教室", firstMes: "", mesExample: "", systemPrompt: "", postHistoryInstructions: "", creatorNotes: "", alternateGreetings: [], tags: ["校园"], book: [] };
const state = { time: "傍晚", location: "教室", characters: {}, inventory: [], flags: {}, plot_threads: [] };
const pool = { version: 1 as const, cardKey: "card", cardName: "青梧", revision: 1, updatedAt: "", digest: "校园里的关系与资源压力", worldGrammar: ["点数影响班级关系"], actorGrammar: ["角色习惯用试探代替直白"], templates: [{ id: "t-1", prototypeId: "p-1", name: "资源误会", form: "公共资源异常", locations: ["教室"], likelyActors: ["同学"], constraints: ["不替玩家决定"], possibleDevelopments: ["误会扩大"], tags: ["校园"], patternKey: "resource", status: "active" as const, useCount: 0 }] };
const global = { version: 1 as const, revision: 1, updatedAt: "", digest: "", prototypes: [] };
const ecology = { version: 1 as const, round: 1, digest: "课后教室仍有人", actors: [], occurrences: [], locationStates: [], recentPatterns: [], recentUses: [], secrets: [] };
const outline = { revision: 1, hash: "hash", premise: "", currentFocus: [], collections: {} };

test("生态剧情适配提示词包含卡语法、生态和大纲，但明确它们不是事实", () => {
	const prompt = buildPlotAdaptationPrompt({ card, cardPool: pool, globalPool: global, ecology, outline, state, history: [{ role: "user", text: "我看向窗外" }], userText: "我看向窗外", userName: "旅人" });
	assert.match(prompt.systemPrompt, /不是筛掉生态/);
	assert.match(prompt.userText, /点数影响班级关系/);
	assert.match(prompt.userText, /课后教室仍有人/);
});

test("生态剧情适配解析和注入保留候选、因果、伏笔及行动上限", () => {
	const adapted = parsePlotAdaptation(JSON.stringify({ cardGrammar: "日常中的资源压力会引出关系试探", selected: { id: "p-1", templateId: "t-1", name: "账目异常", adaptedEvent: "公共点数出现一笔无法解释的扣除", whyNow: "课后结算刚结束", involvedCharacters: ["青梧"], causalLinks: ["上一拍提到点数"], foreshadowing: ["有人提前知道扣除时间"], entryPoint: "终端提示音打断对话", progressLimit: "只出现疑点", playerAgency: "用户决定是否查看", }, reserves: [] }));
	assert.equal(adapted?.selected?.status, "selected");
	const formatted = formatPlotAdaptation(adapted);
	assert.match(formatted ?? "", /不是已发生事实/);
	assert.match(formatted ?? "", /只出现疑点/);
});
