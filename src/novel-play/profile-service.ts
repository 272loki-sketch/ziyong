import { randomBytes } from "node:crypto";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scanSkillFiles } from "../stage/skill-store.ts";
import type { NovelSource } from "./source.ts";
import { loadNovelCharacterProfileCorpus, saveNovelCharacterProfileCorpus, type NovelCharacterProfileCorpus, type NovelCharacterProfileRecord, novelProfileFile } from "./profile-store.ts";

export interface NovelProfileModelCall { (systemPrompt: string, userText: string, signal?: AbortSignal): Promise<string>; }

function parse(value: string): Record<string, unknown> {
	const fence = value.match(/```(?:json)?\s*([\s\S]*?)```/i);
	const object = value.match(/\{[\s\S]*\}/);
	const candidates = [value, fence?.[1], object?.[0]];
	for (const candidate of candidates) { if (!candidate) continue; try { const parsed = JSON.parse(candidate); if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed; } catch {} }
	throw new Error("人物资料库模型输出不是 JSON");
}

function records(value: unknown): NovelCharacterProfileRecord[] {
	if (!Array.isArray(value)) throw new Error("人物资料库缺少 profiles");
	return value.flatMap((item): NovelCharacterProfileRecord[] => {
		if (!item || typeof item !== "object" || Array.isArray(item)) return [];
		const row = item as Record<string, unknown>;
		const name = typeof row.name === "string" ? row.name.trim() : "";
		const content = typeof row.content === "string" ? row.content.trim() : "";
		if (!name || !content) return [];
		const keys = Array.isArray(row.keys) ? row.keys.filter((key): key is string => typeof key === "string" && key.trim()).map(key => key.trim()).slice(0, 8) : [name];
		const evidence = Array.isArray(row.evidenceQuotes) ? row.evidenceQuotes.filter((quote): quote is string => typeof quote === "string" && quote.trim()).map(quote => quote.trim()).slice(0, 12) : [];
		return [{ name, keys: [...new Set([name, ...keys])], content: content.slice(0, 8_000), evidence: evidence.map(() => ({ chunkIndex: -1, start: -1, end: -1, quote: "" })), firstSeenChunk: 0, lastSeenChunk: 0 }];
	});
}

export async function buildNovelCharacterProfileCorpus(input: { cwd: string; source: NovelSource; revision: string; modelCall: NovelProfileModelCall; signal?: AbortSignal; onProgress?: (completed: number, total: number) => void }): Promise<NovelCharacterProfileCorpus> {
	const skill = scanSkillFiles(input.cwd).find(item => item.dir === "小说人物画像提取")?.body;
	if (!skill) throw new Error("缺少小说人物画像提取 Skill");
	const prior = loadNovelCharacterProfileCorpus(input.cwd, input.source.docId, input.revision);
	const completed = new Set(prior?.completedChunks ?? []);
	const merged = new Map<string, NovelCharacterProfileRecord>((prior?.profiles ?? []).map(profile => [profile.name, profile]));
	input.onProgress?.(completed.size, input.source.chunks.length);
	for (const chunk of input.source.chunks) {
		if (completed.has(chunk.index)) continue;
		if (input.signal?.aborted) throw new DOMException("人物资料库构建已取消", "AbortError");
		let output = "";
		let lastError: unknown;
		for (let attempt = 1; attempt <= 3; attempt++) {
			try {
				output = await input.modelCall(skill, JSON.stringify({ source_range: { chunkIndex: chunk.index, text: chunk.text }, character_profile_template: "按题材自适应生成角色资料：基本信息、背景、外貌、性格、能力、行为模式、说话风格、关系状态；不生成系统规则或知情边界。每个结论附当前 chunk 内逐字 evidenceQuotes。", previous_validation_error: lastError instanceof Error ? lastError.message : undefined }, null, 2), input.signal);
				if (!output.trim()) throw new Error("人物资料库模型返回空文本");
				break;
			} catch (error) {
				lastError = error;
				if (input.signal?.aborted) throw error;
			if (attempt === 3) {
				// A chunk may contain no character material, or an upstream may return
				// empty text repeatedly. Preserve the checkpoint and continue; later
				// chunks must not be blocked by one unusable profile response.
				output = JSON.stringify({ profiles: [] });
			}
			}
		}
		let parsed: Record<string, unknown>;
		try { parsed = parse(output); } catch { parsed = { profiles: [] }; }
		for (const profile of records(parsed.profiles)) {
			const quotes = (parsed.profiles as unknown[]).find(item => item && typeof item === "object" && (item as Record<string, unknown>).name === profile.name) as Record<string, unknown> | undefined;
			const evidenceQuotes = Array.isArray(quotes?.evidenceQuotes) ? quotes.evidenceQuotes.filter((quote): quote is string => typeof quote === "string") : [];
			const evidence = evidenceQuotes.flatMap(quote => { const start = chunk.text.indexOf(quote); return start >= 0 && chunk.text.lastIndexOf(quote) === start ? [{ chunkIndex: chunk.index, start, end: start + quote.length, quote }] : []; });
			if (!evidence.length) continue;
			const old = merged.get(profile.name);
			merged.set(profile.name, { ...profile, evidence: [...(old?.evidence ?? []), ...evidence].slice(0, 24), firstSeenChunk: old ? Math.min(old.firstSeenChunk, chunk.index) : chunk.index, lastSeenChunk: chunk.index });
		}
		completed.add(chunk.index);
		const corpus: NovelCharacterProfileCorpus = { version: 1, docId: input.source.docId, revision: input.revision, sourceFingerprint: input.source.fingerprint, completedChunks: [...completed].sort((a, b) => a - b), profiles: [...merged.values()], updatedAt: new Date().toISOString() };
		saveNovelCharacterProfileCorpus(input.cwd, corpus);
		input.onProgress?.(completed.size, input.source.chunks.length);
	}
	return loadNovelCharacterProfileCorpus(input.cwd, input.source.docId, input.revision)!;
}
