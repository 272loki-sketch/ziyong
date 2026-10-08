import assert from "node:assert/strict";
import test from "node:test";
import {
	authoredImages,
	parseAgentPresentation,
	parseAgentPresentationPlan,
	presentationSegments,
	type AgentPresentationMaterials,
	type AgentPresentationPlan,
} from "../src/stage/agent-presentation.ts";

// Module-only synthetic data. No card files, configuration, Skills, API or model.
const FROZEN = "她翻开登记册。\n\n他指向灯塔。";
const IMAGE_A = '<image data-id="original-a">image### synthetic lamp, original seed 17 ###</image>';
const IMAGE_B = '<imageTag data-id="original-b">\nsynthetic harbor, original seed 29\n</imageTag>';
const AUTHOR = `她翻开登记册。${IMAGE_A}\n\n他指向灯塔。`;
const HEADER = '<header class="synthetic-time">清晨 06:40 · 码头</header>';
const SIDECAR = '<scene_sidecar data-round="one">场景备忘：登记册已打开。</scene_sidecar>';
const FORUM = '<forum_widget data-topic="harbor">匿名留言：灯塔今晚值守。</forum_widget>';
const HTML = '<section data-view="free"><b>自由 HTML</b></section>';
const MARKDOWN = "\n## 自由 Markdown\n- **天气**：薄雾\n";
const JSON_FORMAT = '{"view":"[view.v2+]","visible":true}';
const OPTIONS = "<options>1. 核对记录\n2. 查看灯塔</options>";
const segments = presentationSegments(FROZEN);
const first = segments[0]!.text;
const rest = segments.slice(1).map(segment => segment.text).join("");

function layoutReply() {
	return {
		layout: [
			{ kind: "format", text: HEADER },
			{ kind: "narrative", refs: ["n:0"] },
			{ kind: "image", ref: "image:0" },
			{ kind: "format", text: SIDECAR },
			{ kind: "narrative", refs: segments.slice(1).map(segment => segment.id) },
			{ kind: "format", text: [FORUM, HTML, MARKDOWN, JSON_FORMAT, OPTIONS].join("\n") },
		] as Array<{ kind: string; refs?: string[]; ref?: string; text?: string }>,
		requirements: [
			{ id: "r:sidecar", name: "场景备忘", kind: "card-format", quote: SIDECAR },
			{ id: "r:forum", name: "合成留言区", kind: "card-format", quote: FORUM },
			{ id: "r:json", name: "自由JSON", kind: "card-format", quote: JSON_FORMAT },
			{ id: "r:actions", name: "合成行动", kind: "actions", quote: OPTIONS },
		],
		missing: [] as string[],
	};
}
const parseLayout = (row = layoutReply(), author = AUTHOR, plan?: AgentPresentationPlan) =>
	parseAgentPresentation(JSON.stringify(row), FROZEN, author, plan);
const expectRejected = (result: { ok: boolean }, label: string) => assert.equal(result.ok, false, label);

function materials(): AgentPresentationMaterials {
	const sources = [
		{ id: "book:sidecar", title: "合成场景备忘格式", content: "每拍输出完整 <scene_sidecar>场景备忘</scene_sidecar>。", formatCandidate: true },
		{ id: "book:forum", title: "合成留言区格式", content: "每拍输出完整 <forum_widget>匿名留言</forum_widget>，不可省略论坛区。", formatCandidate: true },
		{ id: "book:json", title: "自由JSON定义", content: "JSON区域包含字面标记 [view.v2+]，保留任意其他JSON字段。", formatCandidate: true },
		{ id: "book:actions", title: "合成行动格式", content: "每拍附行动选项 <options>1. 核对记录\n2. 查看灯塔</options>。", formatCandidate: true },
		{ id: "book:html", title: "可选HTML定义", content: "可选附 <section>自由HTML</section>，当前场景不强制。", formatCandidate: true },
		{ id: "book:markdown", title: "可选Markdown定义", content: "可选附 ## 场景备忘 与项目列表，不强制每拍出现。", formatCandidate: true },
		{ id: "book:world", title: "合成地理事实", content: "灯塔在码头东侧。", formatCandidate: false },
	];
	return {
		version: 1,
		card: { name: "合成观测员", description: "", personality: "", scenario: "", systemPrompt: "", postHistoryInstructions: "", mesExample: "", firstMes: "" },
		universal: { inlineImages: true, actionOptions: true }, sources,
		sourceIndex: [...sources.map(source => ({ id: source.id, title: source.title, chars: source.content.length })),
			{ id: "book:unread", title: "未送达原书", chars: 500 }],
		formatHints: [],
	};
}

