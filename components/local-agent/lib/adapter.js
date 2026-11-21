import { LlmAdapter } from "@deepseek-ai/dsh-llm";
//#region src/adapter.ts
/**
* The DSH LLM adapter that serves local-agent model routes.
*
* A Bot whose model is a local-agent route answers through the CLI instead of a model API:
* the run loop, Sessions, tools and approvals stay the ordinary ones. This adapter turns each
* model request into a prompt for the driver and the driver's events back into DSH stream
* chunks.
*
* TWO HARD RULES, both from the user's 2026-11-10 decisions:
* 1. NO PERSONA / NO SYSTEM PROMPT. `system`, runtime-context and skill-catalog injections are
*    dropped — the agent keeps its own rules. The counter `stats.systemDropped` makes that
*    testable instead of a claim.
* 2. NO API KEY. Credentials are the CLI's; the adapter only resolves which model to ask for.
*
* @module
*/
/** Replay window when the CLI-side session is new or its id was lost. */
const REPLAY_MESSAGES = 12;
const REPLAY_BYTES = 24576;
const REPLAY_MESSAGE_CHARS = 2e3;
const DEFAULT_CONTEXT_WINDOW = 2e5;
const ACTIVITY_PREFIX = "▸ ";
/**
* DSH tools bridged to the agent over loopback MCP. Deliberately a whitelist: shell/file tools
* stay the agent's own (its sandbox governs them), and nothing outside the collaboration
* surface can be called through this bridge.
*/
const BRIDGED_TOOL_NAMES = /* @__PURE__ */ new Set([
	"message_member",
	"assign_task",
	"finish_task",
	"agent_community_deliver",
	"agent_community_dispatch",
	"agent_community_remember",
	"agent_community_recall",
	"agent_community_goal",
	"agent_community_abstain",
	"agent_community_list_bots",
	"agent_community_handoff_file",
	"ask_user_question",
	"propose_group",
	"invite_bot",
	"remove_bot",
	"approve_agent_action",
	"agent_switch_model"
]);
function isBridgedTool(name) {
	return BRIDGED_TOOL_NAMES.has(name) || name.startsWith("agent_community_");
}
function textOf(content) {
	if (!Array.isArray(content)) return "";
	return content.filter((block) => block !== null && typeof block === "object").filter((block) => block.type === "text" && typeof block.text === "string").map((block) => block.text).join("");
}
function truncate(text, max) {
	return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
/** A deterministic title (never reaches the CLI). */
function titleChunks(text) {
	const title = truncate(text.split("\n").find((part) => part.trim() !== "")?.trim() ?? "Chat", 60) || "Chat";
	return [
		{
			type: "block-start",
			index: 0,
			blockType: "text"
		},
		{
			type: "text-delta",
			index: 0,
			text: title
		},
		{
			type: "block-end",
			index: 0,
			block: {
				type: "text",
				text: title
			}
		},
		{
			type: "finish",
			reason: { kind: "stop" }
		}
	];
}
/** A deterministic digest (never reaches the CLI). */
function digestChunks(messages) {
	const lines = [];
	let used = 0;
	for (const message of messages) {
		const text = message.text.replace(/\s+/g, " ").trim();
		if (text === "") continue;
		const line = `${message.role}: ${truncate(text, 300)}`;
		if (used + line.length > 8192) break;
		lines.push(line);
		used += line.length;
	}
	const text = `[Earlier conversation, condensed]\n${lines.join("\n")}`;
	return [
		{
			type: "block-start",
			index: 0,
			blockType: "text"
		},
		{
			type: "text-delta",
			index: 0,
			text
		},
		{
			type: "block-end",
			index: 0,
			block: {
				type: "text",
				text
			}
		},
		{
			type: "finish",
			reason: { kind: "stop" }
		}
	];
}
function failureChunks(code, message, signal) {
	return signal?.aborted === true ? [{
		type: "finish",
		reason: {
			kind: "aborted",
			failure: {
				code: "ABORTED",
				message: "the turn was stopped"
			}
		}
	}] : [{
		type: "finish",
		reason: {
			kind: "error",
			failure: {
				code,
				message
			}
		}
	}];
}
function bridgedToolsOf(tools) {
	return (tools ?? []).filter((tool) => isBridgedTool(tool.name)).map((tool) => ({
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters
	}));
}
/** Render the replay window for a fresh CLI session: conversation content only. */
function renderReplay(messages) {
	if (messages.length === 0) return "";
	if (messages.length === 1 && messages[0]?.role === "user") return messages[0].text;
	const kept = [];
	let bytes = 0;
	for (let at = messages.length - 1; at >= 0 && kept.length < REPLAY_MESSAGES; at -= 1) {
		const message = messages[at];
		if (message === void 0) continue;
		const line = `${message.role}: ${truncate(message.text, REPLAY_MESSAGE_CHARS)}`;
		if (bytes + line.length > REPLAY_BYTES) break;
		kept.unshift(line);
		bytes += line.length;
	}
	return kept.length === 0 ? "" : `Conversation so far:\n\n${kept.join("\n\n")}`;
}
/** The adapter. One instance serves every registered route. */
var LocalAgentAdapter = class extends LlmAdapter {
	deps;
	/** Test-visible counters: assertions about "no persona" read this instead of trusting prose. */
	stats = {
		systemDropped: 0,
		turns: 0
	};
	disposed = false;
	/** Bridged calls parked by a previous stream, awaiting their DSH tool results. */
	pendingCalls = /* @__PURE__ */ new Map();
	constructor(deps) {
		super();
		this.deps = deps;
	}
	providerInfo(provider) {
		return {
			id: provider,
			name: this.deps.specFor(provider)?.name ?? provider
		};
	}
	providerRetryPolicy() {}
	imageRequestPricing() {}
	imageRequestTarget(_provider, _model, image) {
		return {
			width: image.width,
			height: image.height,
			maxBytes: image.bytes
		};
	}
	async listModels(provider) {
		const driver = this.deps.driverFor(provider);
		if (driver === void 0) return [];
		return (await driver.listModels()).map((model) => ({
			provider,
			id: model.id,
			name: model.name
		}));
	}
	async resolveModel(provider, model) {
		const spec = this.deps.specFor(provider);
		return {
			provider,
			id: model,
			name: model === "default" ? "CLI default" : model,
			inputModalities: ["text"],
			context: { contextWindow: spec?.contextWindow ?? DEFAULT_CONTEXT_WINDOW }
		};
	}
	async prepareCall(provider, model) {
		return {
			model: await this.resolveModel(provider, model),
			stream: (options) => this.streamFor(provider, options)
		};
	}
	async *stream(options) {
		yield* this.streamFor(options.provider, options);
	}
	async dispose() {
		this.disposed = true;
	}
	/** Results for bridged calls parked by a previous stream (consumed once). */
	takeToolResults(messages, sessionId, dispatchId) {
		for (const [id, scope] of this.pendingCalls) {
			if (scope.sessionId === sessionId && scope.dispatchId !== dispatchId) this.pendingCalls.delete(id);
		}
		const results = [];
		for (const message of messages ?? []) {
			if (message.role !== "tool") continue;
			const callId = "toolCallId" in message && typeof message.toolCallId === "string" ? message.toolCallId : void 0;
			const scope = this.pendingCalls.get(callId);
			if (!scope || scope.sessionId !== sessionId || scope.dispatchId !== dispatchId) continue;
			this.pendingCalls.delete(callId);
			results.push({
				callId,
				text: textOf(message.content) || ("isError" in message && message.isError === true ? "the call failed" : ""),
				isError: "isError" in message && message.isError === true
			});
		}
		return results;
	}
	/** Build prompt text from the request, dropping every injected, non-conversation kind. */
	buildPrompt(options, record) {
		let systemDropped = false;
		const promptable = [];
		if (typeof options.system === "string" && options.system.trim() !== "") systemDropped = true;
		for (const message of options.messages ?? []) {
			const role = message.role;
			const id = "id" in message && typeof message.id === "string" ? message.id : void 0;
			if (role === "system") {
				if (textOf(message.content) !== "") systemDropped = true;
				continue;
			}
			if (role === "user") {
				const source = "source" in message ? message.source : void 0;
				const kind = source !== void 0 && typeof source === "object" && "kind" in source ? String(source.kind) : void 0;
				if (kind !== void 0 && kind !== "user") continue;
				const text = textOf(message.content);
				if (text !== "") promptable.push({
					role: "user",
					text,
					id
				});
				continue;
			}
			if (role === "assistant") {
				const text = textOf(message.content);
				if (text !== "") promptable.push({
					role: "assistant",
					text,
					id
				});
				continue;
			}
		}
		const lastMessageId = promptable.at(-1)?.id;
		const handedAt = record?.handedId === void 0 ? -1 : promptable.findIndex((message) => message.id === record.handedId);
		if (record?.handedId === void 0 || handedAt === -1) return {
			prompt: renderReplay(promptable),
			lastMessageId,
			systemDropped
		};
		const delta = promptable.slice(handedAt + 1).filter((message) => message.role === "user").map((message) => message.text).filter((text) => text !== "");
		if (delta.length > 0) return {
			prompt: delta.join("\n\n"),
			lastMessageId,
			systemDropped
		};
		return {
			prompt: [...promptable].reverse().find((message) => message.role === "user")?.text ?? "",
			lastMessageId,
			systemDropped
		};
	}
	async *streamFor(route, options) {
		if (this.disposed) {
			yield* failureChunks("LOCAL_AGENT_DISPOSED", "the local agent adapter is disposed");
			return;
		}
		if (options.purpose === "session-title") {
			yield* titleChunks(textOf((options.messages ?? []).find((message) => message.role === "user")?.content));
			return;
		}
		if (options.purpose === "compaction") {
			yield* digestChunks((options.messages ?? []).map((message) => ({
				role: message.role,
				text: textOf(message.content)
			})));
			return;
		}
		const driver = this.deps.driverFor(route);
		if (driver === void 0) {
			yield* failureChunks("NO_ADAPTER", `no local agent driver for ${route}`);
			return;
		}
		if (options.sessionId === void 0) {
			yield* failureChunks("INVALID_REQUEST", "a local agent request needs a session");
			return;
		}
		const sessionId = String(options.sessionId);
		const record = this.deps.recordFor(sessionId);
		const requestedModel = record?.modelOverride ?? options.model;
		const explicitModel = (value) => typeof value === "string" && value !== "" && value !== "default";
		const modelChanged = record !== void 0 && (record.route !== route || explicitModel(requestedModel) && record.model !== requestedModel);
		let effectiveRecord = record;
		if (modelChanged) {
			effectiveRecord = {
				...record,
				resumeId: void 0,
				handedId: void 0
			};
			try {
				await driver.resetSession?.(sessionId);
			} catch {}
		}
		const built = this.buildPrompt(options, effectiveRecord);
		if (built.systemDropped) this.stats.systemDropped += 1;
		this.stats.turns += 1;
		const dispatchId = route === "codex-cli" ? this.deps.dispatchForSession?.(sessionId) : void 0;
		const toolResults = this.takeToolResults(options.messages, sessionId, dispatchId);
		const bridgedTools = this.deps.toolsBridge ? bridgedToolsOf(options.tools) : [];
    const taskPrompt=dispatchId&&this.deps.taskPromptFor?.(sessionId,dispatchId);
    let prompt=built.prompt;
    if(taskPrompt){
      if(!prompt.includes(taskPrompt))prompt+="\n\n【本次完整派单】\n"+taskPrompt;
      if(bridgedTools.some(tool=>tool.name==="agent_community_review"))prompt+="\n本次群任务使用 dshbot 协作工具。原生 Codex 工具如按需加载，在 functions.exec 用 ALL_TOOLS 查找以 agent_community_review 结尾的工具，通过 tools 调用实际工具名。需要交付已签核文件时查找 agent_community_deliver。仅工具的成功回执可作为签收、签核及交付依据。";
    }
		const lastMessageId = built.lastMessageId;
		let nextIndex = 0;
		let textIndex = -1;
		let textBuf = "";
		let thinkIndex = -1;
		let thinkBuf = "";
		let usage;
		let threadId = record?.resumeId;
		let sawDone = false;
		const closeText = function* () {
			if (textIndex < 0) return;
			yield {
				type: "block-end",
				index: textIndex,
				block: {
					type: "text",
					text: textBuf
				}
			};
			textIndex = -1;
			textBuf = "";
		};
		const closeThinking = function* () {
			if (thinkIndex < 0) return;
			yield {
				type: "block-end",
				index: thinkIndex,
				block: {
					type: "reasoning",
					text: thinkBuf
				}
			};
			thinkIndex = -1;
			thinkBuf = "";
		};
		try {
			for await (const event of driver.stream({
				sessionId,
				dispatchId,
				prompt,
				cwd: this.deps.cwdFor(sessionId),
				model: effectiveRecord?.modelOverride ?? options.model,
				permission: this.deps.permissionFor(sessionId),
				resumeId: modelChanged ? void 0 : effectiveRecord?.resumeId,
				...bridgedTools.length === 0 ? {} : { mcp: { tools: bridgedTools } },
				...toolResults.length === 0 ? {} : { toolResults },
				signal: options.signal
			})) switch (event.type) {
				case "thread":
					threadId = event.threadId;
					break;
				case "usage":
					usage = event.usage;
					break;
				case "done":
					if (event.reason === "interrupted" || event.reason === "stopped") {
						yield* closeText();
						yield* closeThinking();
						yield* failureChunks("ABORTED", "the turn was stopped", { aborted: true });
						return;
					}
					sawDone = true;
					break;
				case "tool-call": {
					yield* closeText();
					yield* closeThinking();
					const index = nextIndex++;
					this.pendingCalls.set(event.callId, { sessionId, dispatchId });
					yield {
						type: "block-start",
						index,
						blockType: "tool-call"
					};
					yield {
						type: "tool-call-delta",
						index,
						id: event.callId,
						name: event.name,
						argumentsDelta: JSON.stringify(event.arguments)
					};
					yield {
						type: "block-end",
						index,
						block: {
							type: "tool-call",
							id: event.callId,
							name: event.name,
							arguments: JSON.stringify(event.arguments)
						}
					};
					if (threadId !== void 0 || lastMessageId !== void 0) this.deps.saveRecord(sessionId, {
						route,
						...threadId === void 0 ? {} : { resumeId: threadId },
						cwd: this.deps.cwdFor(sessionId),
						...lastMessageId === void 0 ? {} : { handedId: lastMessageId },
						model: options.model,
						updatedAt: (/* @__PURE__ */ new Date()).toISOString()
					});
					yield {
						type: "finish",
						reason: { kind: "tool-calls" }
					};
					return;
				}
				case "error":
					yield* failureChunks("LOCAL_AGENT_FAILED", event.error.message);
					return;
				case "permission": {
					yield* closeText();
					if (thinkIndex < 0) {
						thinkIndex = nextIndex++;
						yield {
							type: "block-start",
							index: thinkIndex,
							blockType: "reasoning"
						};
					}
					const line = `${ACTIVITY_PREFIX}${event.action}${event.detail === void 0 ? "" : ` — ${truncate(event.detail, 240)}`}\n`;
					thinkBuf += line;
					yield {
						type: "reasoning-delta",
						index: thinkIndex,
						text: line
					};
					break;
				}
				case "activity": {
					yield* closeText();
					if (thinkIndex < 0) {
						thinkIndex = nextIndex++;
						yield {
							type: "block-start",
							index: thinkIndex,
							blockType: "reasoning"
						};
					}
					const line = `${ACTIVITY_PREFIX}${event.text}\n`;
					thinkBuf += line;
					yield {
						type: "reasoning-delta",
						index: thinkIndex,
						text: line
					};
					break;
				}
				case "text":
					yield* closeThinking();
					if (textIndex < 0) {
						textIndex = nextIndex++;
						yield {
							type: "block-start",
							index: textIndex,
							blockType: "text"
						};
					}
					textBuf += event.text;
					yield {
						type: "text-delta",
						index: textIndex,
						text: event.text
					};
					break;
				case "thought":
					yield* closeText();
					if (thinkIndex < 0) {
						thinkIndex = nextIndex++;
						yield {
							type: "block-start",
							index: thinkIndex,
							blockType: "reasoning"
						};
					}
					thinkBuf += event.text;
					yield {
						type: "reasoning-delta",
						index: thinkIndex,
						text: event.text
					};
			}
		} catch (error) {
			yield* closeText();
			yield* closeThinking();
			yield* failureChunks("LOCAL_AGENT_FAILED", error instanceof Error ? error.message : String(error), options.signal);
			return;
		}
		if (options.signal?.aborted === true) {
			yield* closeText();
			yield* closeThinking();
			yield* failureChunks("ABORTED", "the turn was stopped", options.signal);
			return;
		}
		yield* closeText();
		yield* closeThinking();
		if (usage !== void 0) yield {
			type: "usage",
			usage
		};
		if (sawDone || threadId !== void 0) {
			const next = {
				route,
				...threadId === void 0 ? {} : { resumeId: threadId },
				cwd: this.deps.cwdFor(sessionId),
				...lastMessageId === void 0 ? {} : { handedId: lastMessageId },
				model: options.model,
				updatedAt: (/* @__PURE__ */ new Date()).toISOString()
			};
			this.deps.saveRecord(sessionId, next);
		}
		yield {
			type: "finish",
			reason: { kind: "stop" }
		};
	}
};
//#endregion
export { LocalAgentAdapter };
