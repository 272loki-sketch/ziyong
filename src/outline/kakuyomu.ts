import { createHash } from "node:crypto";

export interface KakuyomuChapter {
	index: number;
	id: string;
	title: string;
	url: string;
}

export interface KakuyomuWork {
	url: string;
	title: string;
	author?: string;
	introduction?: string;
	chapters: KakuyomuChapter[];
}

export interface KakuyomuCandidate {
	url: string;
	title: string;
	query: string;
}

export type KakuyomuRequest = (url: URL, signal: AbortSignal) => Promise<string>;

const WORK_RE = /^https:\/\/kakuyomu\.jp\/works\/([A-Za-z0-9_-]+)\/?(?:[?#].*)?$/i;
// 作品页 __APOLLO_STATE__ 里的 Episode 节点：按出现顺序即目录顺序
const EPISODE_KEY_RE = /"Episode:([0-9]+)":\{[^{}]*?"title":"((?:\\.|[^"\\])*)"/g;

export function normalizeKakuyomuWorkUrl(value: string): URL {
	const url = new URL(value.trim());
	url.hash = "";
	if (!WORK_RE.test(url.toString())) throw new Error("仅支持公开的 Kakuyomu 作品 URL");
	return url;
}

function decodeJsonString(value: string): string {
	try { return JSON.parse(`"${value}"`); } catch { return value; }
}

function decodeHtml(value: string): string {
	return value
		.replace(/<[^>]+>/g, " ")
		.replaceAll("&nbsp;", " ")
		.replaceAll("&amp;", "&")
		.replaceAll("&quot;", '"')
		.replaceAll("&lt;", "<")
		.replaceAll("&gt;", ">")
		.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
		.replace(/\s+/g, " ")
		.trim();
}

export function parseKakuyomuWork(html: string, url: URL): KakuyomuWork {
	const titleMatch = /<h1[^>]*>[\s\S]*?<a[^>]*title="([^"]+)"/i.exec(html);
	const authorMatch = /partialGiftWidgetActivityName[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i.exec(html);
	const introMatch = /"introduction":"([\s\S]*?)",/.exec(html);
	const chapters: KakuyomuChapter[] = [];
	const seen = new Set<string>();
	for (const match of html.matchAll(EPISODE_KEY_RE)) {
		const id = match[1];
		if (seen.has(id)) continue;
		seen.add(id);
		chapters.push({ index: chapters.length, id, title: decodeJsonString(match[2]), url: `${url.toString().replace(/\/$/, "")}/episodes/${id}` });
	}
	if (!titleMatch?.[1]) throw new Error("Kakuyomu 作品页没有找到标题");
	if (!chapters.length) throw new Error("Kakuyomu 作品页没有找到公开章节");
	return {
		url: url.toString(),
		title: decodeHtml(titleMatch[1]),
		author: authorMatch?.[1] ? decodeHtml(authorMatch[1]) : undefined,
		introduction: introMatch?.[1] ? decodeHtml(decodeJsonString(introMatch[1])) : undefined,
		chapters,
	};
}

export function parseKakuyomuEpisode(html: string, fallbackTitle: string): string {
	const chapterMatch = /<p class="chapterTitle level(?:1|2)[^>]*>[\s\S]*?<span>([\s\S]*?)<\/span>/i.exec(html);
	const episodeMatch = /<p class="widget-episodeTitle[^>]*>([\s\S]*?)<\/p>/i.exec(html);
	const p1 = html.search(/<(?:p|figure) id="p1"[^>]*>/i);
	if (p1 < 0) throw new Error(`章节「${fallbackTitle}」没有找到正文`);
	// 正文为连续编号的 <p id="pN">…</p> 段落（可夹 <figure id="pN">），到容器闭合为止
	const bodyRe = /<(?:p|figure) id="p([0-9]+)"[^>]*>([\s\S]*?)<\/(?:p|figure)>/gi;
	const paragraphs: string[] = [];
	let lastP = -1;
	bodyRe.lastIndex = p1;
	for (const match of html.matchAll(bodyRe)) {
		if (match.index === undefined || match.index < p1) continue;
		const n = Number(match[1]);
		if (lastP >= 0 && n <= lastP) continue;
		const text = htmlToParagraph(match[2]);
		if (text) paragraphs.push(text);
		lastP = n;
	}
	if (!paragraphs.length) throw new Error(`章节「${fallbackTitle}」正文为空`);
	const headings = [chapterMatch?.[1], episodeMatch?.[1]].filter(Boolean).map((item) => decodeHtml(item!));
	return [...headings, ...paragraphs].join("\n\n");
}

