import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { RestHost } from "./rest.ts";
import {
	createOpeningProposal, novelPlayBinding, readyCorpusSource, sameNovelPlayBinding, startFromConfirmedProposal, startOptions,
	buildPackageWithProgress,
	extendPackageWithProgress,
	buildCharacterProfilesWithProgress,
	applyCharacterProfilesToCard,
	type NovelPlayBinding, type NovelPlayModelHost, type PreviewPublicDto,
} from "../src/novel-play/application.ts";
import type { NovelAnchor } from "../src/novel-play/canon.ts";
import type { NovelOpeningProposal } from "../src/novel-play/opening.ts";
import { listNovelPackageIndex, type StoredNovelPackage } from "../src/novel-play/store.ts";

export const NOVEL_PLAY_LIMITS = {
	maxBodyBytes: 64 * 1024,
	maxBuildOperations: 2,
	maxPreviewOperations: 2,
	previewRequestsPerMinute: 6,
	// Long novels are extracted serially and checkpoint after every chunk. Keep a
	// generous wall-clock cap while retaining the per-model-call deadline below.
	buildDeadlineMs: 4 * 60 * 60_000,
	modelCallDeadlineMs: 120_000,
	startSwitchDeadlineMs: 30_000,
	previewDeadlineMs: 5 * 60_000,
	jobRetentionMs: 30 * 60_000,
	previewTokenTtlMs: 10 * 60_000,
} as const;

type JobState = "queued" | "running" | "succeeded" | "failed" | "cancelled";
interface Job { id: string; docId: string; binding: NovelPlayBinding; state: JobState; createdAt: number; updatedAt: number; controller: AbortController; progress: { completed: number; total: number }; kind?: "package" | "profiles" | "extension"; revision?: string; parentDocId?: string; parentRevision?: string; result?: unknown; error?: string }
interface Preview { token: string; expiresAt: number; used: boolean; binding: NovelPlayBinding; stored: StoredNovelPackage; anchor: NovelAnchor; proposal: NovelOpeningProposal }
interface UpgradePreview { token: string; expiresAt: number; binding: NovelPlayBinding; leafId: string; targetDocId: string; targetRevision: string; digest: string; }
interface InstanceState { jobs: Map<string, Job>; previews: Map<string, Preview>; upgrades: Map<string, UpgradePreview>; starting: boolean; recovery?: { card?: string; session: "recovery-required"; recovery: string }; buildOperations: number; previewOperations: number; previewStarts: Map<string, number[]> }

const instances = new WeakMap<object, InstanceState>();
const stateFor = (host: object): InstanceState => {
	let state = instances.get(host);
	if (!state) { state = { jobs: new Map(), previews: new Map(), upgrades: new Map(), starting: false, buildOperations: 0, previewOperations: 0, previewStarts: new Map() }; instances.set(host, state); }
	return state;
};
export const isNovelPlayStartLocked = (host: object): boolean => stateFor(host).starting;
export const novelPlayCounters = (host: object) => { const state = stateFor(host); return { buildOperations: state.buildOperations, previewOperations: state.previewOperations, jobs: state.jobs.size, previews: state.previews.size, starting: state.starting, recovery: state.recovery }; };