function planReply(): AgentPresentationPlan {
	return {
		requirements: [
			{ id: "r:sidecar", name: "场景备忘", required: true, sourceIds: ["book:sidecar"], quote: "每拍输出完整 <scene_sidecar>场景备忘</scene_sidecar>", locator: { kind: "pair-tag", value: "scene_sidecar" } },
			{ id: "r:forum", name: "合成留言区", required: true, sourceIds: ["book:forum"], quote: "不可省略论坛区", locator: { kind: "pair-tag", value: "forum_widget" } },
			{ id: "r:json", name: "自由JSON", required: true, sourceIds: ["book:json"], quote: "JSON区域包含字面标记 [view.v2+]", locator: { kind: "literal", value: "[view.v2+]" } },
			{ id: "r:actions", name: "合成行动", required: true, sourceIds: ["book:actions"], quote: "每拍附行动选项", locator: { kind: "pair-tag", value: "options" } },
			{ id: "r:optional-html", name: "可选HTML", required: false, sourceIds: ["book:html"], quote: "当前场景不强制", locator: { kind: "pair-tag", value: "section" } },
		],
		sourceReviews: [
			{ id: "book:sidecar", requirementIds: ["r:sidecar"], reason: "required" },
			{ id: "book:forum", requirementIds: ["r:forum"], reason: "required" },
			{ id: "book:json", requirementIds: ["r:json"], reason: "required" },
			{ id: "book:actions", requirementIds: ["r:actions"], reason: "required" },
			{ id: "book:html", requirementIds: ["r:optional-html"], reason: "optional" },
			{ id: "book:markdown", requirementIds: [], reason: "not applicable this turn" },
		],
	};
}
const parsePlan = (row: unknown = planReply(), source = materials()) => parseAgentPresentationPlan(JSON.stringify(row), source);

function validatedPlan(): AgentPresentationPlan {
	const result = parsePlan();
	assert.equal(result.ok, true);
	if (!result.ok) throw new Error(result.error);
	return result.plan;
}

test("presentationSegments 保留原字、空白、标点及次序，生成连续n引用", () => {
	for (const frozen of [FROZEN, "  她说：“真的！？”\r\n\r\n他点头。尾句没有标点\t \n", "无标点\n\n  第二段\t", ""]) {
		const pieces = presentationSegments(frozen);
		assert.equal(pieces.map(piece => piece.text).join(""), frozen);
		assert.deepEqual(pieces.map(piece => piece.id), pieces.map((_, index) => `n:${index}`));
	}
});

test("authoredImages 保留完整原图内容/属性/空白，并按原次序生成image引用", () => {
	assert.deepEqual(authoredImages(`${AUTHOR}\n${IMAGE_B}`), [
		{ id: "image:0", text: IMAGE_A }, { id: "image:1", text: IMAGE_B },
	]);
	assert.deepEqual(authoredImages("前文<image>未闭合尾图"), []);
});

test("Ref自由布局逐字复用正文和原图，format可在前中后，HTML/Markdown/JSON不被白名单剥除", () => {
	const result = parseLayout();
	assert.equal(result.ok, true);
	if (!result.ok) return;
	assert.equal(result.delivery.body, first + IMAGE_A + rest);
	assert.equal(result.delivery.display, HEADER + first + IMAGE_A + SIDECAR + rest + [FORUM, HTML, MARKDOWN, JSON_FORMAT, OPTIONS].join("\n"));
	for (const format of [HEADER, SIDECAR, FORUM, HTML, MARKDOWN, JSON_FORMAT, OPTIONS]) assert.ok(result.delivery.formats.includes(format));
	assert.ok(!result.delivery.body.includes(HEADER), "time/title text belongs to format, not narrative");
	assert.equal(result.delivery.layout?.[2]?.text, IMAGE_A);
});

test("narrative.refs 不得重复、遗漏、倒序或引用不存在的n段", () => {
	const ids = segments.map(segment => segment.id);
	for (const [label, refs] of [
		["重复", [...ids, ids[0]!]], ["遗漏", ids.slice(0, -1)],
		["倒序", [...ids].reverse()], ["未知引用", ["n:404", ...ids.slice(1)]],
	] as Array<[string, string[]]>) {
		const row = layoutReply();
		row.layout = [{ kind: "narrative", refs }, { kind: "image", ref: "image:0" }, { kind: "format", text: OPTIONS }];
		expectRejected(parseLayout(row), label);
	}
});

