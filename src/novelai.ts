import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import https from "node:https";
import net from "node:net";
import { join } from "node:path";
import tls from "node:tls";

import { dir } from "./paths.ts";
import { firstZipEntry } from "./ziplite.ts";

export interface NovelAiConfig {
	enabled: boolean;
	baseUrl: string;
	apiKey: string;
	model: string;
	sampler: string;
	scheduler: string;
	steps: number;
	scale: number;
	cfgRescale: number;
	width: number;
	height: number;
	positivePrefix: string;
	positiveSuffix: string;
	negativePrompt: string;
}

export const DEFAULT_NOVELAI_CONFIG: NovelAiConfig = {
	enabled: false,
	baseUrl: "https://image.novelai.net",
	apiKey: "",
	model: "nai-diffusion-4-5-full",
	sampler: "k_dpmpp_2m",
	scheduler: "karras",
	steps: 28,
	scale: 10,
	cfgRescale: 0.18,
	width: 1024,
	height: 1024,
	positivePrefix: "",
	positiveSuffix: "",
	negativePrompt: "",
};

const configPath = (cwd: string) => join(cwd, ".liyuan", "novelai.json");
const cachePath = (cwd: string) => join(cwd, ".liyuan", "novelai-image-cache.json");
const pendingImages = new Map<string, Promise<{ src: string; bytes: number }>>();
let imageCacheWrite: Promise<void> = Promise.resolve();

export function loadNovelAiConfig(cwd: string): NovelAiConfig {
	try {
		const raw = JSON.parse(readFileSync(configPath(cwd), "utf8")) as Partial<NovelAiConfig>;
		return { ...DEFAULT_NOVELAI_CONFIG, ...raw };
	} catch {
		return { ...DEFAULT_NOVELAI_CONFIG };
	}
}

export function saveNovelAiConfig(cwd: string, config: NovelAiConfig): void {
	mkdirSync(join(cwd, ".liyuan"), { recursive: true });
	writeFileSync(configPath(cwd), `${JSON.stringify(config, null, "\t")}\n`, { encoding: "utf8", mode: 0o600 });
}

const clamp = (value: unknown, min: number, max: number, fallback: number): number => {
	const n = Number(value);
	return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
};

