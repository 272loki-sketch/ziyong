/** 剧情生成模式。连接 hello 或配置未提供时采用完整导演流程。 */
export type GenerationMode = "direct" | "director";
export const DEFAULT_GENERATION_MODE: GenerationMode = "director";

export function isGenerationMode(value: unknown): value is GenerationMode {
	return value === "direct" || value === "director";
}

export function resolveGenerationMode(value: unknown): GenerationMode {
	return isGenerationMode(value) ? value : DEFAULT_GENERATION_MODE;
}

export interface StoryPromptFrame {
	type: "prompt";
	text: string;
	generationMode?: GenerationMode;
}

/**
 * 固定一条新剧情输入的模式快照。命令与 assistant 帧不带 generationMode；
 * outbox 重放不调用此函数，而是原样使用持久化帧。
 */
export function pinGenerationMode<T extends { type: "prompt"; text: string }>(
	frame: T,
	mode: unknown,
): T & { generationMode?: GenerationMode };
export function pinGenerationMode<T extends { type: string; text?: string }>(frame: T, mode: unknown): T;
export function pinGenerationMode<T extends { type: string; text?: string }>(frame: T, mode: unknown): T {
	if (frame.type !== "prompt" || typeof frame.text !== "string" || frame.text.trimStart().startsWith("/")) return frame;
	return { ...frame, generationMode: resolveGenerationMode(mode) };
}

/** 主输入框与程序卡共用：控制命令保留原协议，不附剧情模式。 */
export function buildStoryPromptFrame(text: string, mode: unknown): StoryPromptFrame {
	return pinGenerationMode({ type: "prompt" as const, text }, mode);
}

export interface RestoredPromptMode {
	text: string;
	generationMode: GenerationMode;
}

/** 旧版恢复草稿没有模式时，剧情正文按默认 director 恢复；命令仍不带模式。 */
export function restoredPromptMode(text: string, mode: unknown): RestoredPromptMode | null {
	if (text.trimStart().startsWith("/")) return null;
	return { text, generationMode: resolveGenerationMode(mode) };
}

/** 原样恢复的草稿使用自己的模式快照；文本被编辑后回到当前选择。 */
export function modeForPromptSubmission(
	text: string,
	selectedMode: GenerationMode,
	restored: RestoredPromptMode | null,
): GenerationMode {
	return restored?.text === text ? restored.generationMode : selectedMode;
}
