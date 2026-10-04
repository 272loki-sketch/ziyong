import assert from "node:assert/strict";
import test from "node:test";

import { buildCardFrontSnapshot, displayRules, extractLorebookRegexScripts } from "../src/cardfront.ts";
import { applyCardSkin } from "../src/cardSkin.ts";
import { prepareDisplayText } from "../src/postprocess.ts";
import { splitHtmlParts } from "../web/src/htmlEmbed.ts";
import { lorebookEntries, lorebookRegexScripts } from "./fixtures/lorebook-cardfront.ts";

const path = "fixture:lorebook-cardfront";
const raw = { extensions: { regex_scripts: lorebookRegexScripts }, entries: lorebookEntries };
const scripts = extractLorebookRegexScripts(raw) as Array<Record<string, unknown>>;

test("日式中专大乱斗：Luker视觉皮肤保留启用，由梨园原生数据源驱动", () => {
	assert.deepEqual(scripts.map((item) => item.scriptName), ["贴吧前端2", "替换表情", "小剧场", "日期（大小固定优化适配）"]);
	assert.ok(scripts.every((item) => item.disabled === false));
	assert.equal(displayRules(scripts).length, 4);
});

test("日式中专大乱斗：贴吧终端renderer完整认领Small_theater，不再被小剧场二次包裹", () => {
	const snap = buildCardFrontSnapshot({ card: "x", userName: "测试玩家" }, null, "BBS", [{ source: path, scripts }]);
	assert.equal(snap.rules.some((rule) => rule.name === "贴吧前端2"), true);
	assert.equal(snap.rules.some((rule) => rule.name === "小剧场"), true, "作者规则按原序完整保留，不由梨园按名称删规则");
	const source = `<Small_theater>\nAPPname: 高度育成高中 校园BBS\ntitle: 测试标题\n\n橘茜 [https://files.catbox.moe/f6o0nh.png] (官方运营 LV.99): 你好[表情24]\n</Small_theater>`;
	const html = applyCardSkin(source, snap.rules, { charName: "BBS", userName: "测试玩家" });
	assert.match(html, /^```html\n<!DOCTYPE html>/);
	assert.match(html, /floorElement\.className = 'floor'/);
	assert.match(html, /image_emoticon24\.png/);
	const parts = splitHtmlParts(html);
	assert.equal(parts.length, 1);
	assert.equal(parts[0]?.kind, "html");
	if (parts[0]?.kind === "html") assert.equal(parts[0].scripts, true);
});

test("日式中专大乱斗：真实保护管线中贴吧先成整页，后续表情仍进入已暂存HTML", () => {
	const snap = buildCardFrontSnapshot({ card: "x", userName: "测试玩家" }, null, "BBS", [{ source: path, scripts }]);
	const source = `<Small_theater>\nAPPname: 高度育成高中 校园BBS\ntitle: 测试标题\n\n须藤健 [https://files.catbox.moe/u0ngbv.png] (篮球至上 LV.9): 我已经等不及了[表情13]\n</Small_theater>`;
	const display = prepareDisplayText(source, { rules: snap.rules, charName: "BBS", userName: "测试玩家" });
	assert.ok(!display.includes("[表情13]"), "原始表情标签不得残留在BBS HTML中");
	assert.match(display, /image_emoticon13\.png/);
	assert.match(display, /<img src="https:\/\/tb2\.bdstatic\.com\/tb\/editor\/images\/client\/image_emoticon13\.png">/);
});

test("日式中专大乱斗：旧MVU禁用，日历/BBS格式资料保留，世界线变动仍启用", () => {
	const entries = Object.values(raw.entries);
	for (const uid of [4, 8, 9, 14, 15, 17, 112, 114, 116, 124, 127, 169, 172, 173, 174, 175, 178, 182, 233]) {
		const entry = entries.find((item) => item.uid === uid);
		assert.equal(entry?.enabled, false, `uid ${uid} 应禁用`);
		assert.equal(entry?.disable, true, `uid ${uid} disable 应为 true`);
	}
	assert.equal(entries.find((item) => item.uid === 280)?.enabled, true);
	assert.equal(entries.find((item) => item.uid === 281)?.enabled, true);
	const worldline = entries.find((item) => item.uid === 282);
	assert.equal(worldline?.enabled, true);
	assert.equal(worldline?.disable, false);
});
