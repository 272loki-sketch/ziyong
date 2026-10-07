/** Failure facts for bounded recovery; never prompts, API keys or raw provider payloads. */
export type ModelFailureKind = "auth" | "model" | "quota" | "rate-limit" | "timeout" | "transport" | "format" | "unknown";
export interface ModelAttemptDiagnostic {
	phase: string; step: string; provider: string; model: string; attempt: number;
	status: "success" | "failed" | "cancelled"; kind?: ModelFailureKind; statusCode?: number;
	durationMs: number; recovered?: boolean; reason?: string; validationOnly?: boolean;
}
export function classifyModelFailure(value: unknown): { kind: ModelFailureKind; retryable: boolean; statusCode?: number; reason: string } {
	const raw = value instanceof Error ? value.message : String(value ?? "模型请求失败");
	const code = /(?:^|[^\d])(400|401|402|403|404|408|409|422|429|500|502|503|504|520|522|523|524)(?:[^\d]|$)/.exec(raw);
	const statusCode = code ? Number(code[1]) : undefined;
	let kind: ModelFailureKind = "unknown";
	if ([401, 402, 403].includes(statusCode ?? 0) || /invalid[_ -]?api[_ -]?key|api key.*(?:invalid|expired)|unauthori[sz]ed|authentication|无可用.*key|no api key|凭证.*(?:过期|无效)/i.test(raw)) kind = "auth";
	else if (statusCode === 404 || /model.*(?:not found|does not exist|unavailable)|模型不存在|模型.*不可用/i.test(raw)) kind = "model";
	else if (/insufficient[_ -]?quota|quota.*exceeded|credit.*(?:exhausted|insufficient)|余额不足/i.test(raw)) kind = "quota";
	else if (statusCode === 429) kind = "rate-limit";
	else if ([408,504,522,524].includes(statusCode ?? 0) || /timeout|timed out|超时/i.test(raw)) kind = "timeout";
	else if ((statusCode ?? 0) >= 500 || /network|fetch failed|ECONN|EAI_AGAIN|socket|stream.*(?:ended|closed)|网络|断流/i.test(raw)) kind = "transport";
	else if (/JSON|schema|报告.*解析|无文本|no text|结构/i.test(raw)) kind = "format";
	const reason = raw.replace(/https?:\/\/[^\s"<>]+/gi, "[endpoint]").replace(/(?:Bearer\s+|(?:sk|key|token)[-_])[A-Za-z0-9._-]{12,}/gi, "[redacted]").slice(0, 240);
	return { kind, retryable: ["rate-limit", "timeout", "transport", "format"].includes(kind), ...(statusCode ? { statusCode } : {}), reason };
}
export function modelDiagnosticsView(value: unknown): ModelAttemptDiagnostic[] | undefined {
	if (!Array.isArray(value)) return undefined;
	return value.flatMap(x => {
		if (!x || typeof x !== "object" || !["success", "failed", "cancelled"].includes(x.status)) return [];
		const text = (v: unknown) => typeof v === "string" ? v.slice(0, 180) : "";
		return [{ phase: text(x.phase), step: text(x.step), provider: text(x.provider), model: text(x.model), attempt: Math.max(1,Math.min(8,Number(x.attempt)||1)), status:x.status,
			...(x.kind ? { kind: ["auth","model","quota","rate-limit","timeout","transport","format","unknown"].includes(x.kind) ? x.kind : classifyModelFailure(x.reason).kind } : {}), ...(Number.isInteger(x.statusCode) ? { statusCode:x.statusCode } : {}),
			durationMs: Math.max(0,Math.min(7200000,Number(x.durationMs)||0)), ...(x.recovered ? { recovered:true } : {}), ...(x.validationOnly===true ? {validationOnly:true} : {}), ...(x.reason ? { reason:classifyModelFailure(x.reason).reason } : {}) } as ModelAttemptDiagnostic];
	}).slice(-100);
}

/** Only explicit rejection of the capability, never invalid arguments/schema or an upstream outage. */
export function isNativeToolsUnsupported(error: string): boolean {
	if (/invalid.*(?:schema|parameters|arguments)|(?:schema|parameters|arguments).*invalid|tools?\[\d+\]|tool[_ -]?choice|reasoning[_ -]?effort/i.test(error)) return false;
	return /(?:does not|doesn't|cannot) support (?:native |function |parallel )?(?:tools?|function[ _-]?calling)|(?:tools?|function[ _-]?calling) (?:are |is )?(?:not supported|unsupported|not allowed|disabled)|unsupported (?:parameter|feature)[: ]+["']?(?:tools|functions)["']?(?:\W|$)|unknown parameter[: ]+["']?(?:tools|functions)["']?(?:\W|$)|(?:不支持|未支持|不允许|已禁用).{0,12}(?:原生)?(?:工具调用|函数调用)/i.test(error);
}