export function updateNovelAiConfig(cwd: string, patch: Partial<NovelAiConfig>): NovelAiConfig {
	const current = loadNovelAiConfig(cwd);
	const apiKey = typeof patch.apiKey === "string" && patch.apiKey && patch.apiKey !== "••••••••" ? patch.apiKey.trim() : current.apiKey;
	const parsed = new URL(typeof patch.baseUrl === "string" && patch.baseUrl.trim() ? patch.baseUrl.trim() : current.baseUrl);
	if (parsed.protocol !== "https:" && parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost") throw new Error("NovelAI 接口必须使用 HTTPS");
	const next: NovelAiConfig = {
		...current,
		...patch,
		apiKey,
		baseUrl: parsed.toString().replace(/\/$/, ""),
		model: String(patch.model ?? current.model).trim() || DEFAULT_NOVELAI_CONFIG.model,
		sampler: String(patch.sampler ?? current.sampler).trim() || DEFAULT_NOVELAI_CONFIG.sampler,
		scheduler: String(patch.scheduler ?? current.scheduler).trim() || DEFAULT_NOVELAI_CONFIG.scheduler,
		steps: Math.round(clamp(patch.steps, 1, 50, current.steps)),
		scale: clamp(patch.scale, 0, 20, current.scale),
		cfgRescale: clamp(patch.cfgRescale, 0, 1, current.cfgRescale),
		width: Math.round(clamp(patch.width, 64, 2048, current.width) / 64) * 64,
		height: Math.round(clamp(patch.height, 64, 2048, current.height) / 64) * 64,
		positivePrefix: String(patch.positivePrefix ?? current.positivePrefix),
		positiveSuffix: String(patch.positiveSuffix ?? current.positiveSuffix),
		negativePrompt: String(patch.negativePrompt ?? current.negativePrompt),
		enabled: patch.enabled === undefined ? current.enabled : patch.enabled === true,
	};
	saveNovelAiConfig(cwd, next);
	return next;
}

export function publicNovelAiConfig(config: NovelAiConfig) {
	return { ...config, apiKey: config.apiKey ? "••••••••" : "", apiKeyConfigured: Boolean(config.apiKey) };
}

export function novelAiAvailable(cwd: string): boolean {
	const c = loadNovelAiConfig(cwd);
	return c.enabled && Boolean(c.apiKey.trim());
}

export interface NovelAiPrompt {
	scene: string;
	characters: Array<{ prompt: string; uc: string; center: { x: number; y: number } }>;
	negativePrompt?: string;
}

/** 智慧姬 image### 格式及普通 Danbooru tags 均可输入。 */
export function parseNovelAiPrompt(raw: string): NovelAiPrompt {
	const inner = raw.match(/image###([\s\S]*?)###/i)?.[1]?.trim() || raw.trim();
	const scene = inner.match(/Scene Composition\s*:\s*([^\n]+)/i)?.[1]?.trim();
	if (!scene) return { scene: inner, characters: [] };
	const characters: NovelAiPrompt["characters"] = [];
	for (let i = 1; i <= 8; i++) {
		const prompt = inner.match(new RegExp(`Character ${i} Prompt\\s*:\\s*([^\\n]+)`, "i"))?.[1]?.trim();
		if (!prompt) continue;
		const uc = inner.match(new RegExp(`Character ${i} UC\\s*:\\s*([^\\n]+)`, "i"))?.[1]?.trim() || "";
		const centerMatch = prompt.match(/\|\s*centers?\s*:\s*([\d.]+)\s*[,，]\s*([\d.]+)/i);
		characters.push({
			prompt: prompt.replace(/\|\s*centers?\s*:[^;\n]*/i, "").trim(),
			uc,
			center: centerMatch ? { x: Number(centerMatch[1]), y: Number(centerMatch[2]) } : { x: 0.5, y: 0.5 },
		});
	}
	return { scene, characters };
}

function endpoint(base: string): string {
	const clean = base.trim().replace(/\/+$/, "") || DEFAULT_NOVELAI_CONFIG.baseUrl;
	return /\/ai\/generate-image$/i.test(clean) ? clean : `${clean}/ai/generate-image`;
}

function buildPayload(config: NovelAiConfig, prompt: NovelAiPrompt, seed?: number) {
	const baseCaption = [config.positivePrefix, prompt.scene, config.positiveSuffix].filter(Boolean).join(", ");
	const negative = [config.negativePrompt, prompt.negativePrompt].filter(Boolean).join(", ");
	const charCaptions = prompt.characters.map((c) => ({ char_caption: c.prompt, centers: [c.center] }));
	const negativeChars = prompt.characters.map((c) => ({ char_caption: c.uc, centers: [c.center] }));
	const useCoords = prompt.characters.some((c) => c.center.x !== 0.5 || c.center.y !== 0.5);
	return {
		action: "generate",
		input: baseCaption,
		model: config.model,
		parameters: {
			params_version: 3,
			width: config.width,
			height: config.height,
			scale: config.scale,
			seed: Number.isInteger(seed) && seed! >= 0 ? seed : Math.floor(Math.random() * 0xffffffff),
			sampler: config.sampler,
			noise_schedule: config.scheduler,
			steps: config.steps,
			n_samples: 1,
			ucPreset: 0,
			qualityToggle: true,
			autoSmea: false,
			cfg_rescale: config.cfgRescale,
			dynamic_thresholding: false,
			controlnet_strength: 1,
			legacy: false,
			legacy_v3_extend: false,
			use_coords: useCoords,
			legacy_uc: false,
			normalize_reference_strength_multiple: true,
			deliberate_euler_ancestral_bug: false,
			prefer_brownian: true,
			image_format: "png",
			skip_cfg_above_sigma: null,
			characterPrompts: prompt.characters.map((c) => ({ prompt: c.prompt, uc: c.uc, center: c.center, enabled: true })),
			v4_prompt: { caption: { base_caption: baseCaption, char_captions: charCaptions }, use_coords: useCoords, use_order: true },
			v4_negative_prompt: { caption: { base_caption: negative, char_captions: negativeChars }, legacy_uc: false },
			negative_prompt: negative,
		},
	};
}

function imageFromResponse(buffer: Buffer, contentType: string): { data: Buffer; ext: string } {
	if (/zip/i.test(contentType) || (buffer.length >= 4 && buffer.readUInt32LE(0) === 0x04034b50)) {
		const hit = firstZipEntry(buffer, (e) => /\.(png|jpe?g|webp)$/i.test(e.name));
		if (!hit) throw new Error("NovelAI 返回的压缩包中没有图片");
		const ext = hit.entry.name.match(/\.(png|jpe?g|webp)$/i)?.[1]?.toLowerCase() || "png";
		return { data: hit.data, ext: ext === "jpeg" ? "jpg" : ext };
	}
	if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { data: buffer, ext: "png" };
	if (buffer[0] === 0xff && buffer[1] === 0xd8) return { data: buffer, ext: "jpg" };
	throw new Error("NovelAI 返回了不支持的图片格式");
}

async function postNovelAi(url: string, apiKey: string, payload: unknown, signal?: AbortSignal): Promise<{ ok: boolean; status: number; contentType: string; body: Buffer }> {
	const proxyRaw = process.env.LIYUAN_NOVELAI_PROXY ?? process.env.LIYUAN_WEB_RESEARCH_PROXY ?? "http://127.0.0.1:7890";
	if (!proxyRaw || proxyRaw.toLowerCase() === "direct") {
		const response = await fetch(url, {
			method: "POST",
			headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json", accept: "application/zip, image/*" },
			body: JSON.stringify(payload),
			signal,
		});
		return { ok: response.ok, status: response.status, contentType: response.headers.get("content-type") || "", body: Buffer.from(await response.arrayBuffer()) };
	}
	const target = new URL(url);
	const proxy = new URL(proxyRaw.includes("://") ? proxyRaw : `http://${proxyRaw}`);
	const socket = await new Promise<tls.TLSSocket>((resolve, reject) => {
		const raw = net.connect({ host: proxy.hostname, port: Number(proxy.port || 80) });
		let response = "";
		const fail = (error: unknown) => { raw.destroy(); reject(error instanceof Error ? error : new Error(String(error))); };
		const abort = () => fail(signal?.reason ?? new Error("NovelAI 生图已取消"));
		if (signal?.aborted) return abort();
		signal?.addEventListener("abort", abort, { once: true });
		raw.once("error", fail);
		raw.once("connect", () => raw.write(`CONNECT ${target.hostname}:443 HTTP/1.1\r\nHost: ${target.hostname}:443\r\n\r\n`));
		raw.on("data", (chunk) => {
			response += chunk.toString("latin1");
			if (!response.includes("\r\n\r\n")) return;
			const status = response.slice(0, response.indexOf("\r\n"));
			if (!/^HTTP\/1\.[01] 2\d\d /.test(status)) return fail(new Error(`代理 CONNECT 失败：${status}`));
			signal?.removeEventListener("abort", abort);
			resolve(tls.connect({ socket: raw, servername: target.hostname }));
		});
	});
	const encoded = JSON.stringify(payload);
	return new Promise((resolve, reject) => {
		const req = https.request({
			host: target.hostname,
			path: `${target.pathname}${target.search}`,
			method: "POST",
			createConnection: () => socket,
			headers: {
				authorization: `Bearer ${apiKey}`,
				"content-type": "application/json",
				accept: "application/zip, image/*",
				"content-length": Buffer.byteLength(encoded),
			},
		}, (response) => {
			const chunks: Buffer[] = [];
			let size = 0;
			response.on("data", (chunk) => {
				size += chunk.length;
				if (size > 64 * 1024 * 1024) req.destroy(new Error("NovelAI 响应超过 64 MiB"));
				else chunks.push(Buffer.from(chunk));
			});
			response.on("end", () => {
				const status = response.statusCode ?? 0;
				resolve({ ok: status >= 200 && status < 300, status, contentType: String(response.headers["content-type"] ?? ""), body: Buffer.concat(chunks) });
			});
		});
		req.on("error", reject);
		if (signal) signal.addEventListener("abort", () => req.destroy(signal.reason as Error), { once: true });
		req.end(encoded);
	});
}

export async function generateNovelAiImage(
	cwd: string,
	rawPrompt: string,
	opts?: { negativePrompt?: string; seed?: number; signal?: AbortSignal; fetchFn?: typeof fetch },
): Promise<{ src: string; bytes: number }> {
	const config = loadNovelAiConfig(cwd);
	if (!config.enabled || !config.apiKey.trim()) throw new Error("NovelAI 生图尚未配置");
	const prompt = parseNovelAiPrompt(rawPrompt);
	if (!prompt.scene.trim()) throw new Error("生图提示词为空");
	prompt.negativePrompt = opts?.negativePrompt;
	const payload = buildPayload(config, prompt, opts?.seed);
	const timeout = AbortSignal.timeout(120_000);
	const signal = opts?.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
	const response = opts?.fetchFn
		? await (async () => {
			const r = await opts.fetchFn!(endpoint(config.baseUrl), { method: "POST", headers: { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json", accept: "application/zip, image/*" }, body: JSON.stringify(payload), signal });
			return { ok: r.ok, status: r.status, contentType: r.headers.get("content-type") || "", body: Buffer.from(await r.arrayBuffer()) };
		})()
		: await postNovelAi(endpoint(config.baseUrl), config.apiKey, payload, signal);
	if (!response.ok) throw new Error(`NovelAI 生图失败（HTTP ${response.status}）：${response.body.toString("utf8").slice(0, 500)}`);
	const image = imageFromResponse(response.body, response.contentType);
	const mediaDir = dir(cwd, "media");
	mkdirSync(mediaDir, { recursive: true });
	const name = `${createHash("md5").update(image.data).digest("hex").slice(0, 16)}.${image.ext}`;
	const path = join(mediaDir, name);
	if (!existsSync(path)) writeFileSync(path, image.data);
	return { src: `/media/${name}`, bytes: image.data.length };
}

type NovelAiImageCache = Record<string, { src: string; bytes: number }>;

function imageCacheKey(cwd: string, rawPrompt: string, opts?: { negativePrompt?: string; seed?: number }): string {
	const config = loadNovelAiConfig(cwd);
	const normalizePrompt = (value: string): string => value.replace(/\r\n?/g, "\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
	return createHash("sha256").update(JSON.stringify({
		prompt: normalizePrompt(rawPrompt),
		negativePrompt: normalizePrompt(opts?.negativePrompt ?? ""),
		seed: Number.isInteger(opts?.seed) ? opts?.seed : null,
		model: config.model,
		sampler: config.sampler,
		scheduler: config.scheduler,
		steps: config.steps,
		scale: config.scale,
		cfgRescale: config.cfgRescale,
		width: config.width,
		height: config.height,
		positivePrefix: config.positivePrefix,
		positiveSuffix: config.positiveSuffix,
		configNegativePrompt: config.negativePrompt,
	})).digest("hex");
}

function readImageCache(cwd: string): NovelAiImageCache {
	try {
		const value = JSON.parse(readFileSync(cachePath(cwd), "utf8"));
		return value && typeof value === "object" && !Array.isArray(value) ? value as NovelAiImageCache : {};
	} catch {
		return {};
	}
}

function cachedImageExists(cwd: string, entry: { src: string; bytes: number } | undefined): entry is { src: string; bytes: number } {
	const match = entry?.src.match(/^\/media\/([A-Za-z0-9._-]+)$/);
	return !!match && existsSync(join(dir(cwd, "media"), match[1]));
}

/** 只查询已有图片，不触发生图请求；页面刷新时优先走这条。 */
export function getCachedNovelAiImage(cwd: string, rawPrompt: string, opts?: { negativePrompt?: string; seed?: number }): { src: string; bytes: number } | null {
	const cached = readImageCache(cwd)[imageCacheKey(cwd, rawPrompt, opts)];
	return cachedImageExists(cwd, cached) ? cached : null;
}

function writeImageCache(cwd: string, value: NovelAiImageCache): void {
	mkdirSync(join(cwd, ".liyuan"), { recursive: true });
	const path = cachePath(cwd);
	const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(value, null, "\t")}\n`, { encoding: "utf8", mode: 0o600 });
	renameSync(temporary, path);
}

/**
 * 剧情图片按「提示词 + 生图配置」持久化复用。刷新页面会再次请求该槽位，
 * 但命中后只返回既有 /media 文件；同一时刻的重复挂载也共享一条生成 Promise。
 */
export async function generateNovelAiImageCached(
	cwd: string,
	rawPrompt: string,
	opts?: { negativePrompt?: string; seed?: number; signal?: AbortSignal; fetchFn?: typeof fetch },
): Promise<{ src: string; bytes: number }> {
	const key = imageCacheKey(cwd, rawPrompt, opts);
	const cached = readImageCache(cwd)[key];
	if (cachedImageExists(cwd, cached)) return cached;
	const pendingKey = `${cwd}\0${key}`;
	const existing = pendingImages.get(pendingKey);
	if (existing) return existing;
	const task = generateNovelAiImage(cwd, rawPrompt, opts).then(async (result) => {
		imageCacheWrite = imageCacheWrite.then(() => {
			const cache = readImageCache(cwd);
			cache[key] = result;
			writeImageCache(cwd, cache);
		});
		await imageCacheWrite;
		return result;
	}).finally(() => pendingImages.delete(pendingKey));
	pendingImages.set(pendingKey, task);
	return task;
}
