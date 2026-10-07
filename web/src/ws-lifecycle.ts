import { isGenerationMode, resolveGenerationMode, type GenerationMode } from "./generation-mode.ts";

export const WS_RETRY_INITIAL_MS = 1_500;
export const WS_RETRY_MAX_MS = 10_000;
export const WS_HELLO_TIMEOUT_MS = 10_000;
export const WS_SESSIONS_MIN_INTERVAL_MS = 1_000;

export type SafeReadRequestType = "sessions" | "assistant_sessions" | "assistant_sync";
export type SafeReadRequestLane = "story" | "assistant";
const SAFE_READ_LANES: Record<SafeReadRequestType, SafeReadRequestLane> = {
	sessions: "story",
	assistant_sessions: "assistant",
	assistant_sync: "assistant",
};

/** Exact allowlist: all other client frames remain immediate-only controls/writes. */
export function isSafeReadRequest(type: string): type is SafeReadRequestType {
	return Object.hasOwn(SAFE_READ_LANES, type);
}

export function safeReadRequestLane(type: SafeReadRequestType): SafeReadRequestLane {
	return SAFE_READ_LANES[type];
}

/** Non-read assistant frames require assistant alignment; all other controls require story alignment. */
export function controlDeliveryType(type: string): "prompt" | "assistant_prompt" {
	return type.startsWith("assistant_") ? "assistant_prompt" : "prompt";
}

