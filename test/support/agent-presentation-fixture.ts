import { extractPureTextNarrative } from "../../src/stage/engine.ts";
/** Synthetic provider fixture for the shared presentation phase, never production output. */
export function presentationFixtureReply(context: { messages: unknown[] }): { text: string } | undefined {
	for (const message of context.messages as Array<{role?:string;content?:Array<{type?:string;text?:string}>}>) {
		if (message.role !== "user") continue;
		for (const part of message.content ?? []) {
			if (part.type !== "text" || !part.text) continue;
			let input: Record<string,unknown>;
			try { input = JSON.parse(part.text); } catch { continue; }
			if(input.phase==="presentation-plan"){
				const materials=input.materials as {sources:Array<{id:string;formatCandidate?:boolean}>};
				return {text:JSON.stringify({requirements:[],sourceReviews:materials.sources.filter(source=>source.formatCandidate).map(source=>({id:source.id,requirementIds:[],reason:"合成fixture仅检查通用图片和选项"}))})};
			}
			if (input.phase === "author-boundary" && typeof input.author_draft === "string") return {text:JSON.stringify({fragments:[extractPureTextNarrative(input.author_draft)]})};
			if (input.phase !== "agent-presentation" || typeof input.frozen_narrative !== "string") continue;
			const source = input.frozen_narrative;
			const paragraph = source.indexOf("\n\n"), stop = source.indexOf("。");
			const index = paragraph > 0 ? paragraph : stop >= 0 && stop + 1 < source.length ? stop + 1 : Math.max(1,Math.floor(source.length / 2));
			const image = "<image>image### neutral fictional scene ###</image>";
			const options = "<options>1. 继续核对资料\n2. 观察周围</options>";
			return {text:JSON.stringify({body:source.slice(0,index)+image+source.slice(index),formats:options,
				requirements:[{name:"行动选项",kind:"actions",quote:options}],missing:[]})};
		}
	}
	return undefined;
}
