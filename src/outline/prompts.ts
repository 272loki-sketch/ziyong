import type { OutlineChatRequest, OutlineProposal, OutlineState } from "./schema.ts";

function build(skillBody: string, material: unknown): { systemPrompt: string; userText: string } {
	return { systemPrompt: skillBody, userText: JSON.stringify(material, null, 2) };
}

export function buildOutlineChatPrompt(skillBody: string, input: { request: OutlineChatRequest; outline: OutlineState; context?: unknown }): { systemPrompt: string; userText: string } {
	return build(skillBody, { task: "outline-chat", current_outline: input.outline, request: input.request, context: input.context ?? null });
}

export function buildOutlineProposalPrompt(skillBody: string, input: { request: OutlineChatRequest; outline: OutlineState; context?: unknown }): { systemPrompt: string; userText: string } {
	return build(skillBody, { task: "outline-proposal", current_outline: input.outline, request: input.request, context: input.context ?? null });
}

export function buildOutlineAuditPrompt(skillBody: string, input: { outline: OutlineState; proposal: OutlineProposal; deterministicIssues: unknown[]; execution?: unknown }): { systemPrompt: string; userText: string } {
	return build(skillBody, { task: "outline-audit", current_outline: input.outline, proposal: input.proposal, deterministic_issues: input.deterministicIssues, execution: input.execution ?? null });
}
