/** Card-authored presentation is a model decision, not a whitelist of panel tag names. */
import type { CharacterCard, LorebookEntry } from "../types.ts";
import type { RpPreset } from "../preset.ts";

// This selects source documents, not permitted outputs. Unknown tags, HTML, Markdown,
// JSON and prose specifications remain valid; selected documents are never clipped.
const FORMAT_TITLE = /格式|输出|展示|排版|呈现|渲染|模板|日历|状态栏|选项|绘图|图片|插图|format|output|layout|presentation|calendar|NovelAI|NAI4/i;
const FORMAT_SOURCE = /(?:每次|每轮|每拍|每条).{0,35}(?:回复|输出|附|末尾)|(?:输出|display|format|render).{0,20}(?:格式|template|结构|schema)|<\/?(?:options|image(?:Tag)?)\b|FinalOutputFormat/i;
export interface AgentPresentationMaterials {
	version: 1;
	card: { name: string; description: string; personality: string; scenario: string; systemPrompt: string; postHistoryInstructions: string; mesExample: string; firstMes: string };
	universal: { inlineImages: true; actionOptions: true };
	sources: Array<{ id: string; title: string; content: string; formatCandidate?: boolean }>;
	sourceIndex: Array<{ id: string; title: string; chars: number }>;
	formatHints: string[];
}
export function buildAgentPresentationMaterials(input: {
	card: CharacterCard; entries: LorebookEntry[]; preset: RpPreset | null; statusBarFormats: string[]; activated?: LorebookEntry[];
}): AgentPresentationMaterials {
	const { card } = input;
	const enabled = input.entries.filter(entry => entry.enabled);
	const sources: AgentPresentationMaterials["sources"] = [];
	const sourceIndex: AgentPresentationMaterials["sourceIndex"] = [];
	for (const [index, entry] of enabled.entries()) {
		const id = `lore:${index}`, title = entry.comment || entry.keys[0] || `uid${entry.uid}`;
		sourceIndex.push({ id, title, chars: entry.content.length });
		if (entry.constant || input.activated?.includes(entry) || (FORMAT_TITLE.test(title) || FORMAT_SOURCE.test(entry.content))) sources.push({ id, title, content: entry.content, formatCandidate:FORMAT_TITLE.test(title)||FORMAT_SOURCE.test(entry.content) });
	}
	for (const [index, block] of (input.preset?.blocks ?? []).entries()) {
		if (!block.enabled) continue;
		const id = `preset:${index}`, title = block.name || block.id;
		sourceIndex.push({ id, title, chars: block.content.length });
		if ((FORMAT_TITLE.test(title) || FORMAT_SOURCE.test(block.content))) sources.push({ id, title, content: block.content, formatCandidate:true });
	}
	return {
		version: 1,
		card: { name: card.name, description: card.description, personality: card.personality, scenario: card.scenario,
			systemPrompt: card.systemPrompt, postHistoryInstructions: card.postHistoryInstructions, mesExample: card.mesExample, firstMes: card.firstMes },
		universal: { inlineImages: true, actionOptions: true }, sources, sourceIndex,
		formatHints: [...input.statusBarFormats],
	};
}

const IMAGE_BLOCK = /<(image(?:Tag)?)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
export function presentationPlainText(text: string): string {
	// Images and action proposals are presentation, never additional story facts.
	return text.replace(IMAGE_BLOCK, "").replace(/<options\b[^>]*>[\s\S]*?<\/options\s*>/gi, "")
		.replace(/<!--[^]*?-->/g, "").replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
		.replace(/<\/?[A-Za-z_][\w:.-]*(?:\s[^<>]*)?\s*\/?>/g, "")
		.replace(/&(?:amp|lt|gt|quot|apos|nbsp);/g, entity => ({ "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'", "&nbsp;": " " }[entity]!))
		.trim();
}
export function presentationFactText(text: string): string { return presentationPlainText(text).replace(/\s+/g, ""); }