test("时间抬头不可混入正文，引用不能改词，传统body改词也拒绝", () => {
	const headerInNarrative = layoutReply();
	headerInNarrative.layout[0] = { kind: "narrative", text: HEADER };
	expectRejected(parseLayout(headerInNarrative), "可见时间不能当冻结正文");
	const forgedRefText = layoutReply();
	forgedRefText.layout[1]!.text = "她销毁登记册。";
	const restored = parseLayout(forgedRefText);
	assert.equal(restored.ok, true);
	if (restored.ok) assert.equal(restored.delivery.body, first + IMAGE_A + rest, "ref renders original words, never model-supplied replacement text");
	const rewritten = { body: (first + IMAGE_A + rest).replace("翻开", "销毁"), formats: OPTIONS,
		requirements: [{ name: "行动", kind: "actions", quote: OPTIONS }], missing: [] };
	expectRejected(parseAgentPresentation(JSON.stringify(rewritten), FROZEN, AUTHOR), "正文不改词");
});

test("图片前后必须有冻结正文，前后只有时间/格式文字不能充当叙事", () => {
	for (const placement of ["before", "after"] as const) {
		const row = layoutReply();
		const narrative = { kind: "narrative", refs: segments.map(segment => segment.id) };
		const image = { kind: "image", ref: "image:0" };
		row.layout = [{ kind: "format", text: HEADER }, ...(placement === "before" ? [image, narrative] : [narrative, image]), { kind: "format", text: OPTIONS }];
		expectRejected(parseLayout(row), placement);
	}
});

test("原作者完整图片不可遗漏、改写或交换次序，image.ref必须来自本拍authorDraft", () => {
	const author = `${AUTHOR}\n${IMAGE_B}`;
	const valid = layoutReply();
	valid.layout.splice(3, 0, { kind: "image", ref: "image:1" });
	const success = parseLayout(valid, author);
	assert.equal(success.ok, true);
	if (success.ok) assert.ok(success.delivery.body.includes(IMAGE_A + IMAGE_B));
	expectRejected(parseLayout(layoutReply(), author), "遗漏第二幅原图");
	const rewritten = layoutReply();
	rewritten.layout[2] = { kind: "image", text: IMAGE_A.replace("seed 17", "seed 88") };
	expectRejected(parseLayout(rewritten), "图内容改写");
	const unknown = layoutReply();
	unknown.layout[2] = { kind: "image", ref: "image:404" };
	expectRejected(parseLayout(unknown), "未知原图引用");
	const reversed = layoutReply();
	reversed.layout[2] = { kind: "image", ref: "image:1" };
	reversed.layout.splice(3, 0, { kind: "image", ref: "image:0" });
	expectRejected(parseLayout(reversed, author), "原图次序倒置");
});

test("原文计划完整核对六个formatCandidate，非格式事实来源无需假造需求", () => {
	const result = parsePlan();
	assert.equal(result.ok, true);
	if (!result.ok) return;
	assert.deepEqual(result.plan, planReply());
	assert.equal(result.plan.sourceReviews.length, 6);
	assert.ok(!result.plan.sourceReviews.some(review => review.id === "book:world"));
	assert.equal(parseLayout(layoutReply(), AUTHOR, result.plan).ok, true);
});

test("原文计划拒绝未送达sourceIds、非原文quote、非原书locator、重复或无效需求", () => {
	const alterations: Array<[string, (row: any) => void]> = [
		["未知来源", row => { row.requirements[0].sourceIds = ["missing"]; }],
		["索引有而正文未送达", row => { row.requirements[0].sourceIds = ["book:unread"]; }],
		["引句改写", row => { row.requirements[0].quote = "模型自行概括的场景规范"; }],
		["引句来自未引用的另一书", row => { row.requirements[0].quote = "不可省略论坛区"; }],
		["伪造locator", row => { row.requirements[0].locator.value = "invented_widget"; }],
		["伪造literal", row => { row.requirements[2].locator.value = "[view.v3+]"; }],
		["重复需求id", row => { row.requirements[1].id = row.requirements[0].id; }],
		["未列来源", row => { row.requirements[0].sourceIds = []; }],
		["非布尔适用条件", row => { row.requirements[0].required = "true"; }],
	];
	for (const [label, alter] of alterations) {
		const row = planReply(); alter(row);
		expectRejected(parsePlan(row), label);
	}
});

