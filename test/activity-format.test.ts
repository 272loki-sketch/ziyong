import assert from "node:assert/strict";
import { test } from "node:test";

import { formatToolStartDetail, looksLikeRawArgs, toolStartDetail } from "../src/activity-format.ts";

test("lorebook_write：标题+正文摘要成人话", () => {
	const d = formatToolStartDetail("lorebook_write", {
		comment: "文案",
		content: "世家侧近侍。外冷内谨，与主角有旧识未揭。",
	});
	assert.match(d, /写入设定「文案」/);
	assert.match(d, /世家侧近侍/);
	assert.ok(!d.includes("{"));
});

test("lorebook_search / ask_director / panel_write", () => {
	assert.equal(formatToolStartDetail("lorebook_search", { query: "望月城" }), "检索设定：望月城");
	assert.match(formatToolStartDetail("ask_director", { question: "今晚怎么试墨？" }), /试墨/);
	assert.match(formatToolStartDetail("panel_write", { name: "关系图", kind: "svg" }), /关系图/);
});

test("assistant_run / world_state_update", () => {
	assert.match(formatToolStartDetail("assistant_run", { task: "生成一张夜景图" }), /委托助手/);
	assert.match(formatToolStartDetail("world_state_update", { patch: { time: "戌时", location: "御书房" } }), /记账：time、location/);
});

test("不甩 JSON：toolStartDetail 对空对象返回空", () => {
	assert.equal(toolStartDetail("unknown_tool", { foo: 1, bar: 2 }), "");
	assert.equal(toolStartDetail("lorebook_search", {}), "检索世界书");
});

test("looksLikeRawArgs", () => {
	assert.equal(looksLikeRawArgs('{"query":"x"}'), true);
	assert.equal(looksLikeRawArgs("检索设定：望月城"), false);
});
