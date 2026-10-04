import assert from "node:assert/strict";
import test from "node:test";

import { buildCardFrontSnapshot } from "../src/cardfront.ts";
import { prepareDisplayText } from "../src/postprocess.ts";
import { lorebookRegexScripts } from "./fixtures/lorebook-cardfront.ts";

test("运行时装载外挂世界书 regex_scripts：贴吧、表情和小剧场皮肤不掉", () => {
	const skin = buildCardFrontSnapshot(
		{ card: "fixture-card.json", userName: "测试用户" },
		null,
		"测试角色",
		[{ source: "fixture:lorebook-cardfront", scripts: [...lorebookRegexScripts] }],
	);
	assert.ok(skin.rules.some((rule) => rule.name === "贴吧前端2"), "首屏 cardfront 也必须包含外挂世界书规则");
	const source = `<Small_theater>\nAPPname: 高度育成高中 校园BBS\ntitle: 测试\n\n须藤健 [https://example.com/a.png] (LV.9): 你好[表情13]\n</Small_theater>`;
	const display = prepareDisplayText(source, { rules: skin.rules, charName: "测试角色", userName: "测试用户" });
	assert.match(display, /<!DOCTYPE html>/);
	assert.match(display, /image_emoticon13\.png/);
});