export function presentationSegments(text:string): Array<{id:string;text:string}> {
	const pieces = text.match(/[\s\S]+?(?:[。！？!?][”’」』]*|\n[ \t]*\n+|$)/g) ?? [text];
	return pieces.filter(Boolean).map((text,index)=>({id:`n:${index}`,text}));
}
export function authoredImages(text:string): Array<{id:string;text:string}> {
	return [...text.matchAll(IMAGE_BLOCK)].map((match,index)=>({id:`image:${index}`,text:match[0]}));
}

export interface AgentPresentationDelivery {
	version: 1;
	body: string;
	formats: string;
	display: string;
	layout?: Array<{kind:"narrative"|"format";text:string}>;
	requirements: Array<{ name: string; kind: "actions" | "card-format"; id?:string; quote: string }>;
}
export type PresentationParseResult = { ok: true; delivery: AgentPresentationDelivery } | { ok: false; error: string };
export function parseAgentPresentation(text: string, frozenNarrative: string, authorDraft?: string, plan?: AgentPresentationPlan): PresentationParseResult {
	let row: Record<string, unknown>;
	try { row = JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/g, "")); }
	catch { return { ok: false, error: "格式交付不是完整有效的JSON对象" }; }
	if (row && typeof row === "object" && Array.isArray(row.layout)) {
		const segments=presentationSegments(frozenNarrative), images=authoredImages(authorDraft??"");
		let cursor=0,usedReferences=false;
		for(const item of row.layout){
			if(!item||typeof item!=="object")continue;
			// A complete image-only fragment remains presentation, even when the model labels it format.
			// Reclassify its placement, not its bytes; frozen narrative and original-image checks still apply.
			if(item.kind==="format"&&typeof item.text==="string"&&[...item.text.matchAll(IMAGE_BLOCK)].length&&presentationFactText(item.text)==="")item.kind="image";
			if(item.kind==="narrative"&&Array.isArray(item.refs)){
				usedReferences=true;let text="";
				for(const id of item.refs){if(segments[cursor]?.id!==id)return {ok:false,error:"正文引用必须完整、按原次序且恰好一次，不得遗漏、重排或重复原段"};text+=segments[cursor++].text;}
				item.text=text;
			}
			if(item.kind==="image"){
				if(typeof item.ref==="string"){const image=images.find(image=>image.id===item.ref);if(!image)return {ok:false,error:"图片引用不是本拍原作者已有的完整图片"};item.text=image.text;}
				if(typeof item.text!=="string"||![...item.text.matchAll(IMAGE_BLOCK)].length)return {ok:false,error:"图片布局项必须引用原图片或给出完整图片块"};
				item.kind="narrative";
			}
		}
		if(usedReferences&&cursor!==segments.length)return {ok:false,error:"卡格式交付遗漏了被冻结正文段"};

		if (!row.layout.length || row.layout.length > 100 || row.layout.some(part => !part || !["narrative","format"].includes(part.kind) || typeof part.text !== "string")) return {ok:false,error:"自由布局必须由有序narrative/format文本片段组成"};
		row.body = row.layout.filter(part => part.kind === "narrative").map(part => part.text).join("");
		row.formats = row.layout.filter(part => part.kind === "format").map(part => part.text).join("\n\n");
	}
	if (!row || typeof row !== "object" || Array.isArray(row) || typeof row.body !== "string" || typeof row.formats !== "string" || !Array.isArray(row.requirements)) return { ok: false, error: "格式交付缺少body/formats/requirements" };
	if (!presentationFactText(frozenNarrative) || presentationFactText(row.body) !== presentationFactText(frozenNarrative)) return { ok: false, error: "格式交付改变或遗漏了已冻结正文；narrative片段只能是frozen_narrative逐字正文及图片/展示容器，时间抬头、标题和其它可见文字必须放format片段，再按原顺序混排" };
	const body = row.body;
	const imageBlocks = [...body.matchAll(IMAGE_BLOCK)];
	if (!imageBlocks.length || !imageBlocks.some(match => {
		const before = presentationFactText(body.slice(0, match.index)), after = presentationFactText(body.slice(match.index! + match[0].length));
		return before.length > 0 && after.length > 0 && /\S/.test(match[0].replace(/<[^>]+>/g, ""));
	})) return { ok: false, error: "正文缺少完整且穿插于叙事中的图片块；末尾单独堆图不算正文穿插" };
	if (authorDraft) {
		const priorImages = [...authorDraft.matchAll(IMAGE_BLOCK)].map(match => match[0]);
		let cursor = 0;
		for (const image of priorImages) { const at = body.indexOf(image,cursor); if (at < 0) return {ok:false,error:"遗漏或改写了主作者已有的完整图片块，必须保留原始图片内容及先后次序"}; cursor = at + image.length; }
	}
	const output = Array.isArray(row.layout) ? row.layout.map(part => part.text).join("") : `${row.body}\n\n${row.formats}`;
	const requirements: AgentPresentationDelivery["requirements"] = [];
	for (const requirement of row.requirements) {
		// Known image evidence aliases are validated against the actual delivered image, never trusted by label.
		if(requirement&&["image","inline-images"].includes(requirement.kind)&&typeof requirement.quote==="string"&&[...requirement.quote.matchAll(IMAGE_BLOCK)].length&&presentationFactText(requirement.quote)===""&&body.includes(requirement.quote))requirement.kind="card-format";
		if (!requirement || typeof requirement.name !== "string" || !["actions", "card-format"].includes(requirement.kind) || typeof requirement.quote !== "string" || requirement.quote.trim().length < 3 || !output.includes(requirement.quote)) return { ok: false, error: "格式核对项必须引用本次实际交付的逐字片段，不能只声称已输出" };
		requirements.push({ name: requirement.name, kind: requirement.kind, ...(typeof requirement.id==="string"?{id:requirement.id}:{}), quote: requirement.quote });
	}
	if (!requirements.some(requirement => requirement.kind === "actions")) return { ok: false, error: "缺少可核对的行动选项；采用当前卡定义，未定义时使用options" };
	if(plan)for(const requirement of plan.requirements){
		if(!requirement.required)continue;
		if(!requirements.some(item=>item.id===requirement.id))return {ok:false,error:`遗漏本拍适用格式：${requirement.name}（${requirement.id}），需按已读原文交付，不得删除需求或只给空壳`};
		if(requirement.locator){
			const {kind,value}=requirement.locator;
			const escaped=value.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
			const present=kind==="literal"?output.includes(value):new RegExp(`<${escaped}\\b[^>]*>[\\s\\S]*?<\\/${escaped}\\s*>`,"i").test(output);
			if(!present)return {ok:false,error:`缺少当前卡要求的实际格式：${requirement.name}；原文所指${kind==="pair-tag"?"完整标签块":"标记"} ${value} 未交付`};
		}
	}
	if (Array.isArray(row.missing) && row.missing.length) return { ok: false, error: "主Agent报告仍有未交付的卡格式" };
	return { ok: true, delivery: { version: 1, body: row.body.trim(), formats: row.formats.trim(), display:output.trim(), ...(Array.isArray(row.layout) ? {layout:row.layout} : {}), requirements } };
}

