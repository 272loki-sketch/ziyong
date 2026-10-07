import assert from "node:assert/strict";
import test from "node:test";
import { extractPureTextNarrative } from "../src/stage/engine.ts";

test("正文收取递归拆开 main_output/content，不把内层正文当格式块剥掉", () => {
	const prose = "他翻回上午的题目。\n\n堀北把答案写在页边。";
	assert.equal(extractPureTextNarrative(`<main_output>\n<content><time>午休</time>${prose}</content><options>格式不是正文</options></main_output>`), prose);
	assert.equal(extractPureTextNarrative(`<content><main_output>${prose}</main_output></content>`), prose);
});

test("两个正文容器没闭合且末尾格式截断，也保留已有小说内容", () => {
	const prose = "他把练习册推了过去。\n\n她圈出缺少的条件。";
	for (const tail of ["", "<image><imgthink>未完成的格式", "<details>未完成的状态栏"]) {
		assert.equal(extractPureTextNarrative(`<main_output>\n<content><time>午休</time>\n${prose}\n${tail}`), prose);
	}
});

test("内嵌完整图片保留原位置，不丢前后正文，也不改正常结尾词", () => {
	const head = "她看向你，拿起铅笔。", tail = "他等着上课铃响。";
	assert.equal(extractPureTextNarrative(`<main_output><content>${head}\n<image><imgthink>图像描述</imgthink>image prompt</image>\n${tail}</content></main_output>`), `${head}\n<image><imgthink>图像描述</imgthink>image prompt</image>\n${tail}`);
	assert.equal(extractPureTextNarrative(head+"\n\n"+tail), head+"\n\n"+tail);
});

test("纯格式不被识别成故事正文，未知面板容器不自动升级为正文", () => {
	assert.equal(extractPureTextNarrative("<main_output><content><details>面板</details></content></main_output>"), "");
	assert.equal(extractPureTextNarrative("<unrelated_panel>不是已知正文</unrelated_panel>"), "");
});


test("已经进入正文后，不追逐面板内的content子标签来覆盖前文", () => {
	assert.equal(extractPureTextNarrative("<main_output><content>真实故事。<details><content>面板文字</content></details>后半段故事。</content></main_output>"), "真实故事。后半段故事。");
});
