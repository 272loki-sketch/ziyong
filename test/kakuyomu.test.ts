import assert from "node:assert/strict";
import test from "node:test";

import { discoverKakuyomuWorks, fetchKakuyomuWork, normalizeKakuyomuWorkUrl, parseKakuyomuEpisode, parseKakuyomuWork } from "../src/outline/kakuyomu.ts";
import { CorpusScheduler, millisecondsUntilLocalTime, selectDailyKakuyomuWorks } from "../src/outline/corpus-scheduler.ts";
import type { CorpusEngine } from "../src/outline/corpus.ts";

const workUrl = "https://kakuyomu.jp/works/ABC_123";
const workHtml = `<h1 class="Heading_heading__x"><span><a title="作品&名" href="/works/ABC_123">作品名</a></span></h1><div><div><div class="partialGiftWidgetActivityName"><a href="/users/a">作者</a></div></div></div><script src="data">{"__APOLLO_STATE__":{</script><script>"introduction":"简介\\n内容",</script><script>{"ROOT_QUERY":{}},"Episode:111":{,"__typename":"Episode","id":"111","title":"第一話"},"Episode:222":{"__typename":"Episode","id":"222","title":"第二話"}</script>`;
const episodeHtml = `<header><p class="chapterTitle level1 js-vertical-composition-item"><span>第一章</span></p><p class="widget-episodeTitle js-vertical-composition-item">第一話</p></header><div class="widget-episode js-episode-body-container"><div class="widget-episode-inner"><div class="widget-episodeBody"><p id="p1">　本文<ruby><rb>漢字</rb><rp>（</rp><rt>かんじ</rt><rp>）</rp></ruby>是正文。<br /></p><p id="p2">　第二段。</p></div></div></div>`;

test("Kakuyomu URL 只接受作品主页", () => {
	assert.equal(normalizeKakuyomuWorkUrl(workUrl).pathname, "/works/ABC_123");
	assert.throws(() => normalizeKakuyomuWorkUrl("https://example.com/works/ABC_123"));
	});

test("解析作品页的元数据与章节顺序", () => {
	const work = parseKakuyomuWork(workHtml, new URL(workUrl));
	assert.equal(work.title, "作品&名");
	assert.equal(work.author, "作者");
	assert.equal(work.chapters.length, 2);
	assert.equal(work.chapters[1]?.url, `${workUrl}/episodes/222`);
});

test("解析章节正文并处理基础 HTML 标签", () => {
	const text = "第一章\n\n第一話\n\n" + parseKakuyomuEpisode(episodeHtml, "第一話").split("\n\n").slice(2).join("\n\n");
	assert.match(text, /第一章/);
	assert.match(text, /第一話/);
	assert.match(text, /本文漢字（かんじ）是正文。/);
	assert.match(text, /第二段。/);
	assert.equal((text.match(/（/g) || []).length, 1);
});

test("抓取器串行拼接章节，失败章节保留占位", async () => {
	const calls: string[] = [];
	const result = await fetchKakuyomuWork(workUrl, async (url) => {
		calls.push(url.pathname);
		if (url.pathname.endsWith("episodes/222")) throw new Error("HTTP 403");
		return url.pathname === "/works/ABC_123" ? workHtml : episodeHtml;
	}, new AbortController().signal, 0);
	assert.deepEqual(calls, ["/works/ABC_123", "/works/ABC_123/episodes/111", "/works/ABC_123/episodes/222"]);
	assert.match(result.text, /抓取失败：HTTP 403/);
});

test("搜索页提取作品候选并去重", async () => {
	const html = `<a href="/works/111" title="日常甲">甲</a><a href="/works/111" title="日常甲">甲</a><a href="/works/222" title="校园乙">乙</a>`;
	const result = await discoverKakuyomuWorks(["学園 日常"], async (url) => {
		assert.equal(url.pathname, "/search");
		assert.equal(url.searchParams.get("q"), "学園 日常");
		return html;
	}, new AbortController().signal, { maxResults: 10 });
	assert.deepEqual(result.map((item) => item.url), ["https://kakuyomu.jp/works/111", "https://kakuyomu.jp/works/222"]);
});

test("每日候选最多三部，并排除已入库作品", () => {
	const candidates = [1, 2, 3, 4].map((id) => ({ url: `https://kakuyomu.jp/works/${id}`, title: String(id), query: "q" }));
	const selected = selectDailyKakuyomuWorks(candidates, new Set(["doc-" + "0".repeat(16)]), 3);
	assert.equal(selected.length, 3);
	assert.equal(millisecondsUntilLocalTime(new Date("2026-08-24T04:00:00"), 5, 0), 60 * 60 * 1000);
});

test("手动发现返回三部入队结果并在运行中拒绝重复触发", async () => {
	const created: string[] = [];
	let releaseSearch!: () => void;
	const searchStarted = new Promise<void>((resolve) => { releaseSearch = resolve; });
	let unblock!: () => void;
	const blocked = new Promise<void>((resolve) => { unblock = resolve; });
	const engine = {
		view: () => ({ documents: [] }),
		createUrl: async (url: string) => { created.push(url); return { doc: {}, estimatedCalls: 0 }; },
	} as unknown as CorpusEngine;
	const scheduler = new CorpusScheduler({
		engine,
		schedule: { enabled: false, hour: 5, minute: 0, maxPerRun: 1, queries: ["日常"] },
		fetchText: async () => {
			releaseSearch();
			await blocked;
			return [1, 2, 3, 4].map((id) => `<a href="/works/${id}" title="作品${id}">作品${id}</a>`).join("");
		},
	});
	const running = scheduler.runNow(new Date("2026-08-25T05:00:00"), 3);
	await searchStarted;
	assert.equal((await scheduler.runNow()).status, "busy");
	unblock();
	const result = await running;
	assert.equal(result.status, "started");
	assert.equal(result.queued.length, 3);
	assert.equal(created.length, 3);
});
