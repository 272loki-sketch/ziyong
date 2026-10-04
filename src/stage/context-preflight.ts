/** Writer 输入预检只测量、不变换输入。估算不是供应商 tokenizer，绝不据此拒绝正文。 */
export interface WriterContextCheck {
	status: "unknown" | "ok" | "warning";
	inputChars?: number;
	estimatedInputTokens?: number;
	contextWindow?: number;
	reservedOutputTokens?: number;
}

export interface WriterContextDiagnostics extends WriterContextCheck {
	checks: number;
	warnings: number;
	confirmedOverflow: boolean;
}

const positive = (value: unknown): number | undefined =>
	typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;

export function inspectWriterContext(model: { contextWindow?: unknown }, context: unknown, maxTokens?: unknown): WriterContextCheck {
	const contextWindow = positive(model.contextWindow);
	if (!contextWindow) return { status: "unknown" };
	let serialized: string;
	try { serialized = JSON.stringify(context) ?? ""; } catch { return { status: "unknown" }; }
	// 包含 schema/消息封装的粗测量；只用于软警告，不解析正文中的任意格式。
	const estimatedInputTokens = Math.ceil(serialized.length / 3);
	const reservedOutputTokens = positive(maxTokens) ?? 0;
	return {
		status: estimatedInputTokens + reservedOutputTokens >= contextWindow * 0.85 ? "warning" : "ok",
		inputChars: serialized.length,
		estimatedInputTokens,
		contextWindow,
		reservedOutputTokens,
	};
}

/** 只认供应商明确描述的上下文/输入超限；TPM/速率限制和普通 max_tokens 验证不算。 */
export function isConfirmedContextOverflow(error: unknown): boolean {
	const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
	const explicitContextOverflow = /\bcontext_length_exceeded\b|\bmaximum context length\b|\bcontext (?:window|length)\b.{0,100}\b(?:exceed(?:s|ed)?|too (?:long|large)|limit reached)\b|\b(?:exceed(?:s|ed)?|too (?:long|large))\b.{0,80}\bcontext (?:window|length)\b|\bprompt is too long(?:\s*:|.{0,40}\btokens\b)|上下文(?:长度|窗口)?.{0,20}(?:超限|超出|超过)/i;
	if (explicitContextOverflow.test(message)) return true;
	if (/\b(?:tokens?\s*[- ]\s*per\s*[- ]\s*minute|tpm|rate[\s_-]*limit|quota)\b/i.test(message)) return false;
	return /\b(?:exceed(?:s|ed)?|too (?:long|large))\b.{0,80}\b(?:input|prompt)\s+tokens?\b|\b(?:input|prompt)\b.{0,40}\b(?:tokens?|length|size)\b.{0,80}\b(?:exceed(?:s|ed)?|too (?:long|large)|maximum|limit)\b/i.test(message);
}

export const CONTEXT_OVERFLOW_GUIDANCE = "供应商明确报告上下文超限，已停止重复发送相同超限输入。正文、历史和卡材料均未改动；可先执行安全压缩、减少非关键常驻材料，或选择更大上下文窗口的主演模型后重试。";

export class WriterContextPreflight {
	#diagnostics: WriterContextDiagnostics = { status: "unknown", checks: 0, warnings: 0, confirmedOverflow: false };
	#warned = false;
	#overflowWarned = false;
	check(model: { contextWindow?: unknown }, context: unknown, maxTokens: unknown, notify?: (message: string) => void): void {
		const check = inspectWriterContext(model, context, maxTokens);
		this.#diagnostics.checks++;
		if (check.status === "unknown") return;
		if (check.status === "warning") this.#diagnostics.warnings++;
		if ((check.inputChars ?? 0) >= (this.#diagnostics.inputChars ?? 0)) {
			this.#diagnostics = { ...this.#diagnostics, ...check };
		}
		if (check.status === "warning" && !this.#warned) {
			this.#warned = true;
			notify?.(`主演容量预检：输入约 ${check.inputChars} 字符，粗估输入及预留输出接近模型窗口 ${check.contextWindow} tokens。估算仅供诊断，不据此拒绝请求；本拍内容保持原样。`);
		}
	}
	confirmedOverflow(notify?: (message: string) => void): void {
		this.#diagnostics.confirmedOverflow = true;
		if (!this.#overflowWarned) { this.#overflowWarned = true; notify?.(CONTEXT_OVERFLOW_GUIDANCE); }
	}
	snapshot(): WriterContextDiagnostics { return { ...this.#diagnostics }; }
}