/** Dedupe safe reads until a response; only these frames survive a disconnect for retry. */
export class SafeReadRequestQueue {
	#pending = new Set<SafeReadRequestType>();
	#inFlight = new Set<SafeReadRequestType>();
	enqueue(type: string): boolean {
		if (!isSafeReadRequest(type) || this.#pending.has(type)) return false;
		// At most one follow-up refresh is retained while the same read is in flight.
		this.#pending.add(type);
		return true;
	}
	pendingFor(lane: SafeReadRequestLane): SafeReadRequestType[] {
		return [...this.#pending].filter((type) => safeReadRequestLane(type) === lane);
	}
	dispatch(type: SafeReadRequestType): boolean {
		if (this.#inFlight.has(type)) return false;
		if (!this.#pending.delete(type)) return false;
		this.#inFlight.add(type);
		return true;
	}
	response(type: SafeReadRequestType, allowStaleResult = false): "stale" | "current" | "unsolicited" {
		if (!this.#inFlight.delete(type)) return "unsolicited";
		return allowStaleResult && this.#pending.has(type) ? "stale" : "current";
	}
	fail(type: SafeReadRequestType): void {
		if (this.#inFlight.delete(type)) this.#pending.add(type);
	}
	disconnect(): void {
		for (const type of this.#inFlight) this.#pending.add(type);
		this.#inFlight.clear();
	}
	hasPending(type: SafeReadRequestType): boolean { return this.#pending.has(type); }
	isInFlight(type: SafeReadRequestType): boolean { return this.#inFlight.has(type); }
	get size(): number { return this.#pending.size + this.#inFlight.size; }
}

/** Called only when the watchdog expires; CONNECTING and OPEN-without-hello are recoverable. */
export function isWireHandshakeStalled(readyState: number, receivedStoryHello: boolean): boolean {
	// The story hello is the primary app session. Assistant hello may be absent on prompt-only hosts.
	return readyState === WS_CONNECTING || readyState === WS_CLOSING || (readyState === WS_OPEN && !receivedStoryHello);
}

export const WS_CONNECTING = 0;
export const WS_OPEN = 1;
export const WS_CLOSING = 2;
export const WS_CLOSED = 3;

export function buildWireUrl(protocol: string, host: string): string {
	return `${protocol === "https:" ? "wss:" : "ws:"}//${host}/ws`;
}

export function nextRetryMs(current: number): number {
	return Math.min(Math.max(WS_RETRY_INITIAL_MS, current * 2), WS_RETRY_MAX_MS);
}

export function canOpenWire(readyState: number | null | undefined): boolean {
	return readyState === undefined || readyState === WS_CLOSED || readyState === null;
}

export function shouldWakeFromVisibility(
	state: string,
	closed: boolean,
	readyState: number | null | undefined,
): boolean {
	return state === "visible" && !closed && canOpenWire(readyState);
}

export function shouldWakeFromOnline(closed: boolean, readyState: number | null | undefined): boolean {
	return !closed && canOpenWire(readyState);
}

export function shouldQueueFrame(type: string): boolean {
	return type === "prompt" || type === "assistant_prompt";
}

type ReliablePromptBase = { text: string; sessionId: string; messageId: string };
export type ReliablePrompt =
	| ({ type: "prompt"; generationMode?: GenerationMode } & ReliablePromptBase)
	| ({ type: "assistant_prompt" } & ReliablePromptBase);
export type OutboxItem = { frame: ReliablePrompt; createdAt: number; state: "pending" | "rejected"; dispatched?: boolean; reason?: string };
export type SendResult = { accepted: true; messageId?: string; sessionId?: string; queued?: boolean } | { accepted: false; reason: string; messageId?: string };
export const legacyDeliveryWarning = (type: ReliablePrompt["type"]): string =>
	`当前${type === "prompt" ? "剧情" : "助手"}宿主未声明可靠投递确认能力；可靠输入草稿已保留，不会发往此宿主或自动重试，请更新宿主后检查草稿`;
export interface OutboxStorage { getItem(key: string): string | null; setItem(key: string, value: string): void }
export const OUTBOX_KEY = "liyuan.prompt-outbox.v1";
export const OUTBOX_LIMIT = 24;
export const OUTBOX_MAX_CHARS = 512_000;
export const isCommandPrompt = (text: string): boolean => text.trimStart().startsWith("/");
/** Story submissions have a persisted client ID receipt; assistant submissions do not. */
export const shouldRetryUnacknowledged = (type: ReliablePrompt["type"]): boolean => type === "prompt";

function normalizeReliablePrompt(frame: ReliablePrompt): ReliablePrompt {
	if (frame.type === "assistant_prompt") return { type: frame.type, text: frame.text, sessionId: frame.sessionId, messageId: frame.messageId };
	const { generationMode, ...base } = frame;
	return isCommandPrompt(frame.text) ? base : { ...base, generationMode: resolveGenerationMode(generationMode) };
}

function reliablePromptMode(frame: ReliablePrompt): GenerationMode | undefined {
	return frame.type === "prompt" && !isCommandPrompt(frame.text) ? resolveGenerationMode(frame.generationMode) : undefined;
}

/** 投递恢复日志，不是第二份正文/Session；只有 accepted ACK 或显式移除才删。 */
export class PromptOutbox {
	#items: OutboxItem[] = [];
	error: string | null = null;
	private readonly storage: OutboxStorage;
	private readonly now: () => number;
	#unreadable = false;
	constructor(storage: OutboxStorage, now: () => number = Date.now) {
		this.storage = storage; this.now = now;
		try {
			const raw = storage.getItem(OUTBOX_KEY);
			if (!raw) return;
			if (raw.length > OUTBOX_MAX_CHARS) throw new Error("too large");
			const data: unknown = JSON.parse(raw);
			if (!Array.isArray(data) || data.length > OUTBOX_LIMIT) throw new Error("invalid outbox");
			const ids = new Set<string>();
			for (const item of data) {
				const f = item?.frame;
				if (!f || !shouldQueueFrame(f.type) || typeof f.text !== "string" || !f.text.trim() || f.text.length > 256_000 ||
					typeof f.sessionId !== "string" || !f.sessionId || f.sessionId.length > 256 ||
					typeof f.messageId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(f.messageId) || ids.has(f.messageId) ||
					(f.generationMode !== undefined && (f.type !== "prompt" || isCommandPrompt(f.text) || !isGenerationMode(f.generationMode))) ||
					!Number.isFinite(item.createdAt) || !["pending", "rejected"].includes(item.state) || (item.dispatched !== undefined && typeof item.dispatched !== "boolean")) throw new Error("invalid item");
				ids.add(f.messageId);
				const legacyUncertainAssistant = f.type === "assistant_prompt" && item.state === "pending" && item.dispatched === undefined;
				const dispatchedAssistant = f.type === "assistant_prompt" && item.state === "pending" && item.dispatched === true;
				const decodedFrame: ReliablePrompt = f.type === "prompt"
					? { type: f.type, text: f.text, sessionId: f.sessionId, messageId: f.messageId, ...(isGenerationMode(f.generationMode) ? { generationMode: f.generationMode } : {}) }
					: { type: f.type, text: f.text, sessionId: f.sessionId, messageId: f.messageId };
				// Legacy prose drafts predate the field; use the documented director default.
				const restoredFrame = normalizeReliablePrompt(decodedFrame);
				this.#items.push({ frame: restoredFrame, createdAt: item.createdAt,
					state: isCommandPrompt(f.text) || legacyUncertainAssistant || dispatchedAssistant ? "rejected" : item.state,
					...(f.type === "assistant_prompt" && item.dispatched !== undefined ? { dispatched: item.dispatched } : {}),
					...(isCommandPrompt(f.text) ? { reason: "命令不会自动重放；请检查会话后手动重试" } : legacyUncertainAssistant || dispatchedAssistant ? { reason: "助手输入已发送或状态不明但未确认；为避免重复，不会自动重放。请先检查助手历史，再手动重试" } : typeof item.reason === "string" ? { reason: item.reason.slice(0, 300) } : {}) });
			}
		} catch { this.#unreadable = true; this.#items = []; this.error = "未送达草稿存储不可读；已保留原存储，请勿关闭页面，先复制输入"; }
	}
	get items(): OutboxItem[] { return this.#items.map((item) => ({ ...item, frame: { ...item.frame } })); }
	#commit(next: OutboxItem[]): boolean {
		try {
			const raw = JSON.stringify(next);
			if (next.length > OUTBOX_LIMIT || raw.length > OUTBOX_MAX_CHARS) { this.error = "未送达草稿已达上限，请先复制/处理旧草稿"; return false; }
			this.storage.setItem(OUTBOX_KEY, raw);
			this.#items = next; this.error = null; return true;
		} catch { this.error = "未能保存未送达草稿（存储额度/权限）；本次未发送，请复制输入后重试"; return false; }
	}
	enqueue(frame: ReliablePrompt, online: boolean): SendResult {
		if (this.#unreadable) return { accepted: false, reason: this.error! };
		if (!frame.sessionId || frame.sessionId.length > 256 || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(frame.messageId)) return { accepted: false, reason: "会话目标或消息 ID 无效，输入未发送" };
		const savedFrame = normalizeReliablePrompt(frame);
		const sameId = this.#items.find((item) => item.frame.messageId === savedFrame.messageId);
		if (sameId && (sameId.frame.type !== savedFrame.type || sameId.frame.sessionId !== savedFrame.sessionId || sameId.frame.text !== savedFrame.text || reliablePromptMode(sameId.frame) !== reliablePromptMode(savedFrame))) return { accepted: false, reason: "消息 ID 已绑定其他输入，草稿未发送" };
		if (sameId?.state === "rejected") return { accepted: false, reason: sameId.reason || "该草稿已被拒绝，请确认目标后另行提交", messageId: sameId.frame.messageId };
		const command = isCommandPrompt(savedFrame.text);
		if (command && !online) {
			const draft = this.#items.find((item) => item.state === "rejected" && item.frame.type === savedFrame.type && item.frame.sessionId === savedFrame.sessionId && item.frame.text === savedFrame.text);
			if (draft) return { accepted: false, reason: draft.reason!, messageId: draft.frame.messageId };
		}
		const existing = this.#items.find((item) => item.state === "pending" && item.frame.type === savedFrame.type && item.frame.sessionId === savedFrame.sessionId && item.frame.text === savedFrame.text && reliablePromptMode(item.frame) === reliablePromptMode(savedFrame));
		if (existing) return { accepted: true, messageId: existing.frame.messageId, queued: !online };
		if (savedFrame.text.length > 256_000) return { accepted: false, reason: "输入过长，草稿未发送，请分段发送" };
		const item: OutboxItem = { frame: savedFrame, createdAt: this.now(), state: command && !online ? "rejected" : "pending",
			...(savedFrame.type === "assistant_prompt" ? { dispatched: false } : {}),
			...(command ? { reason: online ? "命令待回执；断线后不会自动重放" : "离线命令未执行；请检查会话后手动重试" } : {}) };
		if (!this.#commit([...this.#items, item])) return { accepted: false, reason: this.error! };
		if (command && !online) return { accepted: false, reason: item.reason!, messageId: frame.messageId };
		return { accepted: true, messageId: savedFrame.messageId, queued: !online };
	}
	recover(frame: ReliablePrompt, reason: string): Extract<SendResult, { accepted: false }> {
		if (this.#unreadable || frame.text.length > 256_000) return { accepted: false, reason: this.error || reason };
		const savedFrame = normalizeReliablePrompt(frame);
		if (this.#items.some((item) => item.state === "rejected" && item.frame.type === savedFrame.type && item.frame.sessionId === savedFrame.sessionId && item.frame.text === savedFrame.text && reliablePromptMode(item.frame) === reliablePromptMode(savedFrame))) return { accepted: false, reason };
		const saved = this.#commit([...this.#items, { frame: savedFrame, createdAt: this.now(), state: "rejected", reason }]);
		return { accepted: false, reason: saved ? reason : this.error!, ...(saved ? { messageId: savedFrame.messageId } : {}) };
	}
	ack(messageId: string, sessionId: string, status: "accepted" | "rejected", reason?: string): boolean {
		if (!this.#items.some((item) => item.frame.messageId === messageId && item.frame.sessionId === sessionId)) return false;
		const next = status === "accepted" ? this.#items.filter((item) => item.frame.messageId !== messageId)
			: this.#items.map((item) => item.frame.messageId === messageId ? { ...item, state: "rejected" as const, reason: (reason || "投递被拒绝，草稿保留").slice(0, 300) } : item);
		// ACK 后即使删除持久日志失败，也不在本连接再发送；旧日志重连将靠后端 id 去重。
		const ok = this.#commit(next);
		if (!ok && status === "accepted") { this.#items = next; this.error = "输入已确认，但本机恢复日志未清除；刷新时会按原 ID 对账，请勿另发副本"; }
		if (!ok && status === "rejected") { this.#items = next; this.error = "投递被拒绝且草稿状态保存失败；请立即复制草稿"; }
		return true;
	}
	disconnect(): void {
		const next = this.#items.map((item) => item.state === "pending" && (isCommandPrompt(item.frame.text) || (item.frame.type === "assistant_prompt" && item.dispatched === true))
			? { ...item, state: "rejected" as const, reason: isCommandPrompt(item.frame.text) ? "命令结果未确认；不会自动重放，请先检查状态再手动重试" : "助手输入已发送但未确认；为避免重复输入，不会自动重放。请先检查助手历史，再手动重试" } : item);
		if (next.some((item, i) => item !== this.#items[i]) && !this.#commit(next)) this.#items = next;
	}
	align(type: ReliablePrompt["type"], sessionId: string): OutboxItem[] {
		const mismatched = this.#items.filter((item) => item.state === "pending" && item.frame.type === type && item.frame.sessionId !== sessionId);
		if (mismatched.length) {
			const ids = new Set(mismatched.map((item) => item.frame.messageId));
			const next = this.#items.map((item) => ids.has(item.frame.messageId) ? { ...item, state: "rejected" as const, reason: "当前会话已不同，未自动发送；请复制/恢复草稿并确认目标" } : item);
			if (!this.#commit(next)) this.#items = next; // 本连接仍必须拒绝错投
		}
		return mismatched;
	}
	flushable(type: ReliablePrompt["type"], sessionId: string): ReliablePrompt[] {
		return this.#items.filter((item) => item.state === "pending" && item.frame.type === type && item.frame.sessionId === sessionId && !isCommandPrompt(item.frame.text) && !(type === "assistant_prompt" && item.dispatched === true)).map((item) => ({ ...item.frame }));
	}
	/** Persist a write-ahead dispatch marker before an assistant send; failed persistence means do not send. */
	markDispatched(messageId: string): boolean {
		const item = this.#items.find((candidate) => candidate.frame.messageId === messageId && candidate.frame.type === "assistant_prompt" && candidate.state === "pending");
		if (!item) return false;
		if (item.dispatched === true) return true;
		const next = this.#items.map((candidate) => candidate === item ? { ...candidate, dispatched: true } : candidate);
		if (this.#commit(next)) return true;
		this.#items = next.map((candidate) => candidate.frame.messageId === messageId ? { ...candidate, state: "rejected", reason: "无法持久记录助手输入已发送状态；为避免重复，本次未发送，请复制草稿并检查后手动重试" } : candidate);
		return false;
	}
	discard(messageId: string): void { this.#commit(this.#items.filter((item) => item.frame.messageId !== messageId)); }
}

/** 物理 socket open 不等于目标已确认；只在当前连接收到对应 hello 后发帧。 */
export class DeliverySessionGate {
	readonly targets: Partial<Record<ReliablePrompt["type"], string>> = {};
	readonly ready = new Set<ReliablePrompt["type"]>();
	readonly reliable = new Set<ReliablePrompt["type"]>();
	readonly sent = new Set<string>();
	disconnect(): void { this.ready.clear(); this.reliable.clear(); this.sent.clear(); }
	hello(type: ReliablePrompt["type"], sessionId: string | undefined, deliveryProtocol?: number): boolean {
		if (!sessionId) { this.ready.delete(type); this.reliable.delete(type); delete this.targets[type]; return false; }
		this.targets[type] = sessionId; this.ready.add(type);
		if (deliveryProtocol === 1) this.reliable.add(type); else this.reliable.delete(type);
		return this.reliable.has(type);
	}
	isReady(type: ReliablePrompt["type"], sessionId: string): boolean { return this.ready.has(type) && this.targets[type] === sessionId; }
	canDeliverReliably(type: ReliablePrompt["type"]): boolean { return this.ready.has(type) && this.reliable.has(type); }
	frames(box: PromptOutbox, type: ReliablePrompt["type"]): ReliablePrompt[] {
		const target = this.targets[type];
		return target && this.canDeliverReliably(type) && this.isReady(type, target) ? box.flushable(type, target).filter((frame) => !this.sent.has(frame.messageId)) : [];
	}
}

export interface MessageIdCrypto {
	randomUUID?: () => string;
	getRandomValues?: (array: Uint8Array) => Uint8Array;
}
let fallbackMessageIdCounter = 0;
/** HTTP VPS 上 randomUUID 可能不存在；这是幂等标识，不是访问凭据。 */
export function newMessageId(source: MessageIdCrypto | null | undefined = globalThis.crypto, now = Date.now, random = Math.random): string {
	try {
		if (typeof source?.randomUUID === "function") {
			const id = source.randomUUID();
			if (/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(id)) return id;
		}
	} catch { /* 某些浏览器限制安全上下文；继续用随机字节 */ }
	try {
		if (typeof source?.getRandomValues === "function") {
			const bytes = new Uint8Array(16);
			source.getRandomValues(bytes);
			bytes[6] = (bytes[6] & 0x0f) | 0x40;
			bytes[8] = (bytes[8] & 0x3f) | 0x80;
			const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
			return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
		}
	} catch { /* 极旧/受限环境仍能保留草稿和生成合法投递 ID */ }
	fallbackMessageIdCounter = (fallbackMessageIdCounter + 1) >>> 0;
	const entropy = Array.from({ length: 4 }, () => Math.floor(random() * 0x100000000).toString(16).padStart(8, "0")).join("");
	return `m-${now().toString(36)}-${fallbackMessageIdCounter.toString(36)}-${entropy}`;
}
