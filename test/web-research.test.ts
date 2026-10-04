import assert from "node:assert/strict";
import { test } from "node:test";

import { webResearchTool, wantsManualWebResearch } from "../src/tools/web-research.ts";
import {
	hostUsesWebResearchProxy,
	isSearchChallenge,
	parseBing,
	parseDuckDuckGo,
	rankWebResearchResults,
	resolveWebResearchProxy,
	sanitizeWebResearchQuery,
} from "../server/web-research.ts";

test("联网查证工具：最多三个查询，部分失败保留并格式化", async () => {
	let received: string[] = [];
	const result = await webResearchTool.run({
		queries: ["甲 查询", "乙 查询", "甲 查询", "丙 查询", "丁 查询"], max_results_per_query: 9,
	}, {
		webResearch: async (queries, maxResults) => {
			received = queries;
			assert.equal(maxResults, 5);
			return [
				{ query: queries[0], results: [{ title: "标题", url: "https://example.com", snippet: "摘要" }] },
				{ query: queries[1], error: "timeout" },
				{ query: queries[2], rejected: "私人信息" },
			];
		},
	}, { surface: "stage", language: "中文" });
	assert.deepEqual(received, ["甲 查询", "乙 查询", "丙 查询"]);
	assert.ok(result.text.includes("https://example.com"));
	assert.ok(result.text.includes("timeout"));
	assert.ok(result.text.includes("私人信息"));
});

test("联网结果：识别人机验证并可解析 Bing 兜底", () => {
	assert.equal(isSearchChallenge("Please complete the following challenge to confirm this search was made by a human"), true);
	const html = '<ol><li class="b_algo"><h2><a href="https://example.com/story">校园图书馆活动</a></h2><div><p class="b_lineclamp2">旧书募集与读书会资料</p></div></li></ol>';
	assert.deepEqual(parseBing(html), [{ title: "校园图书馆活动", url: "https://example.com/story", snippet: "旧书募集与读书会资料" }]);
});

test("联网查证模式：manual 只接受明确联网意图", () => {
	assert.equal(wantsManualWebResearch("请联网搜索一下明治时期的资料"), true);
	assert.equal(wantsManualWebResearch("帮我上网搜一下明治资料"), true);
	assert.equal(wantsManualWebResearch("请百度一下明治资料"), true);
	assert.equal(wantsManualWebResearch("查一下网上的公开资料"), true);
	assert.equal(wantsManualWebResearch("继续剧情，去图书馆查资料"), false);
});

test("联网查询最终闸门剔除用户栏姓名并保留剧情主题", () => {
	assert.equal(sanitizeWebResearchQuery("测试玩家 高中篮球社 放学后训练活动", "测试玩家"), "高中篮球社 放学后训练活动");
	assert.equal(sanitizeWebResearchQuery("图书馆 朱.耀良 读书会", "朱.耀良"), "图书馆 读书会");
});

test("联网代理：专用变量优先、direct 关闭、NO_PROXY 生效", () => {
	assert.equal(resolveWebResearchProxy({ LIYUAN_WEB_RESEARCH_PROXY: "http://127.0.0.1:9000", HTTPS_PROXY: "http://x:1" } as never)?.port, "9000");
	assert.equal(resolveWebResearchProxy({ LIYUAN_WEB_RESEARCH_PROXY: "direct" } as never), null);
	const proxy = new URL("http://127.0.0.1:7890");
	assert.equal(hostUsesWebResearchProxy("localhost", proxy, { NO_PROXY: "localhost,.example.com" } as never), false);
	assert.equal(hostUsesWebResearchProxy("api.example.com", proxy, { NO_PROXY: "localhost,.example.com" } as never), false);
	assert.equal(hostUsesWebResearchProxy("duckduckgo.com", proxy, { NO_PROXY: "localhost" } as never), true);
});

test("联网结果：DuckDuckGo 解析、URL 去重和相关性排名", () => {
	const html = '<a class="result__a" href="https://example.com/a">明治 京都</a><a class="result__snippet">町屋取暖资料</a>';
	assert.equal(parseDuckDuckGo(html).length, 1);
	const ranked = rankWebResearchResults("明治 京都", [
		{ title: "无关", url: "https://x.example", snippet: "" },
		{ title: "明治 京都", url: "https://example.com/a#part", snippet: "资料" },
		{ title: "重复", url: "https://example.com/a", snippet: "明治" },
	]);
	assert.equal(ranked.length, 1);
	assert.ok(ranked[0].title.includes("明治"));
});
