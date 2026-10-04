import assert from "node:assert/strict";
import { test } from "node:test";

import { isBackstageText, stripBackstageMarker } from "../src/stance.ts";

test("场外标记：// 与双括号与整条括号包裹", () => {
	assert.ok(isBackstageText("//帮我看看好感度"));
	assert.ok(isBackstageText("  //前面有空白"));
	assert.ok(isBackstageText("((ooc: 这段太快了))"));
	assert.ok(isBackstageText("（（把温度调低点））"));
	assert.ok(isBackstageText("（帮我把这段设定存进世界书）"));
	assert.ok(isBackstageText("(generate an image of this scene)"));
	assert.ok(isBackstageText("（中文开括号英文闭括号也认)"));
});

test("场外标记：剧情输入不误判", () => {
	assert.ok(!isBackstageText("我推门走了进去。"));
	assert.ok(!isBackstageText("/rewind 2"), "单斜杠命令不是场外话");
	assert.ok(!isBackstageText("她说（小声地）：走吧"), "括号在句中不算整条包裹");
	assert.ok(!isBackstageText("（他抬起头）随后说道：你来了"), "开头括号但未包裹整条");
	assert.ok(!isBackstageText(""));
	assert.ok(!isBackstageText("   "));
	assert.ok(!isBackstageText("我该做什么"), "求方向无标记=戏内");
	assert.ok(!isBackstageText("下一步怎么办？"), "元问题无标记仍戏内");
});

test("剥场外标记：各种标记形态还原正文（改道助手会话用）", () => {
	assert.equal(stripBackstageMarker("//帮我看看好感度"), "帮我看看好感度");
	assert.equal(stripBackstageMarker("  // 前面有空白 "), "前面有空白");
	assert.equal(stripBackstageMarker("((ooc: 这段太快了))"), "ooc: 这段太快了");
	assert.equal(stripBackstageMarker("（（把温度调低点））"), "把温度调低点");
	assert.equal(stripBackstageMarker("（帮我把这段设定存进世界书）"), "帮我把这段设定存进世界书");
	assert.equal(stripBackstageMarker("(generate an image)"), "generate an image");
	// 只开不闭的双括号：剥开头即可
	assert.equal(stripBackstageMarker("((就说这些"), "就说这些");
	// 剥完为空 → 返回原文（防御畸形输入）
	assert.equal(stripBackstageMarker("//"), "//");
	assert.equal(stripBackstageMarker("（）"), "（）");
});
