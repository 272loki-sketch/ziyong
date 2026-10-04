import { createHash } from "node:crypto";
import type { MemoryScope, RpEventDigest } from "./types.ts";

/** 归一化事件文本，避免模型只改变标点就生成新事件。 */
export function normalizeEventKey(value: string): string {
	return value.normalize("NFKC").toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "").slice(0, 240);
}

/**
 * 事件 ID 的唯一生成入口：作用域 + 首个来源条目 + 标题/来源键。
 * 模型给出的 id 只作为兼容输入，不作为 canonical id。
 */
export function canonicalEventId(scope: MemoryScope, event: Pick<RpEventDigest, "id" | "title" | "sourceRefs"> & { sourceKey?: string }): string {
	const source = event.sourceRefs[0]?.entryId || event.sourceKey || event.id || event.title;
	const seed = [scope.sessionId, scope.card || "", source, normalizeEventKey(event.title)].join("|");
	return `event_${createHash("sha1").update(seed).digest("hex").slice(0, 16)}`;
}