test("sourceReviews完整检查：漏论坛等candidate、重复、未知、错误关联或空理由均拒绝", () => {
	const alterations: Array<[string, (row: any) => void]> = [
		["只核对五项漏论坛", row => { row.sourceReviews = row.sourceReviews.filter((review: any) => review.id !== "book:forum"); }],
		["重复来源核对", row => { row.sourceReviews.push(row.sourceReviews[0]); }],
		["未知核对来源", row => { row.sourceReviews[0].id = "book:unread"; }],
		["需求不属于此原书", row => { row.sourceReviews[0].requirementIds = ["r:forum"]; }],
		["不存在的需求", row => { row.sourceReviews[0].requirementIds = ["r:invented"]; }],
		["空核对理由", row => { row.sourceReviews[0].reason = "  "; }],
	];
	for (const [label, alter] of alterations) {
		const row = planReply(); alter(row);
		expectRejected(parsePlan(row), label);
	}
});

test("sourceReviews不能漏列已引用该原书的需求而声称核对完整", () => {
	const row = planReply();
	row.sourceReviews.find(review => review.id === "book:forum")!.requirementIds = [];
	expectRejected(parsePlan(row), "r:forum已声明来自book:forum，该来源核对必须关联此需求");
});

test("计划required自定义块必须实际完整存在，报id/quote或只有开标签不能代替论坛/备忘交付", () => {
	const plan = validatedPlan();
	for (const [id, block, tag] of [["r:sidecar", SIDECAR, "scene_sidecar"], ["r:forum", FORUM, "forum_widget"]]) {
		for (const replacement of [`${tag} 已核对`, `<${tag}>未闭合内容`]) {
			const row = layoutReply();
			for (const part of row.layout) if (part.text) part.text = part.text.replace(block!, replacement);
			row.requirements.find(requirement => requirement.id === id)!.quote = replacement;
			expectRejected(parseLayout(row, AUTHOR, plan), `${tag}:${replacement}`);
		}
	}
	const missingClaim = layoutReply();
	missingClaim.requirements = missingClaim.requirements.filter(requirement => requirement.id !== "r:forum");
	expectRejected(parseLayout(missingClaim, AUTHOR, plan), "论坛实块存在但需求核对声明遗漏");
});

test("literal按原书动态值校验；可选格式不强制，其他自由HTML/Markdown/JSON逐字保留", () => {
	const plan = validatedPlan();
	const changed = layoutReply();
	changed.layout.at(-1)!.text = changed.layout.at(-1)!.text!.replace("[view.v2+]", "[view.v3+]");
	changed.requirements.find(requirement => requirement.id === "r:json")!.quote = JSON_FORMAT.replace("[view.v2+]", "[view.v3+]");
	expectRejected(parseLayout(changed, AUTHOR, plan), "仅格式实际literal改错也不能通过");
	const withoutOptional = layoutReply();
	withoutOptional.layout.at(-1)!.text = withoutOptional.layout.at(-1)!.text!.replace(HTML, "");
	assert.equal(parseLayout(withoutOptional, AUTHOR, plan).ok, true, "required=false does not force the optional HTML");
	const free = parseLayout(layoutReply(), AUTHOR, plan);
	assert.equal(free.ok, true);
	if (free.ok) for (const text of [HTML, MARKDOWN, JSON_FORMAT]) assert.ok(free.delivery.display.includes(text));
});

test("交付requirements须引用本次真实输出，不能虚报actions或missing已清空", () => {
	const fakeQuote = layoutReply();
	fakeQuote.requirements.at(-1)!.quote = "未实际输出的行动选项";
	expectRejected(parseLayout(fakeQuote), "虚假output引句");
	const noActions = layoutReply();
	noActions.requirements = noActions.requirements.filter(requirement => requirement.kind !== "actions");
	expectRejected(parseLayout(noActions), "缺actions核对项");
	const missing = layoutReply();
	missing.missing = ["forum_widget"];
	expectRejected(parseLayout(missing), "仍报告missing不算完整交付");
});

test('actual complete image fragments and image-evidence aliases normalize without rewriting author bytes',()=>{
 const image='<image>synthetic adult clockmaker, dusk</image>';
 const row={layout:[{kind:'narrative',text:'她翻开登记册。'},{kind:'format',text:image},{kind:'narrative',text:'\n\n他指向灯塔。'},{kind:'format',text:'<options>继续核对</options>'}],requirements:[{name:'穿插图片',kind:'inline-images',quote:image},{name:'选项',kind:'actions',quote:'<options>继续核对</options>'}],missing:[]};
 const result=parseAgentPresentation(JSON.stringify(row),FROZEN);assert.equal(result.ok,true);
 if(result.ok){assert.ok(result.delivery.body.includes(image));assert.equal(result.delivery.requirements[0].kind,'card-format');}
 row.requirements[0].quote='<image>not actually delivered</image>';
 assert.equal(parseAgentPresentation(JSON.stringify(row),FROZEN).ok,false,'an image label must never manufacture actual delivery evidence');
});