const terminal = (state: JobState): boolean => state === "succeeded" || state === "failed" || state === "cancelled";
const send = (res: ServerResponse, code: number, value: unknown): void => { if (res.writableEnded || res.destroyed) return; res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }); res.end(JSON.stringify(value)); };
async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
	let size = 0; const chunks: Buffer[] = [];
	for await (const value of req) { if (req.aborted) throw Object.assign(new Error("请求已断开"), { statusCode: 499 }); const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value); size += chunk.length; if (size > NOVEL_PLAY_LIMITS.maxBodyBytes) throw Object.assign(new Error("请求体过大"), { statusCode: 413 }); chunks.push(chunk); }
	if (!chunks.length) return {}; const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("请求体必须是 JSON 对象"); return parsed as Record<string, unknown>;
}
const text = (value: unknown, name: string, max = 500): string => { if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`${name} 无效`); return value.trim(); };
const dto = (job: Job) => ({ id: job.id, docId: job.docId, status: job.state, createdAt: new Date(job.createdAt).toISOString(), updatedAt: new Date(job.updatedAt).toISOString(), progress: job.progress, ...(job.result ? { result: job.result } : {}), ...(job.error ? { error: job.error } : {}) });
function prune(state: InstanceState): void { const now = Date.now(); for (const [id, job] of state.jobs) if (terminal(job.state) && now - job.updatedAt > NOVEL_PLAY_LIMITS.jobRetentionMs) state.jobs.delete(id); for (const [token, preview] of state.previews) if (preview.used || preview.expiresAt <= now) state.previews.delete(token); for (const [token, preview] of state.upgrades) if (preview.expiresAt <= now) state.upgrades.delete(token); for (const [session, starts] of state.previewStarts) { const fresh = starts.filter(value => now - value < 60_000); if (fresh.length) state.previewStarts.set(session, fresh); else state.previewStarts.delete(session); } }
function tokenEqual(a: string, b: string): boolean { const left = Buffer.from(a); const right = Buffer.from(b); return left.length === right.length && timingSafeEqual(left, right); }
function createUpgradeDigest(value: Record<string, unknown>): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function requestSignal(req: IncomingMessage, res: ServerResponse): { signal: AbortSignal; cleanup: () => void } { const controller = new AbortController(); const abort = () => controller.abort(new Error("客户端已断开")); const close = () => { if (!res.writableEnded) abort(); }; if (req.aborted) abort(); req.once("aborted", abort); const responseEvents = res as ServerResponse & { once?: (event: string, listener: () => void) => unknown; off?: (event: string, listener: () => void) => unknown }; responseEvents.once?.("close", close); return { signal: controller.signal, cleanup: () => { req.off("aborted", abort); responseEvents.off?.("close", close); } }; }
function deadlineSignal(parent: AbortSignal | undefined, ms: number): { signal: AbortSignal; expired: () => boolean; cleanup: () => void } { const controller = new AbortController(); let timedOut = false; const onAbort = () => controller.abort(parent?.reason); if (parent?.aborted) onAbort(); else parent?.addEventListener("abort", onAbort, { once: true }); const timer = setTimeout(() => { timedOut = true; controller.abort(new Error("操作超时")); }, ms); return { signal: controller.signal, expired: () => timedOut, cleanup: () => { clearTimeout(timer); parent?.removeEventListener("abort", onAbort); } }; }
async function raceDeadline<T>(operation: Promise<T>, signal: AbortSignal, message: string): Promise<T> { if (signal.aborted) throw Object.assign(new Error(message), { statusCode: 504 }); return await Promise.race([operation, new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(Object.assign(new Error(message), { statusCode: 504 })), { once: true }))]); }
function bindingChecked(host: NovelPlayModelHost, expected: NovelPlayBinding): void { if (!sameNovelPlayBinding(novelPlayBinding(host), expected)) throw Object.assign(new Error("会话或角色卡已变化"), { statusCode: 409 }); }

