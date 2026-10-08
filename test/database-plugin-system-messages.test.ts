import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import type { AddressInfo } from "node:net";
import { streamSimple as streamSimpleFromDist } from "@liyuan/ai/compat";
import { convertMessages } from "../packages/ai/src/api/openai-completions.ts";
import { convertResponsesMessages } from "../packages/ai/src/api/openai-responses-shared.ts";
import { transformMessages } from "../packages/ai/src/api/transform-messages.ts";
import type { Context, Model } from "../packages/ai/src/types.ts";

const prefixSystem = "梨园前缀｜第一行\n第二行：保持原样。";
const historyUser = "历史用户输入：旧分支事实 A。";
const historyAssistant = "历史助手正文：旧分支事实 B。";
const depthSystem = "世界书条目〔position=before_char，depth=2〕\n  原文空格与换行不改；“引号”✓。";
const finalWritebackInput = "数据库插件末轮填表输入：\n只写已提交事实，不改写正文。";

function makeModel(baseUrl: string, reasoning = false): Model<"openai-completions"> {
	return {
		id: "synthetic-database-plugin-model",
		name: "Synthetic database plugin model",
		api: "openai-completions",
		provider: "synthetic-database-plugin",
		baseUrl,
		reasoning,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 32_000,
		maxTokens: 256,
		compat: {
			supportsDeveloperRole: false,
			supportsStore: false,
			supportsUsageInStreaming: false,
		},
	};
}

function makeContext(): Context {
	const model = makeModel("http://127.0.0.1:1");
	return {
		// The normal plugin prefix remains the leading systemPrompt. The depth
		// entry is an inline system message, matching the StageEngine contract.
		systemPrompt: prefixSystem,
		messages: [
			{ role: "user", content: [{ type: "text", text: historyUser }], timestamp: 1 },
			{
				role: "assistant",
				content: [{ type: "text", text: historyAssistant }],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: 2,
			},
			{ role: "system", content: [{ type: "text", text: depthSystem }], timestamp: 0 },
			{ role: "user", content: [{ type: "text", text: finalWritebackInput }], timestamp: 3 },
		],
	};
}

function assertUtf8Equal(actual: string, expected: string, label: string): void {
	assert.deepEqual(Buffer.from(actual, "utf8"), Buffer.from(expected, "utf8"), label);
}

function textOfChatMessage(message: { content?: unknown }): string {
	if (typeof message.content === "string") return message.content;
	assert.ok(Array.isArray(message.content), "expected string or text-part content");
	return message.content
		.map((part: { text?: unknown }) => {
			assert.equal(typeof part.text, "string");
			return part.text as string;
		})
		.join("");
}

test("database plugin inline system lore survives transform and the real Chat Completions HTTP request", async () => {
	const context = makeContext();
	const model = makeModel("http://127.0.0.1:1");
	const transformed = transformMessages(context.messages, model);
	assert.deepEqual(
		transformed.map((message) => message.role),
		["user", "assistant", "system", "user"],
		"transformMessages must preserve the inline lore position",
	);
	const transformedLore = transformed[2];
	assert.equal(transformedLore?.role, "system");
	if (transformedLore?.role === "system") {
		assertUtf8Equal(transformedLore.content.map((part) => part.text).join(""), depthSystem, "transformed lore bytes");
	}

	let requestPath: string | undefined;
	let requestBody: { messages: Array<{ role: string; content?: unknown }> } | undefined;
	const server = createServer((request, response) => {
		void (async () => {
			requestPath = request.url;
			let rawBody = "";
			for await (const chunk of request) rawBody += chunk.toString();
			requestBody = JSON.parse(rawBody) as typeof requestBody;

			response.writeHead(200, {
				"content-type": "text/event-stream",
				"cache-control": "no-cache",
				connection: "keep-alive",
			});
			response.write(
				`data: ${JSON.stringify({
					id: "chatcmpl-synthetic-database-plugin",
					object: "chat.completion.chunk",
					created: 0,
					model: "synthetic-database-plugin-model",
					choices: [{ index: 0, delta: { role: "assistant", content: "synthetic ok" }, finish_reason: null }],
				})}\n\n`,
			);
			response.write(
				`data: ${JSON.stringify({
					id: "chatcmpl-synthetic-database-plugin",
					object: "chat.completion.chunk",
					created: 0,
					model: "synthetic-database-plugin-model",
					choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
					usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
				})}\n\n`,
			);
			response.end("data: [DONE]\n\n");
		})();
	});

	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	try {
		const { port } = server.address() as AddressInfo;
		const liveModel = makeModel(`http://127.0.0.1:${port}`);
		const liveContext = { ...context, messages: context.messages };
		const result = await streamSimpleFromDist(liveModel, liveContext, {
			apiKey: "synthetic-not-a-real-key",
			cacheRetention: "none",
			maxRetries: 0,
			timeoutMs: 5_000,
		}).result();

		assert.equal(result.stopReason, "stop");
		assert.equal(requestPath, "/chat/completions", "must capture the actual local OpenAI-compatible endpoint");
		assert.ok(requestBody, "the synthetic HTTP server must capture a request body");
		const messages = requestBody.messages;
		assert.deepEqual(messages.map((message) => message.role), ["system", "user", "assistant", "system", "user"]);
		const expectedTexts = [prefixSystem, historyUser, historyAssistant, depthSystem, finalWritebackInput];
		messages.forEach((message, index) => {
			assertUtf8Equal(textOfChatMessage(message), expectedTexts[index]!, `serialized message ${index} bytes`);
		});
	} finally {
		server.closeAllConnections();
		await new Promise<void>((resolve, reject) => {
			server.close((error) => (error ? reject(error) : resolve()));
		});
	}
});

test("Chat Completions uses the existing developer-role compatibility rule for inline system messages", () => {
	const context = makeContext();
	const reasoningModel = makeModel("https://synthetic.invalid/v1", true);
	const developerMessages = convertMessages(reasoningModel, context, { supportsDeveloperRole: true } as never);
	assert.deepEqual(developerMessages.map((message) => message.role), ["developer", "user", "assistant", "developer", "user"]);

	const systemMessages = convertMessages(reasoningModel, context, { supportsDeveloperRole: false } as never);
	assert.deepEqual(systemMessages.map((message) => message.role), ["system", "user", "assistant", "system", "user"]);
});

test("OpenAI Responses keeps inline lore as a system message at its original position", () => {
	const context = makeContext();
	const completionsModel = makeModel("https://synthetic.invalid/v1");
	const responsesModel = { ...completionsModel, api: "openai-responses" } as Model<"openai-responses">;
	const input = convertResponsesMessages(responsesModel, context, new Set());
	assert.deepEqual(input.map((item) => ("role" in item ? item.role : item.type)), ["system", "user", "assistant", "system", "user"]);
	const prefix = input[0];
	assert.ok(prefix && "role" in prefix && prefix.role === "system");
	if (prefix && "role" in prefix && prefix.role === "system") {
		assert.equal(prefix.content, prefixSystem);
		assertUtf8Equal(prefix.content, prefixSystem, "Responses prefix bytes");
	}
	const inlineLore = input[3];
	assert.ok(inlineLore && "role" in inlineLore && inlineLore.role === "system");
	if (inlineLore && "role" in inlineLore && inlineLore.role === "system") {
		assert.equal(inlineLore.content, depthSystem);
		assertUtf8Equal(inlineLore.content, depthSystem, "Responses inline lore bytes");
	}
});
