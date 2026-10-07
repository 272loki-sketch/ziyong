import assert from "node:assert/strict";
import test from "node:test";
import { existingEcologyReference } from "../src/stage/passive-ecology.ts";
import { defaultState } from "../src/state.ts";

test("只读已有生态素材：候选不是事实，不带旧玩家权限/停点/剧本限制", () => {
	const input: any = { state: { ...defaultState(), location: "教室" }, history: [], userText: "继续。", ecology: { occurrences: [] }, globalPool: { prototypes: [] }, cardPool: { templates: [{ id: "t1", name: "放学后的借书", form: "借书", status: "active", locations: ["教室"], likelyActors: ["同学"], possibleDevelopments: ["共同寻找一本书"], constraints: ["禁止替用户决定"], playerStop: "等待用户决定", playerAgency: "等待", progressLimit: "只能反应一次" }] } };
	const original = JSON.stringify(input);const result = existingEcologyReference(input);
	assert.ok(result);assert.match(result, /existing-candidates-not-facts/);assert.match(result, /共同寻找一本书/);assert.doesNotMatch(result, /禁止替用户|等待|playerStop|constraints|progressLimit/);assert.equal(JSON.stringify(input), original);
});