export async function handleNovelPlayApiRequest(req: IncomingMessage, res: ServerResponse, host: RestHost): Promise<boolean> {
	const pathname = (req.url ?? "/").split("?")[0]; if (!pathname.startsWith("/api/novel-play/")) return false;
	const route = `${req.method} ${pathname}`; const query = new URLSearchParams((req.url ?? "").split("?")[1] ?? ""); const instance = stateFor(host); prune(instance);
	if (route === "POST /api/novel-play/start" && (instance.starting || instance.recovery)) { send(res, 409, { error: "小说开演正在启动或等待恢复" }); return true; }
	try {
		const current = novelPlayBinding(host as NovelPlayModelHost);
		if (route === "POST /api/novel-play/build") {
			const input = await body(req); const binding = novelPlayBinding(host as NovelPlayModelHost); const docId = text(input.docId, "docId", 200);
			readyCorpusSource(host.cwd, docId);
			const active = [...instance.jobs.values()].filter(job => sameNovelPlayBinding(job.binding, binding) && !terminal(job.state));
			if (active.some(job => job.docId === docId)) throw Object.assign(new Error("该小说已在构建中"), { statusCode: 409 });
			if (instance.buildOperations >= NOVEL_PLAY_LIMITS.maxBuildOperations) throw Object.assign(new Error("小说构建队列已满"), { statusCode: 429 });
			const now = Date.now(); const source = readyCorpusSource(host.cwd, docId); const job: Job = { id: randomBytes(16).toString("hex"), docId, binding, state: "queued", createdAt: now, updatedAt: now, controller: new AbortController(), progress: { completed: 0, total: source.document.chunkCount } }; instance.jobs.set(job.id, job); instance.buildOperations++;
			void Promise.resolve().then(async () => {
				if (job.state === "cancelled" || job.controller.signal.aborted) { instance.buildOperations--; return; }
				job.state = "running"; job.updatedAt = Date.now(); const deadline = deadlineSignal(job.controller.signal, NOVEL_PLAY_LIMITS.buildDeadlineMs); const operation = buildPackageWithProgress(host as NovelPlayModelHost, docId, deadline.signal, (completed, total) => { job.progress = { completed, total }; job.updatedAt = Date.now(); });
				try { const result = await raceDeadline(operation, deadline.signal, "小说构建超时"); if (terminal(job.state) || deadline.signal.aborted) return; bindingChecked(host as NovelPlayModelHost, binding); job.result = result; job.state = "succeeded"; }
				catch (error) { if (terminal(job.state)) return; job.state = job.controller.signal.aborted && !deadline.expired() ? "cancelled" : "failed"; job.error = error instanceof Error ? error.message : String(error); }
				finally { job.updatedAt = Date.now(); deadline.cleanup(); void operation.catch(() => {}).finally(() => { instance.buildOperations--; }); }
			});
			send(res, 202, { job: dto(job) }); return true;
		}
		if (route === "POST /api/novel-play/profiles") {
			const input = await body(req); const binding = novelPlayBinding(host as NovelPlayModelHost); const docId = text(input.docId, "docId", 200); const revision = text(input.revision, "revision", 128);
			if (instance.buildOperations >= NOVEL_PLAY_LIMITS.maxBuildOperations) throw Object.assign(new Error("人物资料库队列已满"), { statusCode: 429 });
			if ([...instance.jobs.values()].some(job => !terminal(job.state) && job.kind === "profiles" && job.docId === docId && job.revision === revision && sameNovelPlayBinding(job.binding, binding))) throw Object.assign(new Error("该作品包的人物资料正在构建中"), { statusCode: 409 });
			const now = Date.now(); const source = readyCorpusSource(host.cwd, docId); const job: Job = { id: randomBytes(16).toString("hex"), docId, binding, state: "queued", createdAt: now, updatedAt: now, controller: new AbortController(), progress: { completed: 0, total: source.document.chunkCount }, kind: "profiles", revision }; instance.jobs.set(job.id, job); instance.buildOperations++;
			void Promise.resolve().then(async () => {
				job.state = "running"; const deadline = deadlineSignal(job.controller.signal, NOVEL_PLAY_LIMITS.buildDeadlineMs); const operation = buildCharacterProfilesWithProgress(host as NovelPlayModelHost, docId, revision, deadline.signal, (completed, total) => { job.progress = { completed, total }; job.updatedAt = Date.now(); });
				try { job.result = await raceDeadline(operation, deadline.signal, "人物资料库构建超时"); if (!deadline.signal.aborted) job.state = "succeeded"; }
				catch (error) { job.state = job.controller.signal.aborted && !deadline.expired() ? "cancelled" : "failed"; job.error = error instanceof Error ? error.message : String(error); }
				finally { job.updatedAt = Date.now(); deadline.cleanup(); void operation.catch(() => {}).finally(() => { instance.buildOperations--; }); }
			});
			send(res, 202, { job: dto(job) }); return true;
		}
		if (route === "POST /api/novel-play/extend") {
			const input = await body(req); const binding = novelPlayBinding(host as NovelPlayModelHost);
			const baseDocId = text(input.baseDocId, "baseDocId", 200); const baseRevision = text(input.baseRevision, "baseRevision", 128); const targetDocId = text(input.targetDocId, "targetDocId", 200);
			readyCorpusSource(host.cwd, targetDocId);
			const active = [...instance.jobs.values()].filter(job => sameNovelPlayBinding(job.binding, binding) && !terminal(job.state));
			if (active.some(job => job.kind === "extension" && job.docId === targetDocId)) throw Object.assign(new Error("该追加作品包已在构建中"), { statusCode: 409 });
			if (instance.buildOperations >= NOVEL_PLAY_LIMITS.maxBuildOperations) throw Object.assign(new Error("小说构建队列已满"), { statusCode: 429 });
			const now = Date.now(); const job: Job = { id: randomBytes(16).toString("hex"), docId: targetDocId, binding, state: "queued", createdAt: now, updatedAt: now, controller: new AbortController(), progress: { completed: 0, total: 0 }, kind: "extension", parentDocId: baseDocId, parentRevision: baseRevision };
			instance.jobs.set(job.id, job); instance.buildOperations++;
			void Promise.resolve().then(async () => {
				job.state = "running"; job.updatedAt = Date.now(); const deadline = deadlineSignal(job.controller.signal, NOVEL_PLAY_LIMITS.buildDeadlineMs);
				const operation = extendPackageWithProgress(host as NovelPlayModelHost, baseDocId, baseRevision, targetDocId, deadline.signal, (completed, total) => { job.progress = { completed, total }; job.updatedAt = Date.now(); });
				try { job.result = await raceDeadline(operation, deadline.signal, "小说追加作品包构建超时"); if (!deadline.signal.aborted) job.state = "succeeded"; }
				catch (error) { if (!terminal(job.state)) { job.state = job.controller.signal.aborted && !deadline.expired() ? "cancelled" : "failed"; job.error = error instanceof Error ? error.message : String(error); } }
				finally { job.updatedAt = Date.now(); deadline.cleanup(); void operation.catch(() => {}).finally(() => { instance.buildOperations--; }); }
			});
			send(res, 202, { job: dto(job) }); return true;
		}
		if (route === "GET /api/novel-play/packages") {
			const workId = query.get("workId"); const entries = listNovelPackageIndex(host.cwd).filter(item => !workId || item.docId === workId || item.parentDocId === workId);
			send(res, 200, { packages: entries }); return true;
		}
		if (route === "POST /api/novel-play/upgrade/preview") {
			const input = await body(req); const targetDocId = text(input.targetDocId, "targetDocId", 200); const targetRevision = text(input.targetRevision, "targetRevision", 128);
			const binding = novelPlayBinding(host as NovelPlayModelHost); const value = host.novelPlayUpgradePreview(targetDocId, targetRevision) as Record<string, unknown>; const leafId = text(value.leafId, "leafId");
			const token = randomBytes(32).toString("base64url"); const expiresAt = Date.now() + NOVEL_PLAY_LIMITS.previewTokenTtlMs;
			instance.upgrades.set(token, { token, expiresAt, binding, leafId, targetDocId, targetRevision, digest: createUpgradeDigest(value) });
			send(res, 200, { preview: { ...value, token, expiresAt: new Date(expiresAt).toISOString() } }); return true;
		}
		if (route === "POST /api/novel-play/upgrade/commit") {
			const input = await body(req); const token = text(input.previewToken, "previewToken", 200); const preview = [...instance.upgrades.values()].find(item => tokenEqual(item.token, token));
			if (!preview || preview.expiresAt <= Date.now()) throw Object.assign(new Error("升级预览令牌无效或已过期"), { statusCode: 409 });
			bindingChecked(host as NovelPlayModelHost, preview.binding);
			const result = host.novelPlayUpgradeCommit(preview.targetDocId, preview.targetRevision, preview.leafId, preview.binding.revision); instance.upgrades.delete(preview.token);
			send(res, 200, { committed: result }); return true;
		}
		if (route === "POST /api/novel-play/profiles/apply") {
			const input = await body(req); const card = text(input.card, "card", 500); const docId = text(input.docId, "docId", 200); const revision = text(input.revision, "revision", 128);
			const result = applyCharacterProfilesToCard(host.cwd, card, docId, revision); send(res, 200, { applied: result }); return true;
		}
		if (route === "GET /api/novel-play/status") { send(res, 200, { jobs: [...instance.jobs.values()].filter(job => sameNovelPlayBinding(job.binding, current)).sort((a, b) => b.createdAt - a.createdAt).map(dto) }); return true; }
		const statusRoute = /^GET \/api\/novel-play\/status\/([a-f0-9]{32})$/.exec(route);
		if (statusRoute) { const job = instance.jobs.get(statusRoute[1]); if (!job || !sameNovelPlayBinding(job.binding, current)) throw Object.assign(new Error("构建任务不存在"), { statusCode: 404 }); send(res, 200, { job: dto(job) }); return true; }
		const cancelRoute = /^DELETE \/api\/novel-play\/status\/([a-f0-9]{32})$/.exec(route);
		if (cancelRoute) { const job = instance.jobs.get(cancelRoute[1]); if (!job || !sameNovelPlayBinding(job.binding, current)) throw Object.assign(new Error("构建任务不存在"), { statusCode: 404 }); if (!terminal(job.state)) { job.state = "cancelled"; job.updatedAt = Date.now(); delete job.result; job.controller.abort(new Error("已取消")); } send(res, 200, { job: dto(job) }); return true; }
		if (route === "GET /api/novel-play/start") { send(res, 200, { package: startOptions(host as NovelPlayModelHost, text(query.get("docId"), "docId", 200), text(query.get("revision"), "revision", 128)) }); return true; }
		if (route === "POST /api/novel-play/preview") {
			const input = await body(req); const binding = novelPlayBinding(host as NovelPlayModelHost); const player = input.player as Record<string, unknown> | undefined; const start = input.start as Record<string, unknown> | undefined; const startKind = start?.kind === "source-end" || input.startKind === "source-end" ? "source-end" : "node"; const position = input.position;
			if (startKind === "node" && position !== "before" && position !== "after") throw new Error("position 无效");
			if (startKind === "source-end" && input.continuationAcknowledged !== true && start?.continuationAcknowledged !== true) throw new Error("请确认从导入原文终点继续原创剧情");
			const mode = player?.mode === "existing-character" ? "existing-character" : "new-character";
			const parsed = { docId: text(input.docId, "docId", 200), revision: text(input.revision, "revision", 128), ...(startKind === "node" ? { nodeId: text(input.nodeId ?? start?.nodeId, "nodeId", 200), position: position as "before" | "after" } : { startKind: "source-end" as const }), player: { name: text(player?.name, "player.name", 120), identity: text(player?.identity, "player.identity", 1500), mode } };
			const recent = (instance.previewStarts.get(binding.sessionId) ?? []).filter(value => Date.now() - value < 60_000);
			if (recent.length >= NOVEL_PLAY_LIMITS.previewRequestsPerMinute || instance.previewOperations >= NOVEL_PLAY_LIMITS.maxPreviewOperations) throw Object.assign(new Error("预览请求过多"), { statusCode: 429 });
			recent.push(Date.now()); instance.previewStarts.set(binding.sessionId, recent); instance.previewOperations++;
			const request = requestSignal(req, res); const deadline = deadlineSignal(request.signal, NOVEL_PLAY_LIMITS.previewDeadlineMs); const operation = createOpeningProposal(host as NovelPlayModelHost, parsed, deadline.signal);
			void operation.catch(() => {}).finally(() => { instance.previewOperations--; deadline.cleanup(); request.cleanup(); });
			const generated = await raceDeadline(operation, deadline.signal, "开场预览超时"); bindingChecked(host as NovelPlayModelHost, binding);
			const token = randomBytes(32).toString("base64url"); const preview: Preview = { token, expiresAt: Date.now() + NOVEL_PLAY_LIMITS.previewTokenTtlMs, used: false, binding, ...generated }; instance.previews.set(token, preview);
			const output: PreviewPublicDto = { token, expiresAt: new Date(preview.expiresAt).toISOString(), package: { docId: generated.stored.package.docId, revision: generated.stored.package.revision }, anchor: generated.anchor, draft: generated.proposal.draft }; send(res, 200, { preview: output }); return true;
		}
		if (route === "POST /api/novel-play/start") {
			if (host.isStreaming()) throw Object.assign(new Error("正在生成回复，请稍候再开演"), { statusCode: 409 });
			const input = await body(req);
			if (instance.starting) throw Object.assign(new Error("小说开演正在启动"), { statusCode: 409 });
			const requested = text(input.previewToken, "previewToken", 200); const preview = [...instance.previews.values()].find(item => tokenEqual(item.token, requested));
			if (!preview || preview.used || preview.expiresAt <= Date.now()) throw Object.assign(new Error("预览令牌无效或已过期"), { statusCode: 409 });
			preview.used = true; instance.starting = true; instance.recovery = undefined;
			bindingChecked(host as NovelPlayModelHost, preview.binding);
			let preparedCard: string | undefined;
			const operation = startFromConfirmedProposal(host as NovelPlayModelHost, preview, preview.binding, card => { preparedCard = card; });
			let timer: ReturnType<typeof setTimeout> | undefined;
			const tracked = operation.then(result => ({ kind: "result" as const, result }), error => ({ kind: "error" as const, error })).finally(() => {
				try { novelPlayBinding(host as NovelPlayModelHost); instance.starting = false; instance.recovery = undefined; }
				catch { instance.recovery = { ...(preparedCard ? { card: preparedCard } : {}), session: "recovery-required", recovery: "角色切换结果不确定。为避免迟到的切换与新操作竞争，服务已保持锁定。请检查当前会话；若切换仍卡住，请重启服务后恢复。" }; }
			});
			const outcome = await Promise.race([tracked, new Promise<{ kind: "timeout" }>(resolve => { timer = setTimeout(() => resolve({ kind: "timeout" }), NOVEL_PLAY_LIMITS.startSwitchDeadlineMs); })]);
			if (timer) clearTimeout(timer);
			if (outcome.kind === "timeout") { instance.recovery = { ...(preparedCard ? { card: preparedCard } : {}), session: "recovery-required", recovery: "角色切换未在期限内完成，结果仍不确定。配置和生成角色卡已保留，危险操作继续锁定。请检查当前会话；若切换仍卡住，请重启服务后恢复。" }; send(res, 202, { started: instance.recovery }); return true; }
			if (outcome.kind === "error") throw outcome.error;
			send(res, outcome.result.session === "created" ? 201 : 202, { started: outcome.result }); return true;
		}
		send(res, 404, { error: `未知接口：${route}` }); return true;
	} catch (error) { const status = typeof (error as { statusCode?: unknown }).statusCode === "number" ? (error as { statusCode: number }).statusCode : 400; send(res, status, { error: error instanceof Error ? error.message : String(error) }); return true; }
}
