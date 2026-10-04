import { errText, intArg, type ToolSpec } from "./registry.ts";

export interface WebResearchResult {
	title: string;
	url: string;
	snippet: string;
}

export interface WebResearchItem {
	query: string;
	results?: WebResearchResult[];
	error?: string;
	rejected?: string;
}

export interface WebResearchDeps {
	webResearch?: (queries: string[], maxResults: number) => Promise<WebResearchItem[]>;
}

const queriesOf = (value: unknown): string[] => {
	if (!Array.isArray(value)) return [];
	return [...new Set(value
		.filter((item): item is string => typeof item === "string")
		.map((item) => item.replace(/\s+/g, " ").trim())
		.filter((item) => item.length >= 2 && item.length <= 160))]
		.slice(0, 3);
};

export const webResearchTool: ToolSpec<WebResearchDeps> = {
	name: "web_research",
	domain: "research",
	mode: "read",
	surfaces: ["stage"],
	label: "联网查证",
	description: () =>
		"按需检索最多三个外部事实问题。只在现实、原作、历史、法律、医学、技术或地点事实会影响本拍时使用；普通情感互动不必联网。原创或私人角色不得把角色名、卡片原文、对话或用户隐私发送到互联网。",
	parameters: () => ({
		type: "object",
		properties: {
			queries: {
				type: "array",
				minItems: 1,
				maxItems: 3,
				items: { type: "string", minLength: 2, maxLength: 160 },
				description: "一至三个彼此不同、可独立回答的公开事实查询",
			},
			max_results_per_query: { type: "integer", minimum: 1, maximum: 5, default: 3 },
		},
		required: ["queries"],
		additionalProperties: false,
	}),
	async run(args, deps) {
		const queries = queriesOf(args.queries);
		if (!queries.length) return { text: "没有可安全执行的联网查询。请给出一至三个简短的公开事实问题。" };
		if (!deps.webResearch) return { text: "当前环境没有启用联网查证。" };
		try {
			const rows = await deps.webResearch(queries, intArg(args, "max_results_per_query", 3, 1, 5));
			const sections = rows.map((row) => {
				if (row.rejected) return `【Web Research】\n查询：${row.query}\n已拒绝：${row.rejected}`;
				if (row.error) return `【Web Research】\n查询：${row.query}\n失败：${row.error}`;
				const results = row.results ?? [];
				if (!results.length) return `【Web Research】\n查询：${row.query}\n没有找到可用结果。`;
				return `【Web Research】\n查询：${row.query}\n${results.map((result, index) => `${index + 1}. ${result.title}\n   URL: ${result.url}\n   摘要：${result.snippet}`).join("\n")}`;
			});
			return { text: sections.join("\n\n"), activity: `联网查证 ${rows.length} 项`, details: rows };
		} catch (error) {
			return { text: `联网查证失败：${errText(error)}` };
		}
	},
};

export const webResearchTools = [webResearchTool];

export function wantsManualWebResearch(value: string): boolean {
	return /(?:联网|上网|网上|网络|网页|web|百度|谷歌|google)\s*(?:搜索|搜|检索|查|查证|查资料)?|(?:搜索|搜|检索|查证|查)\s*(?:一下|一查|下)?\s*(?:网络|网上|网页|公开资料|现实资料)/i.test(value);
}