export interface PresentationDeliveryView { status:"complete"|"pending"; inputSourceCount?:number; inputChars?:number; formatNames?:string[]; retryCount?:number }
export function presentationDeliveryView(value: unknown): PresentationDeliveryView | undefined {
	if(!value||typeof value!=="object"||Array.isArray(value))return undefined;
	const row=value as Record<string,unknown>;
	if(!["complete","pending"].includes(String(row.status)))return undefined;
	return {status:row.status as "complete"|"pending",inputSourceCount:Math.max(0,Math.min(2000,Number(row.inputSourceCount)||0)),inputChars:Math.max(0,Math.min(4000000,Number(row.inputChars)||0)),retryCount:Math.max(0,Math.min(4,Number(row.retryCount)||0)),formatNames:Array.isArray(row.formatNames)?row.formatNames.filter(x=>typeof x==="string").slice(0,40).map(x=>x.slice(0,80)):[]};
}

export interface AgentPresentationPlan {
	requirements:Array<{id:string;name:string;required:boolean;sourceIds:string[];quote:string;locator?:{kind:"pair-tag"|"literal";value:string}}>;
	sourceReviews:Array<{id:string;requirementIds:string[];reason:string}>;
}
export function parseAgentPresentationPlan(text:string, materials:AgentPresentationMaterials): {ok:true;plan:AgentPresentationPlan}|{ok:false;error:string} {
	let row:Record<string,unknown>;
	try{row=JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/g,""));}catch{return {ok:false,error:"卡格式需求识别不是完整JSON"};}
	if(!row||!Array.isArray(row.requirements)||!Array.isArray(row.sourceReviews))return {ok:false,error:"需求识别缺少requirements/sourceReviews"};
	const requirements:AgentPresentationPlan["requirements"]=[];
	for(const item of row.requirements){
		if(!item||typeof item.id!=="string"||!item.id||requirements.some(x=>x.id===item.id)||typeof item.name!=="string"||!item.name||typeof item.required!=="boolean"||!Array.isArray(item.sourceIds)||!item.sourceIds.length||typeof item.quote!=="string"||item.quote.length<3)return {ok:false,error:"卡格式需求缺少唯一id、适用条件或可追溯的原始规则"};
		if(item.sourceIds.some((id:unknown)=>typeof id!=="string"||!materials.sources.some(source=>source.id===id))||!materials.sources.some(source=>item.sourceIds.includes(source.id)&&source.content.includes(item.quote)))return {ok:false,error:`需求 ${item.id}（${item.name}）的来源或引句不在指定原文中：只引用该来源已有的短标记/短句，不能改写成摘要或把说明拼在标签后面`};
		if(item.locator){
			if(!["pair-tag","literal"].includes(item.locator.kind)||typeof item.locator.value!=="string"||!item.locator.value||item.locator.value.length>120||!materials.sources.some(source=>item.sourceIds.includes(source.id)&&source.content.includes(item.locator.value)))return {ok:false,error:"需求输出标记不是所引用原始规则中的实际标签/标记"};
			if(item.locator.kind==="pair-tag"&&!/^[A-Za-z_\u4e00-\u9fff][\w:.-\u4e00-\u9fff]*$/.test(item.locator.value))return {ok:false,error:"格式标签名无效"};
		}
		requirements.push({id:item.id,name:item.name,required:item.required,sourceIds:item.sourceIds,quote:item.quote,...(item.locator?{locator:item.locator}:{})});
	}
	const sourceReviews:AgentPresentationPlan["sourceReviews"]=[];
	for(const item of row.sourceReviews){
		if(!item||typeof item.id!=="string"||!materials.sources.some(source=>source.id===item.id)||sourceReviews.some(x=>x.id===item.id)||!Array.isArray(item.requirementIds)||item.requirementIds.some((id:unknown)=>!requirements.some(x=>x.id===id&&x.sourceIds.includes(item.id)))||typeof item.reason!=="string"||!item.reason.trim())return {ok:false,error:"格式来源逐项检查缺失、重复或无法追溯"};
		sourceReviews.push({id:item.id,requirementIds:item.requirementIds,reason:item.reason});
	}
	for(const requirement of requirements)for(const id of requirement.sourceIds)if(!sourceReviews.some(review=>review.id===id&&review.requirementIds.includes(requirement.id)))return {ok:false,error:`需求 ${requirement.id} 没有关联回实际来源 ${id} 的sourceReviews`};
	for(const source of materials.sources.filter(source=>source.formatCandidate))if(!sourceReviews.some(item=>item.id===source.id))return {ok:false,error:`尚未读取并核对格式来源：${source.title}（${source.id}）`};
	return {ok:true,plan:{requirements,sourceReviews}};
}
