/** 同源 WS；连接重试与投递确认分离。命令不自动重放，普通输入先写本机 outbox 再发。 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
	buildWireUrl, canOpenWire, nextRetryMs, shouldWakeFromOnline, shouldWakeFromVisibility, WS_RETRY_INITIAL_MS,
	PromptOutbox, DeliverySessionGate, isCommandPrompt, legacyDeliveryWarning, shouldRetryUnacknowledged, newMessageId, type OutboxItem, type OutboxStorage, type ReliablePrompt, type SendResult,
} from "./ws-lifecycle.ts";
import type { ClientFrame, ServerFrame } from "./wire.ts";
export type ConnState = "connecting" | "open" | "closed";
export interface WsHandle {
	send: (frame: ClientFrame) => SendResult;
	outbox: OutboxItem[];
	storageError: string | null;
	discard: (messageId: string) => void;
}
const browserStorage: OutboxStorage = { getItem: (key) => sessionStorage.getItem(key), setItem: (key, value) => sessionStorage.setItem(key, value) };
export function useWire(onFrame: (frame: ServerFrame) => void, onState: (s: ConnState) => void): WsHandle {
	const wsRef = useRef<WebSocket | null>(null);
	const boxRef = useRef<PromptOutbox | null>(null);
	if (!boxRef.current) boxRef.current = new PromptOutbox(browserStorage);
	const [outbox, setOutbox] = useState<OutboxItem[]>(() => boxRef.current!.items);
	const [storageError, setStorageError] = useState<string | null>(() => boxRef.current!.error);
	const gateRef = useRef(new DeliverySessionGate());
	const targetsRef = { current: gateRef.current.targets };
	const readyRef = { current: gateRef.current.ready };
	const sentRef = { current: gateRef.current.sent };
	const onFrameRef = useRef(onFrame), onStateRef = useRef(onState);
	onFrameRef.current = onFrame; onStateRef.current = onState;
	const refresh = useCallback(() => { setOutbox(boxRef.current!.items); setStorageError(boxRef.current!.error); }, []);
	const flush = useCallback((type: ReliablePrompt["type"]) => {
		const ws = wsRef.current, target = targetsRef.current[type];
		if (!ws || ws.readyState !== WebSocket.OPEN || !target || !readyRef.current.has(type)) return;
		for (const frame of gateRef.current.frames(boxRef.current!, type)) {
			if (sentRef.current.has(frame.messageId)) continue;
			try {
				if (frame.type === "assistant_prompt") {
					if (!boxRef.current!.markDispatched(frame.messageId)) { refresh(); break; }
					sentRef.current.add(frame.messageId); // write-ahead marker; never retry this assistant ID in-place
				}
				ws.send(JSON.stringify(frame));
				if (frame.type === "prompt") sentRef.current.add(frame.messageId);
				refresh();
			}
			catch { ws.close(); break; } // 剧情按原 ID 重试；助手 dispatched 后断线只留恢复草稿
		}
	}, []);
	useEffect(() => {
		let closed = false, retryMs = WS_RETRY_INITIAL_MS;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const warnedLegacy = new Set<string>();
		const clearRetryTimer = () => { if (timer) clearTimeout(timer); timer = undefined; };
		const connect = () => {
			clearRetryTimer();
			if (closed || !canOpenWire(wsRef.current?.readyState)) return;
			onStateRef.current("connecting"); readyRef.current.clear(); sentRef.current.clear();
			const ws = new WebSocket(buildWireUrl(location.protocol, location.host)); wsRef.current = ws;
			ws.onopen = () => {
				if (closed || wsRef.current !== ws) return;
				retryMs = WS_RETRY_INITIAL_MS; onStateRef.current("open"); // 必须等 hello，不能此处冲刷
			};
			ws.onmessage = (ev) => {
				if (closed || wsRef.current !== ws) return;
				let frame: ServerFrame;
				try { frame = JSON.parse(String(ev.data)) as ServerFrame; } catch { return; }
				if (frame.type === "hello" || frame.type === "assistant_hello") {
					const type = frame.type === "hello" ? "prompt" : "assistant_prompt";
					const reliableProtocol = frame.deliveryProtocol === 1;
					gateRef.current.hello(type, frame.sessionId, frame.deliveryProtocol);
					if (!frame.sessionId) { onFrameRef.current(frame); return; }
					const legacyKey = `${type}:${frame.sessionId ?? ""}`;
					if (!reliableProtocol && !warnedLegacy.has(legacyKey)) {
						warnedLegacy.add(legacyKey);
						onFrameRef.current({ type: "notify", level: "warning", text: legacyDeliveryWarning(type) });
					}
					const rejected = boxRef.current!.align(type, frame.sessionId);
					onFrameRef.current(frame);
					for (const item of rejected) onFrameRef.current({ type: "prompt_ack", messageId: item.frame.messageId, sessionId: item.frame.sessionId, status: "rejected", reason: "会话已改变，草稿未发送，可复制或恢复后手动提交" });
					if (frame.type === "hello") for (const m of frame.messages) if (m.channel === "user" && m.messageId && boxRef.current!.ack(m.messageId, frame.sessionId, "accepted")) {
						sentRef.current.delete(m.messageId);
						onFrameRef.current({ type: "prompt_ack", messageId: m.messageId, sessionId: frame.sessionId, status: "accepted" });
					}
					refresh(); flush(type); return;
				}
				if (frame.type === "prompt_ack") { sentRef.current.delete(frame.messageId); boxRef.current!.ack(frame.messageId, frame.sessionId, frame.status, frame.reason); refresh(); }
				onFrameRef.current(frame);
			};
			ws.onclose = (ev) => {
				const current = wsRef.current === ws;
				if (current) { wsRef.current = null; readyRef.current.clear(); sentRef.current.clear(); boxRef.current!.disconnect(); refresh(); }
				if (closed || !current) return;
				if (ev.code === 4401) { location.reload(); return; } // outbox 跨 reload 保留
				onStateRef.current("closed"); timer = setTimeout(connect, retryMs); retryMs = nextRetryMs(retryMs);
			};
			ws.onerror = () => { if (wsRef.current === ws) ws.close(); };
		};
		const wake = () => { clearRetryTimer(); connect(); };
		const visibility = () => { if (shouldWakeFromVisibility(document.visibilityState, closed, wsRef.current?.readyState)) wake(); };
		const online = () => { if (shouldWakeFromOnline(closed, wsRef.current?.readyState)) wake(); };
		connect(); window.addEventListener("online", online); document.addEventListener("visibilitychange", visibility);
		const ackRetry = window.setInterval(() => {
			for (const item of boxRef.current!.items) if (item.state === "pending" && shouldRetryUnacknowledged(item.frame.type) && !isCommandPrompt(item.frame.text)) sentRef.current.delete(item.frame.messageId);
			flush("prompt");
		}, 15_000);
		return () => { closed = true; clearRetryTimer(); window.clearInterval(ackRetry); window.removeEventListener("online", online); document.removeEventListener("visibilitychange", visibility); const ws = wsRef.current; wsRef.current = null; ws?.close(); };
	}, [flush, refresh]);
	const send = useCallback((frame: ClientFrame): SendResult => {
		const refuse = (reason: string, messageId?: string): SendResult => { onFrameRef.current({ type: "notify", level: "warning", text: reason }); return { accepted: false, reason, ...(messageId ? { messageId } : {}) }; };
		const ws = wsRef.current;
		if (frame.type === "prompt" || frame.type === "assistant_prompt") {
			const target = frame.sessionId ?? targetsRef.current[frame.type];
			if (!target) {
				const reason = "尚未确认目标会话，输入未发送；可复制草稿，连接对齐后手动重试";
				const result = boxRef.current!.recover({ ...frame, sessionId: "unconfirmed-target", messageId: newMessageId() }, reason);
				refresh(); return refuse(result.reason, result.messageId);
			}
			if (!frame.text.trim()) return refuse("没有可发送的内容");
			if (readyRef.current.has(frame.type) && targetsRef.current[frame.type] !== target) {
				const reason = "当前已对齐到其他会话，输入未发送；请复制草稿并确认目标";
				const result = boxRef.current!.recover({ ...frame, sessionId: target, messageId: frame.messageId ?? newMessageId() }, reason);
				refresh(); return refuse(result.reason, result.messageId);
			}
			const bound: ReliablePrompt = { ...frame, sessionId: target, messageId: frame.messageId ?? newMessageId(), text: frame.text.trim() };
			const aligned = ws?.readyState === WebSocket.OPEN && readyRef.current.has(frame.type) && targetsRef.current[frame.type] === target;
			const online = !!aligned && (isCommandPrompt(bound.text) || gateRef.current.canDeliverReliably(frame.type));
			const result = boxRef.current!.enqueue(bound, online);
			refresh();
			if (!result.accepted) return refuse(result.reason, result.messageId);
			if (isCommandPrompt(bound.text)) {
				try {
					if (bound.type === "assistant_prompt" && !boxRef.current!.markDispatched(result.messageId!)) { refresh(); return refuse("无法安全记录助手输入状态；本次未发送，草稿已保留", result.messageId); }
					if (!sentRef.current.has(result.messageId!)) { ws!.send(JSON.stringify({ ...bound, messageId: result.messageId })); sentRef.current.add(result.messageId!); }
				}
				catch { boxRef.current!.ack(result.messageId!, target, "rejected", "命令未确认，不会自动重放，请检查状态后手动重试"); refresh(); return refuse("命令未确认，请保留输入并检查会话后手动重试", result.messageId); }
			} else if (gateRef.current.canDeliverReliably(frame.type)) flush(frame.type);
			return { ...result, sessionId: target };
		}
		if (ws?.readyState !== WebSocket.OPEN || !readyRef.current.has("prompt")) return refuse("当前未连接/尚未对齐会话，此操作未发送，请连接后重试");
		try { ws.send(JSON.stringify(frame)); return { accepted: true }; }
		catch { return refuse("发送失败，此操作未确认，请连接后检查并重试"); }
	}, [flush, refresh]);
	const discard = useCallback((messageId: string) => { boxRef.current!.discard(messageId); refresh(); }, [refresh]);
	return { send, outbox, storageError, discard };
}