/** 单个段落：剥标签、还原 ruby（rb（rt））、<br/> 转换行。 */
function htmlToParagraph(raw: string): string {
	return raw
		.replace(/<rp>（<\/rp>/g, "")
		.replace(/<rp>）<\/rp>/g, "")
		.replace(/<rp>\(<\/rp>/g, "")
		.replace(/<rp>\)<\/rp>/g, "")
		.replace(/<rb>/g, "")
		.replace(/<\/rb>/g, "")
		.replace(/<ruby[^>]*>/gi, "")
		.replace(/<\/ruby>/gi, "")
		.replace(/<rt[^>]*>/gi, "（")
		.replace(/<\/rt>/gi, "）")
		.replace(/<br\s*\/?\s*>/gi, "\n")
		.replace(/<[^>]+>/g, "")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/^[　\s]+|[　\s]+$/g, "")
		.trim();
}

export async function fetchKakuyomuWork(value: string, request: KakuyomuRequest, signal: AbortSignal, delayMs = 400): Promise<{ work: KakuyomuWork; text: string }> {
	const url = normalizeKakuyomuWorkUrl(value);
	const work = parseKakuyomuWork(await request(url, signal), url);
	const parts = [`${work.title}\n`, work.introduction ? `简介\n${work.introduction}\n` : ""];
	for (const chapter of work.chapters) {
		if (signal.aborted) throw new Error("已取消 Kakuyomu 抓取");
		try {
			const html = await request(new URL(chapter.url), signal);
			parts.push(parseKakuyomuEpisode(html, chapter.title));
		} catch (error) {
			if (signal.aborted) throw error;
			parts.push(`${chapter.title}\n（抓取失败：${error instanceof Error ? error.message : String(error)}）`);
		}
		if (delayMs > 0 && chapter.index + 1 < work.chapters.length) await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
	}
	return { work, text: parts.join("\n\n") };
}

export function kakuyomuDocumentId(url: string): string {
	return `doc-${createHash("sha256").update(`kakuyomu\n${url}`).digest("hex").slice(0, 16)}`;
}

/** 从 Kakuyomu 搜索页提取公开作品候选；只返回作品 URL，不读取正文。 */
export async function discoverKakuyomuWorks(
	queries: string[],
	request: KakuyomuRequest,
	signal: AbortSignal,
	options: { page?: number; maxResults?: number } = {},
): Promise<KakuyomuCandidate[]> {
	const seen = new Set<string>(), results: KakuyomuCandidate[] = [];
	const page = Math.max(1, Math.floor(options.page ?? 1));
	for (const query of queries.slice(0, 8)) {
		if (signal.aborted) throw new Error("已取消 Kakuyomu 搜索");
		const url = new URL("https://kakuyomu.jp/search");
		url.searchParams.set("q", query);
		if (page > 1) url.searchParams.set("page", String(page));
		const html = await request(url, signal);
		for (const match of html.matchAll(/<a\s+[^>]*href="(\/works\/[A-Za-z0-9_-]+)"[^>]*>/gi)) {
			const workUrl = `https://kakuyomu.jp${match[1]}`;
			if (seen.has(workUrl)) continue;
			seen.add(workUrl);
			const tag = match[0];
			const title = decodeHtml((/\btitle="([^"]+)"/i.exec(tag)?.[1] ?? "").trim());
			results.push({ url: workUrl, title: title.slice(0, 180), query });
			if (results.length >= (options.maxResults ?? 30)) return results;
		}
	}
	return results;
}
