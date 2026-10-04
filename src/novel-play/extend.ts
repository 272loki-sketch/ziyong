import type { NovelPackage } from "./canon.ts";
import { buildNovelPackage } from "./canon.ts";
import { extractNovelEvents, type NovelExtractionModelCall } from "./extract.ts";
import { novelNodeId, type NovelSource } from "./source.ts";
import type { StoredNovelPackage } from "./store.ts";

export interface ExtendNovelPackageInput {
	base: StoredNovelPackage;
	target: { source: NovelSource; packageDocId: string };
	skillBody: string;
	modelCall: NovelExtractionModelCall;
	signal?: AbortSignal;
	onProgress?: (completed: number, total: number) => void;
}

/**
 * Builds an immutable append-only successor when the existing chunk boundary is
 * preserved. We intentionally reject boundary reshaping instead of guessing a
 * mapping for old evidence and progress.
 */
export async function extendNovelPackage(input: ExtendNovelPackageInput): Promise<NovelPackage> {
	const { base, target } = input;
	if (base.package.version !== 1 || target.source.version !== 1) throw new Error("不支持的小说作品包版本");
	if (base.source.docId === target.source.docId) throw new Error("追加版本必须使用新的原文文档");
	if (base.source.chunkChars !== target.source.chunkChars) throw new Error("追加版本的分块大小不一致");
	if (target.source.chunks.length <= base.source.chunks.length) throw new Error("新版没有新增原文分块");
	for (let index = 0; index < base.source.chunks.length; index++) {
		const oldChunk = base.source.chunks[index]!;
		const newChunk = target.source.chunks[index];
		if (!newChunk || oldChunk.text !== newChunk.text) throw new Error("新版原文改变了旧作品包的分块边界，不能安全增量提取");
	}
	const inherited = base.package.nodes.map(node => ({
		...node,
		dependsOn: [...node.dependsOn],
		sourceRefs: node.sourceRefs.map(ref => ({ ...ref })),
	}));
	const suffixSource: NovelSource = {
		...target.source,
		chunks: target.source.chunks.slice(base.source.chunks.length),
	};
	const extracted = await extractNovelEvents(suffixSource, {
		modelCall: input.modelCall,
		skillBody: input.skillBody,
		signal: input.signal,
		maxAttempts: 2,
		onCheckpoint: checkpoint => input.onProgress?.(Object.keys(checkpoint.completed).length, suffixSource.chunks.length),
	});
	const stageOffset = base.package.stages.length;
	const stages = [
		...base.package.stages.map(stage => ({ ...stage })),
		...extracted.package.stages.map(stage => ({ ...stage, id: `extension-${stage.id}`, order: stage.order + stageOffset })),
	];
	const orderOffset = inherited.reduce((max, node) => Math.max(max, node.order), -1) + 1;
	const remapped = extracted.package.nodes.map(node => {
		const sourceRefs = node.sourceRefs.map(ref => ({ ...ref }));
		return {
			...node,
			stageId: `extension-${node.stageId}`,
			order: node.order + orderOffset,
			id: novelNodeId(target.source, sourceRefs[0]!, node.key),
			dependsOn: [...node.dependsOn],
			sourceRefs,
		};
	});
	const idMap = new Map(extracted.package.nodes.map((node, index) => [node.id, remapped[index]!.id]));
	const newNodes = remapped.map(node => ({ ...node, dependsOn: node.dependsOn.map(id => idMap.get(id) ?? id) }));
	const allNodes = [...inherited, ...newNodes];
	return buildNovelPackage(target.source, stages, allNodes, {
		parentDocId: base.source.docId,
		parentRevision: base.package.revision,
		relation: "append-only",
		inheritedNodeIds: inherited.map(node => node.id),
		newNodeIds: newNodes.map(node => node.id),
	});
}
