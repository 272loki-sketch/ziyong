import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { complete, getModel } from "../src/compat.ts";
import type { Context, Model } from "../src/types.ts";

interface MistralToolPayload {
	tools?: Array<{
		type: "function";
		function: {
			name: string;
			parameters: Record<string, unknown>;
		};
	}>;
}

describe("Mistral tool schema serialization", () => {
	it("keeps inline system messages at their original conversation position", async () => {
		const model: Model<"mistral-conversations"> = {
			...getModel("mistral", "devstral-medium-latest"),
			baseUrl: "https://synthetic.invalid",
		};
		const lore = "世界书原文｜第一段\n  第二段。";
		let capturedMessages: Array<{ role: string; content?: unknown }> | undefined;
		const result = await complete(
			model,
			{
				messages: [
					{ role: "user", content: "历史输入", timestamp: 1 },
					{ role: "system", content: [{ type: "text", text: lore }], timestamp: 0 },
					{ role: "user", content: "末轮输入", timestamp: 2 },
				],
			},
			{
				apiKey: "synthetic-not-a-real-key",
				onPayload: (payload) => {
					capturedMessages = (payload as { messages: Array<{ role: string; content?: unknown }> }).messages;
					throw new Error("stop after synthetic payload capture");
				},
			},
		);

		expect(capturedMessages?.map((message) => message.role)).toEqual(["user", "system", "user"]);
		expect(capturedMessages?.[1]?.content).toBe(lore);
		expect(result.stopReason).toBe("error");
	});

	it("strips TypeBox symbol keys before the SDK validates tool schemas", async () => {
		const model: Model<"mistral-conversations"> = {
			...getModel("mistral", "devstral-medium-latest"),
			baseUrl: "http://127.0.0.1:9",
		};
		const parameters = Type.Object({
			nested: Type.Object({
				value: Type.String(),
			}),
		});
		const context: Context = {
			messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
			tools: [
				{
					name: "inspect_schema",
					description: "Inspect the schema",
					parameters,
				},
			],
		};
		let capturedPayload: MistralToolPayload | undefined;

		const response = await complete(model, context, {
			apiKey: "fake-key",
			onPayload: (payload) => {
				capturedPayload = payload as MistralToolPayload;
				return payload;
			},
		});

		expect(capturedPayload?.tools).toHaveLength(1);
		const payloadParameters = capturedPayload?.tools?.[0]?.function.parameters;
		expect(payloadParameters).toBeDefined();
		expect(Object.getOwnPropertySymbols(payloadParameters ?? {})).toHaveLength(0);
		const properties = payloadParameters?.properties;
		expect(properties).toBeTruthy();
		expect(Object.getOwnPropertySymbols((properties as Record<string, unknown>) ?? {})).toHaveLength(0);
		const nested = (properties as Record<string, unknown> | undefined)?.nested;
		expect(nested).toBeTruthy();
		expect(Object.getOwnPropertySymbols((nested as Record<string, unknown>) ?? {})).toHaveLength(0);
		expect(response.stopReason).toBe("error");
		expect(response.errorMessage).not.toContain("Input validation failed");
	});
});
