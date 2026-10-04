import { createHash } from "node:crypto";
export type DeliveryChannel = "story" | "assistant" | "command";
export type SubmissionIdentity = { sessionId: string; messageId: string };
export function readSubmissionIdentity(frame: { sessionId?: unknown; messageId?: unknown }): SubmissionIdentity | "legacy" | "invalid" {
	if (frame.sessionId === undefined && frame.messageId === undefined) return "legacy";
	if (typeof frame.sessionId !== "string" || !frame.sessionId || frame.sessionId.length > 256 ||
		typeof frame.messageId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(frame.messageId)) return "invalid";
	return { sessionId: frame.sessionId, messageId: frame.messageId };
}
/** 有界进程内防重入；不声称跨服务器重启 exactly-once。剧情的重启去重以 user entry 为准。 */
export class PromptDeliveryLedger {
	readonly #records = new Map<string, { fingerprint: string; status: "pending" | "accepted" }>();
	private readonly limit: number;
	constructor(limit = 512) { this.limit = limit; }
	key(channel: DeliveryChannel, identity: SubmissionIdentity): string { return JSON.stringify([channel, identity.sessionId, identity.messageId]); }
	begin(channel: DeliveryChannel, identity: SubmissionIdentity, text: string): "new" | "pending" | "accepted" | "conflict" | "full" {
		const key = this.key(channel, identity), fingerprint = createHash("sha256").update(text).digest("hex");
		const current = this.#records.get(key);
		if (current) return current.fingerprint !== fingerprint ? "conflict" : current.status;
		while (this.#records.size >= this.limit) {
			const settled = [...this.#records].find(([, value]) => value.status === "accepted");
			if (!settled) return "full";
			this.#records.delete(settled[0]);
		}
		this.#records.set(key, { fingerprint, status: "pending" }); return "new";
	}
	hasPendingSessionPrefix(prefix: string): boolean {
		for (const [key, record] of this.#records) {
			if (record.status === "pending" && (JSON.parse(key)[1] as string).startsWith(prefix)) return true;
		}
		return false;
	}
	accept(channel: DeliveryChannel, identity: SubmissionIdentity): void { const item = this.#records.get(this.key(channel, identity)); if (item) item.status = "accepted"; }
	reject(channel: DeliveryChannel, identity: SubmissionIdentity): void { this.#records.delete(this.key(channel, identity)); }
}
/** 完整树含旁支；同文但不同 id 不去重。 */
export function findPersistedSubmission(entries: unknown[], messageId: string): { entryId: string; text: string } | undefined {
	for (const entry of entries) {
		if (!entry || typeof entry !== "object") continue;
		const e = entry as { id?: unknown; type?: unknown; message?: { role?: unknown; details?: unknown; content?: unknown } };
		if (e.type !== "message" || e.message?.role !== "user" || typeof e.id !== "string") continue;
		const details = e.message.details as { rpClientMessageId?: unknown } | undefined;
		if (details?.rpClientMessageId !== messageId) continue;
		const content = e.message.content;
		const text = typeof content === "string" ? content : Array.isArray(content)
			? content.map((part) => part?.type === "text" && typeof part.text === "string" ? part.text : "").join("") : "";
		return { entryId: e.id, text };
	}
	return undefined;
}
