import { LocalAgentAdapter } from "./adapter.js";
import { forkCompletedCodexHistory, isActiveWriterError, recoveryChain, retryBusyResume, unsubscribeThread } from "./codex-writer-recovery.mjs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import z from "@deepseek-ai/schemastery";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
//#region src/discover.ts
/**
* Finding agent CLIs and the environment they run in.
*
* Two problems this solves, both measured on the real host:
* 1. A desktop app launched from the dock inherits a sparse PATH, so an npm-installed CLI is
*    invisible. The user's login shell knows where it actually is, so its PATH is read once
*    (cached, never blocking the host).
* 2. Some agents ship INSIDE a desktop app (Codex in ChatGPT.app) and are not on PATH at all;
*    the engine table carries candidate absolute paths for those.
*
* The child environment is sanitized: the CLI signs in by itself, and a provider API key (or
* another agent's backend variable) in our environment would shadow that or leak to it.
*
* @module
*/
/** Variables that never reach a child agent (its own sign-in must win). */
const DROP_EXACT = /* @__PURE__ */ new Set([
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_AUTH_TOKEN",
	"ANTHROPIC_BASE_URL",
	"CLAUDE_CODE_OAUTH_TOKEN",
	"OPENAI_API_KEY",
	"GEMINI_API_KEY",
	"GOOGLE_API_KEY",
	"XAI_API_KEY",
	"ELECTRON_RUN_AS_NODE"
]);
/** Prefixes dropped wholesale: our own harness/plugin knobs are not the agent's business. */
const DROP_PREFIX = [
	"DSH_",
	"DS_BOT_",
	"DS_PLUGIN_AGENT_"
];
/**
* A sanitized copy of the current environment plus `extra`.
*
* @param extra - variables an engine row explicitly needs (A2/A6).
*/
function cleanEnv(extra = {}) {
	const env = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (DROP_EXACT.has(key)) continue;
		if (DROP_PREFIX.some((prefix) => key.startsWith(prefix))) continue;
		env[key] = value;
	}
	return {
		...env,
		...extra
	};
}
/** How long the login-shell lookup is reused. */
const SEARCH_CACHE_MS = 6e4;
let searchCache = {
	at: 0,
	dirs: [],
	extra: []
};
let looking;
function outputOf(file, args) {
	return new Promise((resolve) => {
		try {
			execFile(file, [...args], {
				encoding: "utf8",
				timeout: 5e3,
				env: cleanEnv()
			}, (error, stdout) => {
				resolve(error === null ? stdout : void 0);
			});
		} catch {
			resolve(void 0);
		}
	});
}
/**
* Refresh the login-shell PATH + npm global bin directories, at most once a minute.
*
* Async and cached on purpose: this runs inside the DSH host, and a blocking child process
* there freezes every Session while it waits.
*
* @param extra - directories the deployment configured (e.g. a custom install root).
*/
function refreshSearchDirs(extra = []) {
	const sameExtra = extra.length === searchCache.extra.length && extra.every((dir, at) => dir === searchCache.extra[at]);
	if (Date.now() - searchCache.at < SEARCH_CACHE_MS && sameExtra) return Promise.resolve();
	looking ??= Promise.all([process.platform === "win32" ? Promise.resolve(void 0) : outputOf(process.env.SHELL ?? "/bin/sh", [
		"-l",
		"-c",
		"printf %s \"$PATH\""
	]), process.platform === "win32" ? Promise.resolve(void 0) : outputOf("npm", ["prefix", "-g"])]).then(([loginPath, prefix]) => {
		const dirs = [];
		for (const dir of (loginPath ?? "").split(delimiter)) if (dir !== "") dirs.push(dir);
		const npmBin = process.platform === "win32" ? process.env.APPDATA === void 0 ? void 0 : join(process.env.APPDATA, "npm") : prefix === void 0 || prefix.trim() === "" ? void 0 : join(prefix.trim(), "bin");
		if (npmBin !== void 0) dirs.push(npmBin);
		dirs.push(...extra);
		searchCache = {
			at: Date.now(),
			dirs,
			extra: [...extra]
		};
	}).finally(() => {
		looking = void 0;
	});
	return looking;
}
/** The usual macOS install locations, after PATH and the login shell. */
function standardDirs() {
	const home = homedir();
	return [
		join(home, ".local", "bin"),
		join(home, "bin"),
		"/opt/homebrew/bin",
		"/usr/local/bin"
	];
}
function searchDirs() {
	const dirs = /* @__PURE__ */ new Set();
	for (const dir of (process.env.PATH ?? "").split(delimiter)) if (dir !== "") dirs.add(dir);
	for (const dir of searchCache.dirs) if (dir !== "") dirs.add(dir);
	for (const dir of standardDirs()) if (existsSync(dir)) dirs.add(dir);
	return [...dirs];
}
function isPathLike(name) {
	return name.includes("/") || name.includes("\\") || name.startsWith("~/");
}
function expandTilde(path) {
	return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}
function candidates(name) {
	return process.platform === "win32" ? [
		`${name}.cmd`,
		`${name}.exe`,
		`${name}.bat`,
		name
	] : [name];
}
/**
* Resolve a program to an absolute path, or undefined.
*
* @param name - bare program name, absolute path, or `~/path`.
* @param appPaths - absolute paths to check after PATH (e.g. a CLI bundled in a desktop app).
*/
function findExecutable(name, appPaths = [], extraDirs = []) {
	const trimmed = name.trim();
	if (trimmed === "") return void 0;
	if (isPathLike(trimmed)) {
		const path = expandTilde(trimmed);
		return existsSync(path) ? path : void 0;
	}
	for (const dir of searchDirs()) for (const file of candidates(trimmed)) {
		const path = join(dir, file);
		if (existsSync(path)) return path;
	}
	for (const dir of extraDirs) for (const file of candidates(trimmed)) {
		const path = join(dir, file);
		if (existsSync(path)) return path;
	}
	for (const path of appPaths) if (existsSync(path)) return path;
}
/**
* First line of `--version`, for display only. Never throws.
*
* @param executable - absolute path.
* @param args - version arguments.
* @param timeoutMs - bound; the settings page waits at most this long per agent.
*/
function probeVersion(executable, args, timeoutMs = 1e4) {
	return new Promise((resolve) => {
		try {
			execFile(executable, [...args], {
				encoding: "utf8",
				timeout: timeoutMs,
				env: cleanEnv()
			}, (error, stdout, stderr) => {
				const text = `${stdout ?? ""}${stderr ?? ""}`.split("\n").map((line) => line.trim()).find((line) => line !== "");
				resolve(text === "" || text === void 0 ? void 0 : text);
			});
		} catch {
			resolve(void 0);
		}
	});
}
//#endregion
//#region src/mcp.ts
/**
* Loopback MCP server (Streamable HTTP) for ONE agent conversation.
*
* It exposes exactly the DSH tools the adapter allow-listed, on 127.0.0.1 with a random port
* and a per-conversation bearer token. A `tools/call` does NOT execute anything here: it
* parks until the host resolves it, which is what lets the adapter turn one CLI tool call
* into an ordinary DSH tool call (approvals and ledger included) and feed the result back.
*
* Only the slice MCP clients use in practice is implemented: initialize, initialized,
* tools/list, tools/call, plus 401/405 handling. Everything else is -32601.
*
* @module
*/
const PROTOCOL_VERSION = "2025-03-26";
var LoopbackMcp = class {
	token = randomBytes(32).toString("hex");
	/** Resolved after `listen()`; undefined before. */
	url;
	server;
	tools = [];
	pending = /* @__PURE__ */ new Map();
	onCall;
	listening;
	port;
	constructor() {
		this.server = createServer((request, response) => {
			this.serve(request, response).catch(() => {
				if (!response.headersSent) response.writeHead(500);
				response.end();
			});
		});
	}
	setTools(tools) {
		this.tools.length = 0;
		this.tools.push(...tools.map((tool) => ({ ...tool })));
	}
	/** Register the sink for one conversation's calls (one server belongs to one session). */
	setCallHandler(handler) {
		this.onCall = handler;
	}
	async listen() {
		this.listening ??= new Promise((resolve, reject) => {
			this.server.listen(0, "127.0.0.1", () => {
				const address = this.server.address();
				if (address === null || typeof address === "string") {
					reject(/* @__PURE__ */ new Error("no port"));
					return;
				}
				this.port = address.port;
				this.url = `http://127.0.0.1:${address.port}/mcp`;
				this.server.unref();
				resolve(this.url);
			}).once("error", reject);
		});
		return this.listening;
	}
	/** Answer the parked call from the host. Unknown/already-settled ids are ignored. */
	resolve(callId, result) {
		const settle = this.pending.get(callId);
		if (settle === void 0) return;
		this.pending.delete(callId);
		settle(result);
	}
	/** Fail every parked call (turn aborted / conversation closed). */
	failAll(error) {
		for (const [, settle] of this.pending) settle({
			text: error.message,
			isError: true
		});
		this.pending.clear();
	}
	close() {
		this.failAll(/* @__PURE__ */ new Error("the conversation closed"));
		this.server.close();
	}
	async serve(request, response) {
		const url = new URL(request.url ?? "/", "http://127.0.0.1");
		if (url.pathname !== "/mcp") {
			response.writeHead(404);
			response.end();
			return;
		}
		if (!(request.headers.authorization === `Bearer ${this.token}` || url.searchParams.get("token") === this.token)) {
			response.writeHead(401, { "content-type": "application/json" });
			response.end(JSON.stringify({
				jsonrpc: "2.0",
				id: null,
				error: {
					code: -32001,
					message: "unauthorized"
				}
			}));
			return;
		}
		if (request.method === "DELETE") {
			response.writeHead(204);
			response.end();
			return;
		}
		if (request.method !== "POST") {
			response.writeHead(405);
			response.end();
			return;
		}
		const body = await readBody(request);
		let message;
		try {
			message = JSON.parse(body);
		} catch {
			response.writeHead(400);
			response.end();
			return;
		}
		const messages = Array.isArray(message) ? message : [message];
		const replies = [];
		for (const item of messages) {
			const reply = await this.handleMessage(item);
			if (reply !== void 0) replies.push(reply);
		}
		if (replies.length === 0) {
			response.writeHead(202);
			response.end();
			return;
		}
		response.writeHead(200, { "content-type": "application/json" });
		response.end(JSON.stringify(replies.length === 1 ? replies[0] : replies));
	}
	async handleMessage(message) {
		if (message === null || typeof message !== "object") return void 0;
		const record = message;
		const method = record["method"];
		if (method === void 0) return void 0;
		const id = record["id"];
		const params = record["params"] ?? {};
		switch (method) {
			case "initialize": return {
				jsonrpc: "2.0",
				id,
				result: {
					protocolVersion: typeof params["protocolVersion"] === "string" ? params["protocolVersion"] : PROTOCOL_VERSION,
					capabilities: { tools: {} },
					serverInfo: {
						name: "dsh-local-agent",
						version: "1"
					}
				}
			};
			case "notifications/initialized": return;
			case "tools/list": return {
				jsonrpc: "2.0",
				id,
				result: { tools: this.tools.map((tool) => ({
					name: tool.name,
					description: tool.description,
					inputSchema: tool.inputSchema
				})) }
			};
			case "tools/call": {
				const name = String(params["name"] ?? "");
				const args = params["arguments"] !== null && typeof params["arguments"] === "object" ? params["arguments"] : {};
				if (!this.tools.some((tool) => tool.name === name)) return {
					jsonrpc: "2.0",
					id,
					error: {
						code: -32602,
						message: `unknown tool: ${name}`
					}
				};
				const callId = `mcp-${randomUUID()}`;
				const result = await new Promise((resolve) => {
					this.pending.set(callId, resolve);
					this.onCall?.({
						callId,
						name,
						arguments: args
					});
				});
				return {
					jsonrpc: "2.0",
					id,
					result: {
						content: [{
							type: "text",
							text: result.text
						}],
						...result.isError ? { isError: true } : {}
					}
				};
			}
			case "ping": return {
				jsonrpc: "2.0",
				id,
				result: {}
			};
			default:
				if (id === void 0) return void 0;
				return {
					jsonrpc: "2.0",
					id,
					error: {
						code: -32601,
						message: `method not found: ${String(method)}`
					}
				};
		}
	}
};
async function readBody(request) {
	let body = "";
	for await (const chunk of request) body += chunk;
	return body;
}
//#endregion
//#region src/drivers/jsonrpc.ts
var JsonRpcPeer = class {
	write;
	pending = /* @__PURE__ */ new Map();
	nextId = 1;
	closed;
	/** Server → client requests. Returning a rejected promise answers with a JSON-RPC error. */
	requestHandler;
	/** Server → client notifications. */
	notificationHandler;
	constructor(write) {
		this.write = write;
	}
	request(method, params, options = {}) {
		if (this.closed !== void 0) return Promise.reject(this.closed);
		if (options.signal?.aborted === true) return Promise.reject(/* @__PURE__ */ new Error("request aborted"));
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			const timeoutMs = options.timeoutMs ?? 0;
			const timer = timeoutMs > 0 ? setTimeout(() => {
				this.pending.delete(id);
				reject(/* @__PURE__ */ new Error(`JSON-RPC ${method} timed out after ${timeoutMs}ms`));
			}, timeoutMs) : void 0;
			timer?.unref?.();
			if (options.signal !== void 0) options.signal.addEventListener("abort", () => {
				if (!this.pending.has(id)) return;
				this.pending.delete(id);
				if (timer !== void 0) clearTimeout(timer);
				reject(/* @__PURE__ */ new Error(`JSON-RPC ${method} aborted`));
			}, { once: true });
			this.pending.set(id, {
				resolve,
				reject,
				timer
			});
			this.write({
				jsonrpc: "2.0",
				id,
				method,
				params
			});
		});
	}
	notify(method, params) {
		if (this.closed !== void 0) return;
		this.write({
			jsonrpc: "2.0",
			method,
			params
		});
	}
	/** Handle one decoded JSON-RPC message from the child. */
	async handle(message) {
		if (message === null || typeof message !== "object") return;
		const record = message;
		const id = record["id"];
		const method = record["method"];
		const error = record["error"];
		if (method === void 0) {
			if (typeof id !== "number") return;
			const pending = this.pending.get(id);
			if (pending === void 0) return;
			this.pending.delete(id);
			if (pending.timer !== void 0) clearTimeout(pending.timer);
			if (error !== void 0) pending.reject(new Error(errorMessage(error)));
			else pending.resolve(record["result"]);
			return;
		}
		const params = record["params"];
		if (id === void 0) {
			this.notificationHandler?.(String(method), params);
			return;
		}
		const handler = this.requestHandler;
		if (handler === void 0) {
			this.write({
				jsonrpc: "2.0",
				id,
				error: {
					code: -32601,
					message: `method not found: ${String(method)}`
				}
			});
			return;
		}
		try {
			const result = await handler(String(method), params);
			this.write({
				jsonrpc: "2.0",
				id,
				result: result ?? null
			});
		} catch (failure) {
			this.write({
				jsonrpc: "2.0",
				id,
				error: {
					code: -32603,
					message: failure instanceof Error ? failure.message : String(failure)
				}
			});
		}
	}
	/** Reject everything outstanding; the process is gone. */
	close(reason) {
		if (this.closed !== void 0) return;
		this.closed = reason;
		for (const [, pending] of this.pending) {
			if (pending.timer !== void 0) clearTimeout(pending.timer);
			pending.reject(reason);
		}
		this.pending.clear();
	}
};
function errorMessage(error) {
	if (error !== null && typeof error === "object") {
		const message = error["message"];
		if (typeof message === "string") return message;
	}
	return String(error);
}
/** Line-framed reader for a child's stdout, feeding the peer. */
function wireChild(child, peer) {
	let buffer = "";
	child.stdout?.setEncoding("utf8");
	child.stdout?.on("data", (chunk) => {
		buffer += chunk;
		let at;
		while ((at = buffer.indexOf("\n")) >= 0) {
			const line = buffer.slice(0, at).trim();
			buffer = buffer.slice(at + 1);
			if (line === "") continue;
			let decoded;
			try {
				decoded = JSON.parse(line);
			} catch {
				continue;
			}
			peer.handle(decoded);
		}
	});
	child.on("exit", () => peer.close(/* @__PURE__ */ new Error("the agent process exited")));
}
//#endregion
//#region src/drivers/acp.ts
/**
* Agent Client Protocol (ACP v1) driver — one child process per route, one ACP session per
* DSH session.
*
* ACP is JSON-RPC over newline-delimited stdio, which is exactly what `JsonRpcPeer` already
* speaks, so this file is the protocol mapping only: initialize → session/new (or
* session/load) → session/prompt, plus the agent → client permission request and the
* session/update notifications. MCP servers are declared in `session/new`, which is how the
* same loopback team-tool bridge Codex uses reaches ACP agents.
*
* The long tail of local agents (Gemini CLI, Grok Build, OpenCode, Cline, Cursor, Goose, Qwen
* Code, custom `acp-<id>` agents) all ride this one driver. Data-driven engines live in
* `engines.ts`; no per-agent code here.
*
* @module
*/
const INIT_TIMEOUT_MS$1 = 3e4;
const SESSION_TIMEOUT_MS = 6e4;
var AcpDriver = class {
	route;
	name;
	executable;
	args;
	extraEnv;
	child;
	peer;
	starting;
	capabilities = {
		loadSession: false,
		mcpHttp: false
	};
	sessions = /* @__PURE__ */ new Map();
	/** Parked permission prompts keyed by the synthetic DSH tool-call id. */
	pendingApprovals = /* @__PURE__ */ new Map();
	modelsCache = [{
		id: "default",
		name: "agent default"
	}];
	disposed = false;
	constructor(options) {
		this.route = options.route;
		this.name = options.name;
		this.executable = options.executable;
		this.args = options.args ?? [];
		this.extraEnv = options.env ?? {};
	}
	async listModels() {
		return this.modelsCache;
	}
	/** Apply a session-scoped model switch immediately on the live ACP session. */
	async setModel(sessionId, model) {
		const session = this.sessions.get(sessionId);
		const peer = this.peer;
		if (session === void 0 || session.acpSessionId === void 0 || peer === void 0) return;
		await peer.request("session/set_config_option", {
			sessionId: session.acpSessionId,
			configId: "model",
			value: model
		}, { timeoutMs: 15e3 });
		session.currentModel = model;
	}
	/** Forget this conversation's ACP session so the next turn opens a fresh one. */
	resetSession(sessionId) {
		const session = this.sessions.get(sessionId);
		if (session === void 0) return;
		this.peer?.notify("session/cancel", { sessionId: session.acpSessionId });
		session.mcp.close();
		this.sessions.delete(sessionId);
	}
	async dispose() {
		this.disposed = true;
		for (const session of this.sessions.values()) {
			session.mcp.close();
			this.peer?.notify("session/cancel", { sessionId: session.acpSessionId });
		}
		this.sessions.clear();
		const child = this.child;
		this.child = void 0;
		this.peer = void 0;
		if (child !== void 0) {
			try {
				child.kill("SIGTERM");
			} catch {}
			setTimeout(() => {
				try {
					child.kill("SIGKILL");
				} catch {}
			}, 3e3).unref?.();
		}
	}
	async *stream(input) {
		if (this.disposed) throw new Error("acp driver is disposed");
		const peer = await this.ensure();
		const session = this.sessionFor(input.sessionId);
		if (input.mcp !== void 0) await this.configureBridge(session, input.mcp.tools);
		for (const result of input.toolResults ?? []) {
			session.mcp.resolve(result.callId, {
				text: result.text,
				isError: result.isError
			});
			const approval = this.pendingApprovals.get(result.callId);
			if (approval !== void 0) {
				this.pendingApprovals.delete(result.callId);
				approval(approvalDecisionOf$1(result));
			}
		}
		const continuing = (input.toolResults?.length ?? 0) > 0;
		if (session.acpSessionId === void 0) await this.openSession(peer, session, input);
		if (!continuing) this.startPrompt(peer, session, input);
		for (;;) {
			const event = await this.next(session);
			yield event;
			if (event.type === "tool-call" || event.type === "done" || event.type === "error") return;
		}
	}
	/** Read `configOptions` (model selector) out of a session/new|load reply. */
	adoptSessionOptions(session, reply) {
		const options = Array.isArray(reply?.configOptions) ? reply.configOptions : [];
		for (const option of options) {
			if (option === null || typeof option !== "object") continue;
			const record = option;
			if (String(record["id"] ?? record["category"] ?? "") !== "model") continue;
			const entries = Array.isArray(record["options"]) ? record["options"] : [];
			const models = [];
			for (const entry of entries) {
				if (entry === null || typeof entry !== "object") continue;
				const value = entry["value"] ?? entry["id"];
				if (typeof value !== "string") continue;
				const name = entry["name"];
				models.push({
					id: value,
					name: typeof name === "string" ? name : value
				});
			}
			if (models.length > 0) {
				session.modelOptions = models;
				this.modelsCache = models;
			}
			const current = record["currentValue"] ?? record["currentValueId"];
			if (typeof current === "string") session.currentModel = current;
		}
	}
	/** Apply the request's model selection to a freshly created/resumed session. */
	async applyRequestedModel(peer, session, model) {
		if (model === void 0 || model === "default" || session.acpSessionId === void 0) return;
		try {
			await peer.request("session/set_config_option", {
				sessionId: session.acpSessionId,
				configId: "model",
				value: model
			}, { timeoutMs: 15e3 });
			session.currentModel = model;
		} catch {}
	}
	sessionFor(sessionId) {
		let session = this.sessions.get(sessionId);
		if (session === void 0) {
			session = {
				sessionId,
				acpSessionId: void 0,
				queue: [],
				notify: void 0,
				mcp: new LoopbackMcp()
			};
			this.sessions.set(sessionId, session);
		}
		return session;
	}
	async configureBridge(session, tools) {
		await session.mcp.listen();
		session.mcp.setTools(tools.map((tool) => ({
			name: tool.name,
			description: tool.description,
			inputSchema: tool.parameters
		})));
		session.mcp.setCallHandler((call) => {
			this.push(session, {
				type: "tool-call",
				callId: call.callId,
				name: call.name,
				arguments: call.arguments
			});
		});
	}
	mcpServers(session) {
		if (session.mcpSuppressed === true) return [];
		const url = session.mcp.url;
		if (url === void 0) return [];
		return [{
			type: "http",
			name: "dshbot",
			url,
			headers: [{
				name: "Authorization",
				value: `Bearer ${session.mcp.token}`
			}]
		}];
	}
	async openSession(peer, session, input) {
		let mcpServers = this.mcpServers(session);
		if (mcpServers.length > 0 && this.capabilities.mcpHttp === false) {
			session.mcpSuppressed = true;
			mcpServers = [];
			this.push(session, {
				type: "activity",
				text: "This agent does not accept HTTP MCP servers; team tools unavailable for this session"
			});
		}
		const resumeId = session.acpSessionId ?? input.resumeId;
		if (resumeId !== void 0) try {
			const loaded = await peer.request("session/load", {
				sessionId: resumeId,
				cwd: input.cwd,
				mcpServers
			}, { timeoutMs: SESSION_TIMEOUT_MS });
			session.acpSessionId = typeof loaded?.sessionId === "string" ? loaded.sessionId : resumeId;
			this.adoptSessionOptions(session, loaded);
			await this.applyRequestedModel(peer, session, input.model);
			this.push(session, {
				type: "thread",
				threadId: session.acpSessionId
			});
			return;
		} catch {
			session.acpSessionId = void 0;
		}
		const created = await peer.request("session/new", {
			cwd: input.cwd,
			mcpServers
		}, { timeoutMs: SESSION_TIMEOUT_MS });
		if (typeof created?.sessionId !== "string" || created.sessionId === "") throw new Error("acp agent returned no session id");
		session.acpSessionId = created.sessionId;
		this.adoptSessionOptions(session, created);
		await this.applyRequestedModel(peer, session, input.model);
		this.push(session, {
			type: "thread",
			threadId: created.sessionId
		});
	}
	startPrompt(peer, session, input) {
		peer.request("session/prompt", {
			sessionId: session.acpSessionId,
			prompt: [{
				type: "text",
				text: input.prompt
			}]
		}, {
			timeoutMs: 0,
			signal: input.signal
		}).then((reply) => {
			const usage = usageOf$2(reply);
			if (usage !== void 0) this.push(session, {
				type: "usage",
				usage
			});
			this.push(session, { type: "done" });
		}, (error) => this.push(session, {
			type: "error",
			error: error instanceof Error ? error : new Error(String(error))
		}));
	}
	async ensure() {
		if (this.peer !== void 0) return this.peer;
		this.starting ??= this.start().finally(() => {
			this.starting = void 0;
		});
		return this.starting;
	}
	async start() {
		const child = spawn(this.executable, [...this.args], {
			env: cleanEnv(this.extraEnv),
			stdio: [
				"pipe",
				"pipe",
				"pipe"
			],
			windowsHide: true
		});
		this.child = child;
		child.unref();
		process.once("exit", () => {
			try {
				child.kill("SIGKILL");
			} catch {}
		});
		const peer = new JsonRpcPeer((message) => {
			try {
				child.stdin?.write(`${JSON.stringify(message)}\n`);
			} catch {}
		});
		wireChild(child, peer);
		peer.notificationHandler = (method, params) => this.onNotification(method, params);
		peer.requestHandler = (method, params) => this.onServerRequest(method, params);
		child.on("exit", (code) => {
			const reason = /* @__PURE__ */ new Error(`acp agent exited ${String(code)}`);
			peer.close(reason);
			if (this.peer === peer) {
				this.peer = void 0;
				this.child = void 0;
			}
			for (const session of this.sessions.values()) {
				this.push(session, {
					type: "error",
					error: reason
				});
				session.acpSessionId = void 0;
			}
		});
		const initialized = await peer.request("initialize", {
			protocolVersion: 1,
			clientCapabilities: {
				fs: {
					readTextFile: false,
					writeTextFile: false
				},
				terminal: false
			},
			clientInfo: {
				name: "dsh-local-agent",
				version: "1"
			}
		}, { timeoutMs: INIT_TIMEOUT_MS$1 });
		this.capabilities = {
			loadSession: initialized?.agentCapabilities?.loadSession === true,
			mcpHttp: initialized?.agentCapabilities?.mcpCapabilities?.http === true
		};
		this.peer = peer;
		return peer;
	}
	onNotification(method, params) {
		if (method !== "session/update") return;
		const record = asRecord$2(params);
		const session = this.byAcpSession(record?.["sessionId"]);
		if (session === void 0) return;
		const update = asRecord$2(record?.["update"]);
		if (update === void 0) return;
		switch (String(update["sessionUpdate"] ?? "")) {
			case "agent_message_chunk": {
				const text = contentText(update["content"]);
				if (text !== "") this.push(session, {
					type: "text",
					text
				});
				break;
			}
			case "agent_thought_chunk": {
				const text = contentText(update["content"]);
				if (text !== "") this.push(session, {
					type: "thought",
					text
				});
				break;
			}
			case "plan": {
				const text = (Array.isArray(update["entries"]) ? update["entries"] : []).map((entry) => entry !== null && typeof entry === "object" ? entry["content"] : void 0).filter((part) => typeof part === "string").join("\n");
				if (text !== "") this.push(session, {
					type: "thought",
					text
				});
				break;
			}
			case "tool_call":
			case "tool_call_update": {
				const title = typeof update["title"] === "string" ? update["title"] : "";
				if (title !== "") this.push(session, {
					type: "activity",
					text: title
				});
				break;
			}
		}
	}
	async onServerRequest(method, params) {
		const record = asRecord$2(params);
		const session = this.byAcpSession(record?.["sessionId"]);
		if (method === "session/request_permission") {
			const toolCall = asRecord$2(record?.["toolCall"]);
			const title = typeof toolCall?.["title"] === "string" ? toolCall.title : "The agent asks to run an action";
			const rawInput = toolCall?.["rawInput"] !== null && typeof toolCall?.["rawInput"] === "object" ? JSON.stringify(toolCall?.rawInput) : "";
			const options = Array.isArray(record?.["options"]) ? record["options"] : [];
			const callId = `approval-${randomUUID()}`;
			if (!(await new Promise((resolve) => {
				this.pendingApprovals.set(callId, resolve);
				this.push(session, {
					type: "tool-call",
					callId,
					name: "approve_agent_action",
					arguments: {
						action: title,
						...rawInput === "" ? {} : { detail: rawInput.slice(0, 4e3) }
					}
				});
			})).allow) return { outcome: { outcome: "cancelled" } };
			const allowOption = options.map((option) => asRecord$2(option)).find((option) => typeof option?.["kind"] === "string" && String(option["kind"]).startsWith("allow"));
			const optionId = allowOption === void 0 ? void 0 : allowOption["optionId"];
			if (typeof optionId !== "string") return { outcome: { outcome: "cancelled" } };
			return { outcome: {
				outcome: "selected",
				optionId
			} };
		}
		if (method === "session/request_permission") return { outcome: { outcome: "cancelled" } };
		throw new Error(`unsupported acp client request: ${method}`);
	}
	byAcpSession(acpSessionId) {
		if (typeof acpSessionId !== "string") return void 0;
		for (const session of this.sessions.values()) if (session.acpSessionId === acpSessionId) return session;
	}
	push(session, event) {
		if (session === void 0) return;
		session.queue.push(event);
		const notify = session.notify;
		session.notify = void 0;
		notify?.();
	}
	next(session) {
		const queued = session.queue.shift();
		if (queued !== void 0) return Promise.resolve(queued);
		return new Promise((resolve) => {
			session.notify = () => {
				const event = session.queue.shift();
				if (event !== void 0) resolve(event);
			};
		});
	}
};
function asRecord$2(value) {
	return value !== null && typeof value === "object" ? value : void 0;
}
function contentText(content) {
	if (content === null || typeof content !== "object") return "";
	const block = content;
	return block["type"] === "text" && typeof block["text"] === "string" ? block["text"] : "";
}
/** Fail-closed: only a well-formed {"decision":"allow"} from the DSH tool counts. */
function approvalDecisionOf$1(result) {
	if (result.isError) return { allow: false };
	try {
		const parsed = JSON.parse(result.text);
		return { allow: parsed !== null && typeof parsed === "object" && parsed.decision === "allow" };
	} catch {
		return { allow: false };
	}
}
function usageOf$2(reply) {
	const record = asRecord$2(reply);
	if (record === void 0) return void 0;
	const usage = asRecord$2(record["usage"]);
	if (usage === void 0) return void 0;
	const number = (value) => typeof value === "number" && Number.isFinite(value) ? value : 0;
	return {
		inputTokens: number(usage["inputTokens"]),
		outputTokens: number(usage["outputTokens"])
	};
}
//#endregion
//#region src/drivers/claude.ts
const RESULT_TIMEOUT_MS = 6e5;
var ClaudeDriver = class {
	route;
	name;
	executable;
	baseArgs;
	sessions = /* @__PURE__ */ new Map();
	disposed = false;
	constructor(options) {
		this.route = options.route;
		this.name = options.name;
		this.executable = options.executable;
		this.baseArgs = options.args ?? [];
	}
	async listModels() {
		return [{
			id: "default",
			name: "agent default"
		}];
	}
	/** Forget this conversation's CLI process/`--resume` id. */
	resetSession(sessionId) {
		const session = this.sessions.get(sessionId);
		if (session === void 0) return;
		session.mcp.close();
		try {
			session.child?.kill("SIGTERM");
		} catch {}
		this.sessions.delete(sessionId);
	}
	async dispose() {
		this.disposed = true;
		for (const session of this.sessions.values()) {
			session.mcp.close();
			try {
				session.child?.kill("SIGTERM");
			} catch {}
		}
		this.sessions.clear();
	}
	async *stream(input) {
		if (this.disposed) throw new Error("claude driver is disposed");
		const session = this.sessionFor(input.sessionId);
		if (input.mcp !== void 0) await this.configureBridge(session, input.mcp.tools);
		for (const result of input.toolResults ?? []) session.mcp.resolve(result.callId, {
			text: result.text,
			isError: result.isError
		});
		if (!((input.toolResults?.length ?? 0) > 0)) this.startTurn(session, input);
		for (;;) {
			const event = await this.next(session);
			yield event;
			if (event.type === "tool-call" || event.type === "done" || event.type === "error") return;
		}
	}
	sessionFor(sessionId) {
		let session = this.sessions.get(sessionId);
		if (session === void 0) {
			session = {
				sessionId,
				queue: [],
				notify: void 0,
				mcp: new LoopbackMcp(),
				resumeId: void 0,
				child: void 0,
				emitText: false,
				ended: false
			};
			this.sessions.set(sessionId, session);
		}
		return session;
	}
	async configureBridge(session, tools) {
		await session.mcp.listen();
		session.mcp.setTools(tools.map((tool) => ({
			name: tool.name,
			description: tool.description,
			inputSchema: tool.parameters
		})));
		session.mcp.setCallHandler((call) => {
			this.push(session, {
				type: "tool-call",
				callId: call.callId,
				name: call.name,
				arguments: call.arguments
			});
		});
	}
	startTurn(session, input) {
		session.emitText = false;
		session.ended = false;
		const args = [
			"-p",
			"--output-format",
			"stream-json",
			"--verbose",
			"--allowedTools",
			"mcp__dshbot",
			...input.permission === "workspace-write" ? ["--permission-mode", "acceptEdits"] : input.permission === "full-access" ? ["--dangerously-skip-permissions"] : input.permission === "read-only" ? ["--permission-mode", "plan"] : [],
			...this.baseArgs,
			...input.resumeId === void 0 ? [] : ["--resume", input.resumeId],
			...input.model !== void 0 && input.model !== "default" ? ["--model", input.model] : []
		];
		const mcpConfig = this.mcpConfig(session);
		if (mcpConfig !== void 0) args.push("--mcp-config", mcpConfig);
		const child = spawn(this.executable, args, {
			cwd: input.cwd,
			env: {
				...cleanEnv(),
				...claudeAuthEnv()
			},
			stdio: [
				"pipe",
				"pipe",
				"pipe"
			],
			windowsHide: true
		});
		session.child = child;
		child.unref();
		process.once("exit", () => {
			try {
				child.kill("SIGKILL");
			} catch {}
		});
		child.stdin?.write(input.prompt);
		child.stdin?.end();
		createInterface({ input: child.stdout }).on("line", (line) => this.onLine(session, line));
		let stderr = "";
		child.stderr?.on("data", (chunk) => {
			stderr += String(chunk).slice(0, 2e3);
		});
		child.on("exit", (code) => {
			session.child = void 0;
			if (!session.ended) {
				session.ended = true;
				this.push(session, {
					type: "error",
					error: new Error(stderr.trim() === "" ? `claude exited ${String(code)}` : stderr.trim())
				});
			}
		});
		const timer = setTimeout(() => {
			if (session.ended) return;
			session.ended = true;
			try {
				child.kill("SIGTERM");
			} catch {}
			this.push(session, {
				type: "error",
				error: /* @__PURE__ */ new Error("claude turn timed out")
			});
		}, RESULT_TIMEOUT_MS);
		timer.unref?.();
		child.on("exit", () => {
			clearTimeout(timer);
		});
	}
	/** `--mcp-config` accepts an inline JSON string. */
	mcpConfig(session) {
		const url = session.mcp.url;
		if (url === void 0) return void 0;
		return JSON.stringify({ mcpServers: { dshbot: {
			type: "http",
			url,
			headers: { Authorization: `Bearer ${session.mcp.token}` }
		} } });
	}
	onLine(session, line) {
		if (line.trim() === "") return;
		let message;
		try {
			message = JSON.parse(line);
		} catch {
			return;
		}
		const type = String(message["type"] ?? "");
		if (type === "system" && message["subtype"] === "init") {
			const sessionId = message["session_id"];
			if (typeof sessionId === "string") {
				session.resumeId = sessionId;
				this.push(session, {
					type: "thread",
					threadId: sessionId
				});
			}
			return;
		}
		if (type === "assistant") {
			const content = asRecord$1(message["message"])?.["content"];
			if (Array.isArray(content)) for (const block of content) {
				const record = asRecord$1(block);
				if (record === void 0) continue;
				if (record["type"] === "text" && typeof record["text"] === "string" && record["text"] !== "") {
					session.emitText = true;
					this.push(session, {
						type: "text",
						text: record["text"]
					});
				} else if (record["type"] === "tool_use") {
					const name = typeof record["name"] === "string" ? record["name"] : "tool";
					this.push(session, {
						type: "activity",
						text: `调用工具 ${name}`
					});
				}
			}
			return;
		}
		if (type === "result") {
			if (session.ended) return;
			session.ended = true;
			const usage = usageOf$1(message["usage"]);
			if (usage !== void 0) this.push(session, {
				type: "usage",
				usage
			});
			if (message["is_error"] === true) {
				const text = typeof message["result"] === "string" && message["result"] !== "" ? message["result"] : "claude reported an error";
				this.push(session, {
					type: "activity",
					text: `Claude Code: ${text}`
				});
				this.push(session, {
					type: "error",
					error: new Error(text)
				});
				return;
			}
			if (!session.emitText && typeof message["result"] === "string" && message["result"] !== "") this.push(session, {
				type: "text",
				text: message["result"]
			});
			this.push(session, { type: "done" });
		}
	}
	push(session, event) {
		session.queue.push(event);
		const notify = session.notify;
		session.notify = void 0;
		notify?.();
	}
	next(session) {
		const queued = session.queue.shift();
		if (queued !== void 0) return Promise.resolve(queued);
		return new Promise((resolve) => {
			session.notify = () => {
				const event = session.queue.shift();
				if (event !== void 0) resolve(event);
			};
		});
	}
};
/** Pass through only Claude Code's own auth/config environment. */
function claudeAuthEnv() {
	const env = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (!/^(?:ANTHROPIC_|CLAUDE_CODE_)/.test(key)) continue;
		if (value !== void 0) env[key] = value;
	}
	return env;
}
function asRecord$1(value) {
	return value !== null && typeof value === "object" ? value : void 0;
}
function usageOf$1(value) {
	const usage = asRecord$1(value);
	if (usage === void 0) return void 0;
	const number = (key) => typeof usage[key] === "number" && Number.isFinite(usage[key]) ? usage[key] : 0;
	return {
		inputTokens: number("input_tokens"),
		outputTokens: number("output_tokens")
	};
}
//#endregion
//#region src/drivers/codex.ts
/**
* Codex CLI driver over its app-server JSON-RPC (stdio).
*
* WHY APP-SERVER, NOT `codex exec`: we need two things exec cannot give us — (1) the team
* tools bridged back into a live turn (exec refuses MCP tool calls under
* `approval_policy = never`), and (2) an approval seam for A4. The app-server protocol
* declares MCP servers per thread, so the bridge's loopback server needs no user config
* changes and no global env var.
*
* One app-server process per route, one thread per DSH session (mirrors DS-Bot's proven
* mapping). A turn suspends when the agent calls a bridged tool: the driver yields a
* `tool-call` event and keeps the process/turn alive; the adapter re-enters `stream()` with
* that call's result, which resolves the parked MCP request and the same turn continues.
*
* @module
*/
const INIT_TIMEOUT_MS = 3e4;
const THREAD_TIMEOUT_MS = 6e4;
// [BARU-PATCH 2026-11-15] How long a `turn/interrupt` may stay unacknowledged before the stop is
// reported as UNCONFIRMED. Isolation default from the v1.0 plan (停止回执 15 秒); the deployment
// value is whatever the host passes in.
const DEFAULT_STOP_RECEIPT_MS = 15e3;
// [BARU-PATCH 2026-11-15] A notification arriving for a turn the session no longer owns is kept
// as diagnostics only, bounded so a chatty stale turn cannot grow the session object forever.
const FOREIGN_EVENT_KEEP = 20;
var CodexDriver = class {
	route;
	name;
	executable;
	args;
	child;
	peer;
	starting;
	stderr = "";
	sessions = /* @__PURE__ */ new Map();
	modelsRequest;
	disposed = false;
	/**
	* [BARU-PATCH 2026-11-15] Progress sink owned by the host (LocalAgentService).
	*
	* The driver is the only place that sees the upstream turn event by event, so it is the only
	* place that can tell "the model is still streaming" from "nothing has happened for 120s".
	* Everything reported here is metadata: kind, ids, timestamps and a count — never tool text,
	* never reasoning bodies.
	*/
	onProgress;
	/**
	* Durable thread binding sink.  It is deliberately awaited before `turn/start`:
	* a process crash in that otherwise tiny gap must still leave the DSH session →
	* Codex thread identity available for native continuation after restart.
	*/
	onSessionOpened;
	/** [BARU-PATCH 2026-11-15] Receipt window for `turn/interrupt`; 0 disables the timer. */
	stopReceiptMs = DEFAULT_STOP_RECEIPT_MS;
	/** [BARU-PATCH 2026-11-15] turnId → { requestedAtMs, timer } for pending stops. */
	stopRequests = /* @__PURE__ */ new Map();
	constructor(options) {
		this.route = options.route;
		this.name = options.name;
		this.executable = options.executable;
		this.args = options.args ?? [
			"app-server",
			"--listen",
			"stdio://"
		];
		this.onProgress = options.onProgress;
		this.onSessionOpened = options.onSessionOpened;
		this.writerRecoveryScopeFor = options.writerRecoveryScopeFor;
		this.prepareWriterRecovery = options.prepareWriterRecovery ?? options.writerRecoveryScopeFor;
		this.contextPolicyFor=options.contextPolicyFor;
		if (Number.isFinite(options.stopReceiptMs) && options.stopReceiptMs >= 0) this.stopReceiptMs = Math.round(options.stopReceiptMs);
	}
	listModels() {
		// The CLI catalog can change while Harness is running. Share only the in-flight read.
		this.modelsRequest ??= this.readModels().finally(() => { this.modelsRequest = undefined; });
		return this.modelsRequest;
	}
	async readModels() {
		const peer = await this.ensure();
		const models = new Map();
		const cursors = new Set();
		let cursor;
		try {
			do {
				const reply = await peer.request("model/list", {
					includeHidden: false,
					...(cursor ? { cursor } : {})
				}, { timeoutMs: INIT_TIMEOUT_MS });
				if (!Array.isArray(reply?.data)) break;
				for (const entry of reply.data) {
					const id = entry?.id ?? entry?.model;
					if (typeof id !== "string" || id === "" || entry.hidden === true || models.has(id)) continue;
					models.set(id, { id, name: String(entry.displayName ?? entry.name ?? id) });
				}
				cursor = typeof reply.nextCursor === "string" ? reply.nextCursor : undefined;
				if (cursor && cursors.has(cursor)) break;
				if (cursor) cursors.add(cursor);
			} while (cursor);
		} catch {
			// A failed read lasts only for this request. The next catalog opening can retry.
		}
		return models.size > 0 ? [...models.values()] : [{ id: "default", name: "CLI default" }];
	}
	/** Forget this conversation after giving up only this connection's idle subscription. */
	async resetSession(sessionId) {
		const session = this.sessions.get(sessionId);
		if (!session) return;
		clearTimeout(session.idleReleaseTimer);
		await this.releaseIdleThread(session);
		session.mcp.close();
		this.sessions.delete(sessionId);
	}
	async dispose() {
		this.disposed = true;
		for (const session of this.sessions.values()) {
			clearTimeout(session.idleReleaseTimer);
			session.mcp.close();
		}
		this.sessions.clear();
		this.threadPeer.clear();
		const child = this.child;
		this.child = void 0;
		this.peer = void 0;
		if (child !== void 0) {
			try {
				child.kill("SIGTERM");
			} catch {}
			setTimeout(() => {
				try {
					child.kill("SIGKILL");
				} catch {}
			}, 3e3).unref?.();
		}
	}
	async *stream(input) {
		if (this.disposed) throw new Error("codex driver is disposed");
		input={...input,contextPolicy:await this.contextPolicyFor?.(input.sessionId)};
		const peer = await this.ensure();
		const session = this.sessionFor(input.sessionId);
		if (input.mcp !== void 0) await this.configureBridge(session, input.mcp.tools);
		for (const result of input.toolResults ?? []) {
			session.mcp.resolve(result.callId, {
				text: result.text,
				isError: result.isError
			});
			const resolve = this.delegatedCalls.get(result.callId);
			if (resolve !== void 0) {
				this.delegatedCalls.delete(result.callId);
				resolve({
					text: result.text,
					isError: result.isError
				});
			}
			const approval = this.pendingApprovals.get(result.callId);
			if (approval !== void 0) {
				this.pendingApprovals.delete(result.callId);
				approval(approvalDecisionOf(result));
			}
		}
		const continuing = (input.toolResults?.length ?? 0) > 0;
		clearTimeout(session.idleReleaseTimer);
		if (!continuing) {
			if (session.opening || session.awaitingTurn || session.turnId) throw Error("The previous Codex turn has not reached a terminal state");
			// A DSH carrier can close before draining the preceding native turn.
			// Thread identity persists, but pending tool calls, text, and finish frames belong to that turn.
			session.queue.length = 0;
			session.early?.clear();
			session.stopReason = void 0;
			session.opening = true;
			try {
				await session.releasingWriter;
				if (!input.signal?.aborted) {
					if (session.threadId === void 0 || this.threadPeer.get(session.sessionId) !== peer || input.contextPolicy?.revision !== session.contextPolicyRevision) {
						await this.openThread(peer, session, input);
					} else {
						await this.persistOpenedSession(session,input,session.threadId,"cached");
					}
				}
			} finally {
				session.opening = false;
			}
		}
		if (!continuing) {
			if (input.signal?.aborted) {
				this.scheduleIdleRelease(session);
				yield {type:"done",reason:"stopped"};
				return;
			}
			this.beginTurn(session);
			session.dispatchId = input.dispatchId;
			peer.request("turn/start", {
				threadId: session.threadId,
				input: [{
					type: "text",
					text: this.contextPrompt(input)
				}],
				...input.model !== void 0 && input.model !== "default" ? { model: input.model } : {}
			}, {
				timeoutMs: 0
			}).then((reply) => {
				const turn = reply?.turn;
				this.bindTurn(session, turn?.id);
			}, (error) => {
				if (session.turnId === void 0) session.awaitingTurn = false;
				this.push(session,{type:"error",error:asError(error)});
			});
		}
		if (input.signal !== void 0) this.watchAbort(session, input.signal);
		for (;;) {
			const event = await this.next(session, input.signal);
			yield event;
			if (event.type === "tool-call" || event.type === "done" || event.type === "error") return;
		}
	}
	/**
	* [BARU-PATCH 2026-11-15] Start a clean turn record.
	*
	* The turn id is cleared on purpose: the `turn/start` reply and `turn/started` may arrive in
	* either order, and the FIRST binding wins — an id from a previous turn must never be reused to
	* attribute the new turn's events (that is exactly how a stale turn could keep a live run's
	* progress clock alive).
	*/
	beginTurn(session) {
		if (session.turnId !== void 0 || session.awaitingTurn === true) throw Error("The previous Codex turn has not reached a terminal state");
		session.awaitingTurn = true;
		session.turnId = void 0;
		session.items = new Map();
		session.completedItems = new Set();
		// Keep any upstream notifications that raced ahead of the `turn/start`
		// response; bindTurn replays them after this turn becomes the owner.
		session.early ??= new Map();
		session.turnBoundAtMs = void 0;
		session.lastDeltaReportMs = 0;
		session.pendingInterrupt = void 0;
		session.abortWatcher = void 0;
	}
	/** [BARU-PATCH 2026-11-15] Bind the upstream turn id once, then act on any parked stop intent. */
	bindTurn(session, turnId) {
		if (typeof turnId !== "string" || turnId === "" || session.awaitingTurn !== true) return;
		if (session.turnId !== void 0 || session.settledTurns?.includes(turnId)) return;
		session.turnId = turnId;
		session.turnBoundAtMs = Date.now();
		this.report(session, {
			kind: "turn-start",
			turnId
		});
		// [BARU-PATCH 2026-11-15] Replay what arrived before the binding, in arrival order.
		const early = session.early?.get(turnId);
		if (early !== void 0) {
			session.early.clear();
			for (const pending of early) this.onNotification(pending.method, pending.params, pending.at);
		}
		if (session.pendingInterrupt !== void 0) {
			const reason = session.pendingInterrupt;
			session.pendingInterrupt = void 0;
			this.requestInterrupt(session, reason).catch(() => void 0);
		}
	}
	/**
	* [BARU-PATCH 2026-11-15] A DSH abort asks the UPSTREAM turn to stop.
	*
	* Aborting the transport request (what the pre-patch driver did through `input.signal`) only
	* closes our side of the pipe: the app-server keeps running the turn, which is the reported
	* incident — the group said 失败 while Codex kept calling tools. The two cancellations are
	* therefore managed separately, exactly as the v1.0 plan requires.
	*/
	watchAbort(session, signal) {
		if (session.abortWatcher === signal) return;
		session.abortWatcher = signal;
		const onAbort = () => {
			if (session.abortWatcher !== signal) return;
			this.requestInterrupt(session, session.stopReason ?? "stopped").catch(() => void 0);
		};
		if (signal.aborted === true) onAbort();
		else signal.addEventListener?.("abort", onAbort, { once: true });
	}
	/**
	* [BARU-PATCH 2026-11-15] Send `turn/interrupt` for the bound turn and wait for ITS receipt.
	*
	* The stop is reported in three states, and only a receipt moves it forward:
	*   · `stop-requested` — intent persisted, request sent (or parked until the turn id is known);
	*   · `stop-confirmed` — `turn/completed` for that very turn id (interrupted or a natural end);
	*   · `stop-unconfirmed` — no receipt inside the window; the host must not treat this run as
	*     cleanly stopped, and must suspend dispatch for the affected pair until it is rechecked.
	*/
	async requestInterrupt(session, reason) {
		session.stopReason = reason;
		if (session.awaitingTurn !== true && session.turnId === void 0) return;
		const peer = this.peer;
		if (peer === void 0 || session.threadId === void 0 || session.turnId === void 0) {
			session.pendingInterrupt = reason;
			this.report(session, {
				kind: "stop-requested",
				stage: "no-turn-id",
				turnId: session.turnId,
				reason
			});
			return;
		}
		const turnId = session.turnId;
		if (this.stopRequests.has(turnId)) return;
		const entry = {requestedAtMs:Date.now(),timer:void 0,sessionId:session.sessionId,threadId:session.threadId};
		this.stopRequests.set(turnId, entry);
		this.report(session,{kind:"stop-requested",stage:"sent",turnId,reason});
		if (this.stopReceiptMs > 0) {
			entry.timer=setTimeout(()=>{
				if (this.stopRequests.get(turnId)!==entry) return;
				// Retain the exact key after the UI deadline so a late receipt still reconciles.
				this.report(session,{kind:"stop-unconfirmed",threadId:entry.threadId,turnId,waitedMs:Date.now()-entry.requestedAtMs});
			},this.stopReceiptMs);
			entry.timer.unref?.();
		}
		try {
			await peer.request("turn/interrupt",{threadId:entry.threadId,turnId},{timeoutMs:Math.max(1000,this.stopReceiptMs || 30000)});
		} catch (error) {
			if (this.stopRequests.get(turnId)===entry) this.report(session,{kind:"stop-failed",threadId:entry.threadId,turnId,error:String(error?.message ?? error)});
		}
	}
	/** [BARU-PATCH 2026-11-15] The turn reached a terminal state — close any stop request on it. */
	settleTurn(session, turnId, status) {
		const id = turnId;
		if (id === void 0 || session.turnId !== id || session.settledTurns?.includes(id)) return;
		this.report(session,{kind:"turn-terminal",turnId:id,status,source:"notification"});
		if (id !== void 0) {
			const entry = this.stopRequests.get(id);
			if (entry !== void 0 && entry.threadId === session.threadId) {
				this.stopRequests.delete(id);
				if (entry.timer !== void 0) clearTimeout(entry.timer);
				this.report(session, {
					kind: "stop-confirmed",
					turnId: id,
					status,
					waitedMs: Date.now() - entry.requestedAtMs
				});
			}
		}
		session.turnId = void 0;
		session.awaitingTurn = false;
		session.items = /* @__PURE__ */ new Map();
		session.pendingInterrupt = void 0;
		// [BARU-PATCH 2026-11-15] Remember the ids we closed: a turn that already ended must never
		// be able to push a late delta/card into the NEXT turn's display.
		if (id !== void 0) {
			session.settledTurns ??= [];
			if (!session.settledTurns.includes(id)) {
				session.settledTurns.push(id);
				if (session.settledTurns.length > 10) session.settledTurns.shift();
			}
		}
		this.scheduleIdleRelease(session);
	}
	/** [BARU-PATCH 2026-11-15] One bounded diagnostics slot for events of turns we no longer own. */
	keepForeign(session, method, turnId) {
		session.foreign ??= [];
		session.foreign.push({
			method,
			turnId,
			at: Date.now()
		});
		if (session.foreign.length > FOREIGN_EVENT_KEEP) session.foreign.shift();
	}
	/** [BARU-PATCH 2026-11-15] Report one progress/diagnostic event; never throws into the pipe. */
	report(session, payload) {
		if (this.onProgress === void 0) return;
		try {
			this.onProgress({
				sessionId: session?.sessionId,
				threadId: session?.threadId,
				runId: session?.dispatchId,
				at: Date.now(),
				...payload
			});
		} catch {}
	}
	/** [BARU-PATCH 2026-11-15] Count one streamed delta against its item (全文去重要用). */
	countDelta(session, record) {
		if (session === void 0) return;
		const itemId = typeof record["itemId"] === "string" ? record["itemId"] : void 0;
		if (itemId === void 0) return;
		const tracked = session.items.get(itemId);
		if (tracked !== void 0) tracked.deltas += 1;
	}
	/**
	* [BARU-PATCH 2026-11-15] Report streamed content at a bounded rate.
	*
	* A token stream can emit hundreds of deltas a second, and the progress clock only needs to
	* know that NEW CONTENT arrived — not how often it arrived.
	*/
	reportProgress(session, kind, record, turnId) {
		const now = Date.now();
		if (session !== void 0) {
			if (now - (session.lastDeltaReportMs ?? 0) < 250) return;
			session.lastDeltaReportMs = now;
		}
		this.report(session, {
			kind,
			itemId: typeof record["itemId"] === "string" ? record["itemId"] : void 0,
			turnId: turnId ?? session?.turnId
		});
	}
	/** Which peer each session's thread was created on (a restart invalidates it). */
	threadPeer = /* @__PURE__ */ new Map();
	/** Delegated dynamic tool calls (`item/tool/call`) parked until the host answers. */
	delegatedCalls = /* @__PURE__ */ new Map();
	/** Parked CLI permission prompts, keyed by the synthetic DSH tool-call id. */
	pendingApprovals = /* @__PURE__ */ new Map();
	sessionFor(sessionId) {
		let session = this.sessions.get(sessionId);
		if (session === void 0) {
			session = {
				sessionId,
				threadId: void 0,
				turnId: void 0,
				mcp: new LoopbackMcp(),
				mcpUrl: void 0,
				queue: [],
				notify: void 0,
				closed: false,
				// [BARU-PATCH 2026-11-15] per-turn bookkeeping: in-flight items, stop intent
				items: /* @__PURE__ */ new Map(),
				turnBoundAtMs: void 0,
				lastDeltaReportMs: 0,
				pendingInterrupt: void 0,
				abortWatcher: void 0,
				stopReason: void 0,
				foreign: void 0,
				// [BARU-PATCH 2026-11-15] ids of turns that already reached a terminal state
				settledTurns: void 0,
				// [BARU-PATCH 2026-11-15] events that arrived before their turn was bound
				early: void 0
			};
			this.sessions.set(sessionId, session);
		}
		return session;
	}
	async configureBridge(session, tools) {
		session.mcpUrl = await session.mcp.listen();
		session.mcp.setTools(tools.map((tool) => ({
			name: tool.name,
			description: tool.description,
			inputSchema: tool.parameters
		})));
		session.mcp.setCallHandler((call) => {
			this.push(session, {
				type: "tool-call",
				callId: call.callId,
				name: call.name,
				arguments: call.arguments
			});
		});
	}
	contextPrompt(input) {const messages=input.contextPolicy?.recentMessages;return input.prompt+(messages?.length?"\n\n【宿主保留的最近 "+messages.length+" 条原消息；压缩后仍按原 ID 可回查】\n"+JSON.stringify(messages):"");}
	async applyContextPolicy(peer,session,input) {
		if(!input.contextPolicy)return;const {recentMessages,...policy}=input.contextPolicy;
		// This receipt means that the running App Server accepted the configuration for
		// this exact thread.  It deliberately does not mean that a compaction happened:
		// the latter is only reported from an upstream compacted notification below.
		this.report(session,{kind:"compaction-engine-configured",...policy,runner:"codex",source:"thread-config-accepted"});
		session.contextPolicy=policy;session.contextPolicyRevision=policy.revision;
	}
	async releaseIdleThread(session) {
		if (session.releasingWriter) return session.releasingWriter;
		const peer = this.threadPeer.get(session.sessionId), threadId = session.threadId;
		if (!peer || peer !== this.peer || !threadId || session.opening || session.awaitingTurn || session.turnId) return;
		const release = unsubscribeThread(peer, threadId, THREAD_TIMEOUT_MS).then(status => {
			if (session.threadId === threadId && this.threadPeer.get(session.sessionId) === peer) this.threadPeer.delete(session.sessionId);
			this.report(session,{kind:"writer-unsubscribed",threadId,status});
		}, error => this.report(session,{kind:"writer-unsubscribe-unconfirmed",threadId,reason:String(error?.message ?? error)}));
		session.releasingWriter = release;
		try { await release; } finally { session.releasingWriter = undefined; }
	}
	scheduleIdleRelease(session) {
		if (!session.sessionId.startsWith("ac:")) return;
		clearTimeout(session.idleReleaseTimer);
		session.idleReleaseTimer = setTimeout(() => void this.releaseIdleThread(session), 5000);
		session.idleReleaseTimer.unref?.();
	}
	async openThread(peer, session, input) {
		const resumeId = session.threadId ?? input.resumeId;
		if (resumeId) {
			if (session.contextPolicyRevision && input.contextPolicy?.revision !== session.contextPolicyRevision && this.threadPeer.get(session.sessionId) === peer) {
				await unsubscribeThread(peer, resumeId, THREAD_TIMEOUT_MS);
				this.threadPeer.delete(session.sessionId);
			}
			const resume = () => peer.request("thread/resume", {
				...this.threadParams(input, session), threadId: resumeId, excludeTurns: true
			}, {timeoutMs:THREAD_TIMEOUT_MS});
			let accepted;
			try {
				accepted = await resume();
			} catch (error) {
				const busy = failure => isActiveWriterError(failure, resumeId);
				try {
					const scope = busy(error) && await this.prepareWriterRecovery?.(session.sessionId);
					if (!scope) throw error;
					accepted = await retryBusyResume(() => {
						if (this.writerRecoveryScopeFor?.(session.sessionId)?.runId !== scope.runId) throw Error("原派单已中止或失去授权");
						return resume();
					}, busy, input.signal);
					if (!accepted) {
						if (!scope.mayFork) throw error;
						const assertCurrent = () => {
							const current = this.writerRecoveryScopeFor?.(session.sessionId);
							if (input.signal?.aborted || this.sessions.get(session.sessionId) !== session ||
								current?.runId !== scope.runId || !current.mayFork || session.awaitingTurn || session.turnId) {
								throw Error("这条接话已经中止或失去原授权");
							}
						};
						const recovery = await forkCompletedCodexHistory(peer,resumeId,this.threadParams(input,session),THREAD_TIMEOUT_MS,assertCurrent);
						try {
							await this.acceptOpenedThread(peer,session,input,recovery.threadId,"active-writer-fork",recovery);
							assertCurrent();
						} catch (e) {
							await unsubscribeThread(peer,recovery.threadId,THREAD_TIMEOUT_MS).catch(()=>{});
							if (session.threadId===recovery.threadId) this.threadPeer.delete(session.sessionId);
							throw e;
						}
						return;
					}
				} catch (failure) {
					const reason=String(failure?.message ?? failure);
					this.report(session,{kind:"continuation-rejected",route:"codex-native",threadId:resumeId,resumeId,reason:reason.slice(0,500),source:"thread/resume"});
					throw Error("Codex native continuation was not accepted for persisted thread "+resumeId+": "+reason);
				}
			}
			if (accepted?.thread?.id !== resumeId) throw Error("Codex 原线程续聊回执不匹配");
			await this.acceptOpenedThread(peer, session, input, resumeId, "resume");
			return;
		}
		const params = this.threadParams(input, session);
		let started;
		try {
			started = await peer.request("thread/start", params, {timeoutMs:THREAD_TIMEOUT_MS});
		} catch (first) {
			const {config,...rest} = params;
			try { started = await peer.request("thread/start",{...rest,...config},{timeoutMs:THREAD_TIMEOUT_MS}); }
			catch { throw first; }
		}
		const threadId = started?.thread?.id ?? started?.threadId;
		if (typeof threadId !== "string" || !threadId) throw Error("codex app-server returned no thread id");
		await this.acceptOpenedThread(peer, session, input, threadId, "start");
	}
	async acceptOpenedThread(peer,session,input,threadId,source,recovery) {
		await this.persistOpenedSession(session,input,threadId,source,recovery);
		session.threadId = threadId;
		await this.applyContextPolicy(peer,session,input);
		this.threadPeer.set(session.sessionId,peer);
		this.report(session,{kind:source==="start"?"thread-created":"continuation-accepted",route:"codex-native",
			sessionId:session.sessionId,rootSessionId:input.rootSessionId??input.sessionId,threadId,acceptanceId:threadId,
			...source==="resume"?{resumeId:threadId,source:"thread/resume"}:source==="start"?{source:"thread/start"}:{source:"thread/fork",...recovery}});
		this.push(session,{type:"thread",threadId});
	}
	async persistOpenedSession(session, input, threadId, source, recovery) {
		if (this.onSessionOpened === void 0) return;
		await this.onSessionOpened({
			sessionId: session.sessionId,
			rootSessionId: input.rootSessionId ?? input.sessionId,
			threadId,
			route: this.route,
			cwd: input.cwd,
			model: input.model,
			permission: input.permission,
			source,
			recovery
		});
	}
	threadParams(input, session) {
		const sandbox = input.permission === "workspace-write" ? "workspace-write" : input.permission === "full-access" ? "danger-full-access" : "read-only";
		return {
			cwd: input.cwd,
			// Code Mode custom tool outputs have no ordinary item/completed notification.
			experimentalRawEvents: true,
			sandbox,
			approvalPolicy: input.permission === "full-access" ? "never" : "on-request",
			...input.model !== void 0 && input.model !== "default" ? { model: input.model } : {},
			config: {
				...input.contextPolicy?.inherit===false && Number.isInteger(input.contextPolicy.tokenThreshold) ? {model_auto_compact_token_limit:input.contextPolicy.tokenThreshold}: {},
				...session.mcpUrl===void 0?{}:{mcp_servers:{dshbot:{url:session.mcpUrl,http_headers:{Authorization:"Bearer "+session.mcp.token}}}}
			}
		};
	}
	async ensure() {
		if (this.peer !== void 0) return this.peer;
		this.starting ??= this.start().finally(() => {
			this.starting = void 0;
		});
		return this.starting;
	}
	async start() {
		const child = spawn(this.executable, [...this.args], {
			env: cleanEnv(),
			stdio: [
				"pipe",
				"pipe",
				"pipe"
			],
			windowsHide: true
		});
		this.child = child;
		this.stderr = "";
		child.unref();
		process.once("exit", () => {
			try {
				child.kill("SIGKILL");
			} catch {}
		});
		child.stderr?.setEncoding("utf8");
		child.stderr?.on("data", (chunk) => {
			this.stderr = `${this.stderr}${chunk}`.slice(-4e3);
		});
		const peer = new JsonRpcPeer((message) => {
			try {
				child.stdin?.write(`${JSON.stringify(message)}\n`);
			} catch {}
		});
		wireChild(child, peer);
		peer.notificationHandler = (method, params) => this.onNotification(method, params);
		peer.requestHandler = (method, params) => this.onServerRequest(method, params);
		child.on("exit", (code) => {
			const reason = /* @__PURE__ */ new Error(`codex app-server exited ${String(code)}${this.stderr === "" ? "" : `: ${this.stderr.split("\n").filter(Boolean).slice(-2).join(" ").slice(0, 300)}`}`);
			peer.close(reason);
			if (this.peer === peer) {
				this.peer = void 0;
				this.child = void 0;
			}
			for (const session of this.sessions.values()) {
				if (this.threadPeer.get(session.sessionId) !== peer) continue;
				clearTimeout(session.idleReleaseTimer);
				if (session.awaitingTurn || session.turnId) this.push(session,{type:"error",error:reason});
				this.threadPeer.delete(session.sessionId);
			}
		});
		try {
			await peer.request("initialize", {
				clientInfo: { name:"dsh-local-agent",title:"DSH Local Agent",version:"1" },
				capabilities: { experimentalApi: true }
			}, { timeoutMs: INIT_TIMEOUT_MS });
			peer.notify("initialized", {});
		} catch (error) {
			try {
				child.kill("SIGKILL");
			} catch {}
			throw error;
		}
		this.peer = peer;
		return peer;
	}
	interruptOwnedTurn({sessionId, threadId, turnId, dispatchId, reason}) {
		const session = this.sessions.get(sessionId);
		if (!session || !this.peer || this.threadPeer.get(sessionId) !== this.peer) return false;
		if (session.threadId !== threadId || session.turnId !== turnId) return false;
		if (dispatchId && session.dispatchId && session.dispatchId !== dispatchId) return false;
		void this.requestInterrupt(session, reason);
		return true;
	}
	async verifyIdleCheckpoint({sessionId, threadId, checkpointTurnId}) {
		const idleInDriver = () => {
			const session = this.sessions.get(sessionId);
			const holder = this.byThread(threadId);
			return (!holder || holder === session) &&
				(!session || (!session.opening && !session.awaitingTurn && !session.turnId &&
					!session.releasingWriter && (!session.threadId || session.threadId === threadId)));
		};
		if (!idleInDriver()) return;
		const peer = await this.ensure();
		if (!idleInDriver()) return;
		const alreadyOwned = this.threadPeer.get(sessionId) === peer;
		let temporaryOwner = false;
		let verified;
		try {
			if (!alreadyOwned) {
				const {thread} = await peer.request("thread/resume", {
					threadId, excludeTurns: true, sandbox: "read-only", approvalPolicy: "never"
				}, { timeoutMs: 5000 });
				if (thread?.id !== threadId) return;
				temporaryOwner = true;
				if (thread.status?.type !== "idle") return;
			}
			const {thread} = await peer.request("thread/read", {threadId, includeTurns: false}, {timeoutMs: 5000});
			if (thread?.id !== threadId || thread.status?.type !== "idle") return;
			const result = await peer.request("thread/turns/list", {threadId, limit: 1, sortDirection: "desc"}, {timeoutMs: 5000});
			const latest = result?.data?.[0];
			if (latest?.id === checkpointTurnId && ["completed", "failed", "interrupted"].includes(latest.status) && idleInDriver()) {
				verified = { threadId, checkpointTurnId, checkpointStatus: latest.status, at: new Date().toISOString() };
			}
		} finally {
			if (temporaryOwner) await unsubscribeThread(peer, threadId, 5000);
		}
		return verified;
	}
	async inspectTurn(threadId,turnId) {
		const peer=await this.ensure();
		const result=await peer.request("thread/read",{threadId,includeTurns:true},{timeoutMs:5000});
		if (result?.thread?.id !== threadId) return;
		const status=result.thread.turns?.find((turn)=>turn.id===turnId)?.status;
		if (status==="completed" || status==="interrupted" || status==="failed") return status;
		if(status==="inProgress"||status==="running")return "running";
		return "unknown";
	}
	onNotification(method, params, receivedAt=Date.now()) {
		const record=asRecord(params) ?? {};
		const threadRecord=asRecord(record.thread);
		const threadId=typeof record.threadId==="string" ? record.threadId : typeof threadRecord?.id==="string" ? threadRecord.id : void 0;
		const session=threadId===void 0 ? void 0 : this.byThread(threadId);
		if (!session) return;
		if (method==="thread/closed") {
			if (!session.opening && !session.awaitingTurn && !session.turnId) this.threadPeer.delete(session.sessionId);
			return;
		}
		const turnRecord=asRecord(record.turn);
		const turnId=typeof record.turnId==="string" ? record.turnId : typeof turnRecord?.id==="string" ? turnRecord.id : void 0;
		// Persisting the full notification belongs to the orchestration evidence store;
		// this stable digest lets it bind raw evidence to the exact accepted thread/turn
		// without copying prompt bodies, tool inputs, or model output through the bus.
		const itemRecord=asRecord(record.item);
		const itemId=typeof itemRecord?.id==="string"?itemRecord.id:typeof record.itemId==="string"?record.itemId:void 0;
		this.report(session,{kind:"app-server-notification",method,threadId,turnId,itemId,at:receivedAt,sha256:createHash("sha256").update(JSON.stringify(params??null)).digest("hex"),source:"app-server"});
		// Some App Server builds emit the whole fast turn before the request promise
		// resumes. Preserve every turn-scoped notification until the caller reaches
		// beginTurn()/bindTurn(), rather than treating a real completed turn as foreign.
		if(turnId!==void 0&&session.turnId===void 0&&session.awaitingTurn!==true){
			session.early ??= new Map();const parked=session.early.get(turnId)??[];
			if(parked.length<256)parked.push({method,params,at:receivedAt});session.early.set(turnId,parked);
			while(session.early.size>5)session.early.delete(session.early.keys().next().value);return;
		}
		if (turnId!==void 0 && (session.settledTurns?.includes(turnId) || (session.turnId!==void 0 && turnId!==session.turnId))) {
			this.keepForeign(session,method,turnId);
			return;
		}
		const itemNotification=method.startsWith("item/") || method==="rawResponseItem/completed";
		if (itemNotification && turnId===void 0) return;
		if (session.turnId===void 0 && turnId!==void 0 && (itemNotification || method==="turn/completed")) {
			if (session.awaitingTurn!==true) return;
			session.early ??= new Map();
			const buffered=session.early.get(turnId) ?? [];
			if (buffered.length<256) buffered.push({method,params,at:receivedAt});
			session.early.set(turnId,buffered);
			while(session.early.size>5) session.early.delete(session.early.keys().next().value);
			return;
		}
		switch (method) {
			case "turn/started": {
				const turn = asRecord(record["turn"]);
				const startedId = typeof turn?.["id"] === "string" ? turn["id"] : turnId;
				if (session !== void 0) this.bindTurn(session, startedId);
				break;
			}
			case "rawResponseItem/completed": {
				const item=asRecord(record.item);
				const itemId=item?.call_id ?? item?.callId;
				if (typeof itemId!=="string" || !itemId || turnId!==session.turnId) break;
				const type=item.type;
				// Use the call ID; the result does not always have a ResponseItem ID.
				if (type==="custom_tool_call") {
					if (session.items.has(itemId) || session.completedItems?.has(itemId)) break;
					session.items.set(itemId,{kind:"tool",deltas:0});
					this.report(session,{kind:"tool-start",itemId,turnId,tool:"customToolCall",at:receivedAt});
				} else if (type==="custom_tool_call_output") {
					session.completedItems ??= new Set();
					if (session.completedItems.has(itemId)) break;
					session.completedItems.add(itemId);
					session.items.delete(itemId);
					this.report(session,{kind:"tool-end",itemId,turnId,tool:"customToolCall",at:receivedAt});
				}
				break;
			}
			case "item/agentMessage/delta": {
				const delta = typeof record["delta"] === "string" ? record["delta"] : "";
				if (delta === "") break;
				this.countDelta(session, record);
				this.reportProgress(session, "delta", record, turnId);
				this.push(session, {
					type: "text",
					text: delta
				});
				break;
			}
			case "item/reasoning/textDelta":
			case "item/reasoning/summaryTextDelta": {
				const delta = typeof record["delta"] === "string" ? record["delta"] : "";
				if (delta === "") break;
				this.countDelta(session, record);
				this.reportProgress(session, "delta", record, turnId);
				this.push(session, {
					type: "thought",
					text: delta
				});
				break;
			}
			case "item/commandExecution/outputDelta": {
				const delta = typeof record["delta"] === "string" ? record["delta"] : "";
				if (delta === "") break;
				this.reportProgress(session, "delta", record, turnId);
				break;
			}
			case "thread/compacted": {
				if(session?.contextPolicy)this.report(session,{kind:"compaction-policy-confirmed",...session.contextPolicy,source:"thread/compacted"});
				const open = session !== void 0 && [...session.items.values()].some((entry) => entry.kind === "compaction");
				if (!open) this.report(session, {
					kind: "compaction-end",
					turnId: turnId ?? session?.turnId,
					stage: "thread-compacted"
				});
				this.push(session, {
					type: "activity",
					text: "上下文压缩完成"
				});
				break;
			}
			case "item/started": {
				const item = asRecord(record["item"]);
				if (item === void 0) break;
				const type = String(item["type"] ?? "");
				const itemId = typeof item["id"] === "string" ? item["id"] : void 0;
				// [BARU-PATCH] A bridged tool (`dshbot`) is a DSH tool call the session already
				// registers on its own; counting it twice would close the wrong in-flight slot.
				const kind=type==="mcpToolCall" && item["server"]==="dshbot" ? "bridge" : itemKindOf(type);
				if (itemId!==void 0 && (session.items.has(itemId) || session.completedItems?.has(itemId))) break;
				if (itemId!==void 0) {
					session.items.set(itemId, {
						kind,
						deltas: 0
					});
					if (kind === "tool") this.report(session, {
						kind: "tool-start",
						itemId,
						tool: type, at: receivedAt,
						turnId: turnId ?? session.turnId
					});
					else if (kind === "compaction") this.report(session, {
						kind: "compaction-start",
						itemId,
						turnId: turnId ?? session.turnId
					});
				}
				if (type === "commandExecution") this.push(session, {
					type: "activity",
					text: `Run ${truncate(String(item["command"] ?? "a command"), 160)}`
				});
				else if (type === "fileChange") this.push(session, {
					type: "activity",
					text: "Edit files"
				});
				else if (type === "mcpToolCall" && item["server"] !== "dshbot") this.push(session, {
					type: "activity",
					text: `Tool ${String(item["tool"] ?? "call")}`
				});
				else if (kind === "compaction") this.push(session, {
					type: "activity",
					text: "正在压缩上下文"
				});
				break;
			}
			case "item/completed": {
				const item = asRecord(record["item"]);
				if (item === void 0) break;
				const type = String(item["type"] ?? "");
				const itemId=typeof item["id"]==="string" ? item["id"] : void 0;
				session.completedItems ??= new Set();
				if (itemId!==void 0 && session.completedItems.has(itemId)) break;
				const tracked=itemId===void 0 ? void 0 : session.items.get(itemId);
				if (itemId!==void 0) {
					session.completedItems.add(itemId);
					session.items.delete(itemId);
					const kind=tracked?.kind ?? (type==="mcpToolCall" && item["server"]==="dshbot" ? "bridge" : itemKindOf(type));
					if (kind==="tool" || kind==="bridge") this.report(session,{kind:"tool-end",itemId,tool:type,status:String(item.status??""),turnId,at:receivedAt});
					else if (kind==="compaction") {this.report(session,{kind:"compaction-end",itemId,turnId,at:receivedAt});if(session.contextPolicy)this.report(session,{kind:"compaction-policy-confirmed",...session.contextPolicy,source:"item/contextCompaction/completed"});}
					else if (type==="agentMessage" || type==="reasoning") this.report(session,{kind:"item-end",itemId,turnId,at:receivedAt});
				}
				if (type === "agentMessage") {
					const text = typeof item["text"] === "string" ? item["text"] : "";
					// [BARU-PATCH] The adapter appends every text event to ONE block, so the whole
					// message must not be repeated after its deltas already arrived.
					if (text !== "" && (tracked?.deltas ?? 0) === 0) this.push(session, {
						type: "text",
						text
					});
				} else if (type === "reasoning") {
					const text = reasoningText(item);
					if (text !== "" && (tracked?.deltas ?? 0) === 0) this.push(session, {
						type: "thought",
						text
					});
				} else if (type === "commandExecution") {
					if (String(item["status"] ?? "") === "failed") this.push(session, {
						type: "activity",
						text: "Run failed"
					});
				} else if (type === "mcpToolCall" && item["server"] !== "dshbot") this.push(session, {
					type: "activity",
					text: `Tool ${String(item["tool"] ?? "call")} done`
				});
				break;
			}
			case "turn/completed": {
				const turn=asRecord(record["turn"]);
				const status=turn?.["status"];
				const completedId=typeof turn?.id==="string" ? turn.id : turnId;
				if (completedId!==session.turnId || !["completed","interrupted","failed"].includes(status)) break;
				this.settleTurn(session,completedId,status);
				if (status === "failed") {
					const error = asRecord(turn?.["error"]);
					this.push(session, {
						type: "error",
						error: new Error(String(error?.["message"] ?? "the turn failed"))
					});
				} else if (status === "interrupted") this.push(session, {
					type: "done",
					reason: "interrupted"
				});
				else this.push(session, { type: "done" });
				break;
			}
			case "thread/tokenUsage/updated": {
				const last = asRecord(asRecord(record["tokenUsage"])?.["last"]);
				if (last !== void 0) this.push(session, {
					type: "usage",
					usage: usageOf(last)
				});
				break;
			}
			case "error": {
				if (record["willRetry"] === true) break;
				const error = asRecord(record["error"]);
				this.push(session, {
					type: "error",
					error: new Error(String(error?.["message"] ?? "codex reported an error"))
				});
				break;
			}
		}
	}
	/**
	* Server-initiated requests. A3 declines everything deterministically so a turn can never
	* hang on a dialog nobody can see; A4 replaces the command/file-changes branch with the
	* DSH approval bridge.
	*/
	async onServerRequest(method, params) {
		const record = params !== null && typeof params === "object" ? params : {};
		const threadId = typeof record["threadId"] === "string" ? record["threadId"] : void 0;
		const session = threadId === void 0 ? void 0 : this.byThread(threadId);
		if (method === "item/tool/call") {
			const callId = String(record["callId"] ?? "");
			const tool = normalizeToolName(String(record["tool"] ?? ""));
			const args = record["arguments"] !== null && typeof record["arguments"] === "object" ? record["arguments"] : {};
			if (callId === "" || tool === "") return {
				contentItems: [{
					type: "inputText",
					text: "invalid delegated tool call"
				}],
				success: false
			};
			const result = await new Promise((resolve) => {
				this.delegatedCalls.set(callId, resolve);
				this.push(session, {
					type: "tool-call",
					callId,
					name: tool,
					arguments: args
				});
			});
			return {
				contentItems: [{
					type: "inputText",
					text: result.text
				}],
				success: !result.isError
			};
		}
		const approvalAction = () => {
			switch (method) {
				case "mcpServer/elicitation/request": {
					const meta = record["_meta"] !== null && typeof record["_meta"] === "object" ? record["_meta"] : {};
					if (meta["codex_approval_kind"] !== "mcp_tool_call") return void 0;
					return {
						action: typeof record["message"] === "string" ? record["message"] : "The agent asks to call an MCP tool",
						detail: [typeof meta["tool_description"] === "string" ? meta["tool_description"] : "", meta["tool_params"] !== null && typeof meta["tool_params"] === "object" ? JSON.stringify(meta["tool_params"]) : ""].filter(Boolean).join("\n").slice(0, 4e3)
					};
				}
				case "item/commandExecution/requestApproval": return {
					action: "The agent asks to run a command",
					detail: [record["command"], record["reason"]].filter((part) => typeof part === "string").join("\n").slice(0, 4e3)
				};
				case "item/fileChange/requestApproval": return {
					action: "The agent asks to change files",
					detail: [record["reason"], record["grantRoot"]].filter((part) => typeof part === "string").join("\n").slice(0, 4e3)
				};
				case "execCommandApproval":
				case "applyPatchApproval": return {
					action: method === "execCommandApproval" ? "The agent asks to run a command" : "The agent asks to apply a patch",
					detail: [record["command"], record["reason"]].filter((part) => typeof part === "string").join("\n").slice(0, 4e3)
				};
				default: return;
			}
		};
		const approval = approvalAction();
		if (approval !== void 0) {
			const callId = `approval-${randomUUID()}`;
			const decision = await new Promise((resolve) => {
				this.pendingApprovals.set(callId, resolve);
				this.push(session, {
					type: "tool-call",
					callId,
					name: "approve_agent_action",
					arguments: {
						action: approval.action,
						...approval.detail === "" ? {} : { detail: approval.detail }
					}
				});
			});
			switch (method) {
				case "mcpServer/elicitation/request": return decision.allow ? {
					action: "accept",
					content: {}
				} : { action: "decline" };
				case "item/commandExecution/requestApproval":
				case "item/fileChange/requestApproval": return { decision: decision.allow ? "accept" : "decline" };
				default: return { decision: decision.allow ? "approved" : "denied" };
			}
		}
		if (method === "item/permissions/requestApproval") {
			this.push(session, {
				type: "activity",
				text: "The agent asked for extra sandbox permissions — denied (not bridged in v1)"
			});
			return { permissions: null };
		}
		if (method === "mcpServer/elicitation/request") return { action: "decline" };
		throw new Error(`unsupported app-server request: ${method}`);
	}
	byThread(threadId) {
		for (const session of this.sessions.values()) if (session.threadId === threadId) return session;
	}
	push(session, event) {
		if (session === void 0 || session.closed) return;
		session.queue.push(event);
		const notify = session.notify;
		session.notify = void 0;
		notify?.();
	}
	next(session, signal) {
		const stopped = { type: "done", reason: "stopped" };
		if (signal?.aborted) return Promise.resolve(stopped);
		const queued = session.queue.shift();
		if (queued !== void 0) return Promise.resolve(queued);
		if (session.closed) return Promise.reject(new Error("codex session closed"));
		return new Promise((resolve, reject) => {
			const onAbort = () => {
				if (session.notify === onReady) session.notify = void 0;
				resolve(stopped);
			};
			const onReady = () => {
				signal?.removeEventListener("abort", onAbort);
				const event = session.queue.shift();
				if (event !== void 0) resolve(event);
				else reject(new Error("codex session closed"));
			};
			session.notify = onReady;
			signal?.addEventListener("abort", onAbort, { once: true });
		});
	}
};
/** `mcp__server__tool`, `server.tool` and bare names all reach DSH as the bare tool name. */
function normalizeToolName(tool) {
	const trimmed = tool.trim();
	if (trimmed === "") return "";
	const parts = trimmed.split(/__|\./);
	return parts[parts.length - 1] ?? trimmed;
}
/** Fail-closed: only a well-formed {"decision":"allow"} from the DSH tool counts. */
function approvalDecisionOf(result) {
	if (result.isError) return { allow: false };
	try {
		const parsed = JSON.parse(result.text);
		return { allow: parsed !== null && typeof parsed === "object" && parsed.decision === "allow" };
	} catch {
		return { allow: false };
	}
}
function asRecord(value) {
	return value !== null && typeof value === "object" ? value : void 0;
}
/**
* [BARU-PATCH 2026-11-15] Which bookkeeping class an upstream thread item belongs to.
*
* `contextCompaction` is the item form of the compaction lifecycle (the app-server also sends a
* standalone `thread/compacted` when only the end is reported); everything that can hold a
* process open for minutes counts as a TOOL, because that is the budget it has to run under.
*/
function itemKindOf(type) {
	switch (type) {
		case "commandExecution":
		case "mcpToolCall":
		case "fileChange":
		case "dynamicToolCall":
		case "webSearch":
		case "sleep": return "tool";
		case "contextCompaction": return "compaction";
		default: return "text";
	}
}
function asError(value) {
	return value instanceof Error ? value : new Error(String(value));
}
function reasoningText(item) {
	const content = item["content"];
	if (Array.isArray(content)) {
		const text = content.map((part) => part !== null && typeof part === "object" ? part["text"] : void 0).filter((part) => typeof part === "string").join("\n");
		if (text !== "") return text;
	}
	const summary = item["summary"];
	if (typeof summary === "string") return summary;
	return "";
}
const truncate = (text, max) => text.length <= max ? text : `${text.slice(0, max - 1)}…`;
function usageOf(last) {
	const number = (value) => typeof value === "number" && Number.isFinite(value) ? value : 0;
	return {
		inputTokens: number(last["inputTokens"]),
		outputTokens: number(last["outputTokens"]),
		...number(last["cachedInputTokens"]) === 0 ? {} : { cacheReadTokens: number(last["cachedInputTokens"]) },
		...number(last["reasoningOutputTokens"]) === 0 ? {} : { reasoningTokens: number(last["reasoningOutputTokens"]) }
	};
}
//#endregion
//#region src/engines.ts
/** Custom agents always get an `acp-<id>` route. */
const CUSTOM_ROUTE_PREFIX = "acp-";
/**
* Known agent CLIs.
*
* `args` are the args the DRIVER passes when starting the agent (A2/A6); the discovery layer
* only needs `command`, `appPaths` and `versionArgs`.
*/
const ENGINES = {
	"claude-code": {
		route: "claude-code",
		name: "Claude Code",
		kind: "claude",
		command: "claude",
		args: [],
		versionArgs: ["--version"],
		signInHint: "claude",
		contextWindow: 2e5
	},
	"codex-cli": {
		route: "codex-cli",
		name: "Codex CLI",
		kind: "codex",
		command: "codex",
		args: [
			"app-server",
			"--listen",
			"stdio://"
		],
		appPaths: ["/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex"],
		versionArgs: ["--version"],
		signInHint: "codex login",
		contextWindow: 2e5
	},
	"grok-build": {
		route: "grok-build",
		name: "Grok Build",
		kind: "acp",
		command: "grok",
		args: ["agent", "stdio"],
		versionArgs: ["--version"],
		signInHint: "grok",
		contextWindow: 2e5
	},
	"gemini-cli": {
		route: "gemini-cli",
		name: "Gemini CLI",
		kind: "acp",
		command: "gemini",
		args: ["--acp"],
		versionArgs: ["--version"],
		signInHint: "gemini",
		contextWindow: 1e6
	},
	opencode: {
		route: "opencode",
		name: "OpenCode",
		kind: "acp",
		command: "opencode",
		args: ["acp"],
		versionArgs: ["--version"],
		signInHint: "opencode auth login",
		contextWindow: 2e5
	},
	cline: {
		route: "cline",
		name: "Cline",
		kind: "acp",
		command: "cline",
		args: ["--acp"],
		env: { CLINE_SESSION_BACKEND_MODE: "local" },
		versionArgs: ["--version"],
		signInHint: "cline auth",
		contextWindow: 2e5
	},
	"cursor-cli": {
		route: "cursor-cli",
		name: "Cursor CLI",
		kind: "acp",
		command: "cursor-agent",
		args: ["acp"],
		versionArgs: ["--version"],
		signInHint: "cursor-agent login",
		contextWindow: 2e5
	},
	goose: {
		route: "goose",
		name: "Goose",
		kind: "acp",
		command: "goose",
		args: ["acp"],
		versionArgs: ["--version"],
		signInHint: "goose configure",
		contextWindow: 2e5
	},
	"qwen-code": {
		route: "qwen-code",
		name: "Qwen Code",
		kind: "acp",
		command: "qwen",
		args: ["--acp"],
		versionArgs: ["--version"],
		signInHint: "qwen",
		contextWindow: 2e5
	}
};
Object.keys(ENGINES);
/** Route id for a custom agent. */
function customRoute(id) {
	return `${CUSTOM_ROUTE_PREFIX}${id}`;
}
/**
* Resolve one route to its engine spec, built-in or custom.
*
* @param route - a built-in route id or `acp-<custom id>`.
* @param custom - the stored custom agents.
* @returns the spec, or undefined when the route is not one this plugin owns.
*/
function engineOf(route, custom) {
	const builtIn = ENGINES[route];
	if (builtIn !== void 0) return builtIn;
	if (!route.startsWith("acp-")) return void 0;
	const id = route.slice(4);
	const agent = custom.find((entry) => entry.id === id);
	if (agent === void 0) return void 0;
	return {
		route,
		name: agent.name,
		kind: "acp",
		command: agent.command,
		args: agent.args,
		versionArgs: ["--version"]
	};
}
/** Whether the route belongs to this feature. */
function isLocalAgentRoute(route, custom) {
	return engineOf(route, custom) !== void 0;
}
/**
* Validate a user-supplied ACP agent.
*
* This is injection-hardening, NOT a sandbox: the command runs as the user. Rules:
* - name is trimmed and capped at 40 characters;
* - command has no whitespace and is a bare name, an absolute path, or `~/…`;
* - args never carry NUL or line breaks (they could smuggle a second command line).
*
* @throws Error with a user-facing reason.
*/
function validateCustomAgent(input) {
	const name = String(input.name ?? "").trim().slice(0, 40);
	if (name === "") throw new Error("Name is required");
	const command = String(input.command ?? "").trim();
	if (command === "" || /\s/.test(command)) throw new Error("Command must be a program name, an absolute path, or a ~/path");
	if (!(command.startsWith("/") || command.startsWith("~/") || /^[A-Za-z]:[\\/]/.test(command) || /^[\w.-]+$/.test(command))) throw new Error("Command must be a program name, an absolute path, or a ~/path");
	const args = (Array.isArray(input.args) ? input.args : String(input.args ?? "").split(/\s+/)).map((arg) => String(arg).trim()).filter((arg) => arg !== "");
	if (args.some((arg) => arg.includes("\0") || /[\r\n]/.test(arg))) throw new Error("Arguments must not contain newlines");
	return {
		name,
		command,
		args
	};
}
//#endregion
//#region src/tools.ts
/**
* Build the tool definition.
*
* @param approval - called at execution time; undefined on a host without the service means
*   every request is denied (the turn fails visibly rather than silently proceeding).
*/
function approveAgentActionTool(approval) {
	return {
		name: "approve_agent_action",
		description: "Ask the user to approve an action you want to take: running a command, changing files, or calling a tool. The agent runtime asks this on your behalf when its own permission system wants a decision.",
		parameters: {
			type: "object",
			properties: {
				action: {
					type: "string",
					description: "What the action does, in one line"
				},
				detail: {
					type: "string",
					description: "The exact command, paths, or arguments, when it helps the decision"
				}
			},
			required: ["action"]
		},
		output: {
			schema: {
				type: "object",
				properties: { decision: { type: "string" } },
				required: ["decision"]
			},
			render: (_args, value) => {
				const decision = (value !== null && typeof value === "object" ? value.decision : void 0) === "allow" ? "allow" : "deny";
				return [{
					type: "text",
					text: JSON.stringify({ decision })
				}];
			}
		},
		async execute(args, exec) {
			const approvalService = approval();
			if (approvalService === void 0 || exec.agent === void 0) return { decision: "deny" };
			const input = args !== null && typeof args === "object" ? args : {};
			const action = String(input["action"] ?? "The agent asks to run an action").slice(0, 500);
			const detail = typeof input["detail"] === "string" ? input["detail"].slice(0, 4e3) : void 0;
			const text = detail === void 0 || detail === "" ? action : `${action}\n${detail}`;
			try {
				return { decision: await approvalService.request({
					agent: exec.agent,
					toolName: "approve_agent_action",
					...exec.callId === void 0 ? {} : { callId: exec.callId },
					reason: text,
					displayReason: { en: text },
					...exec.signal === void 0 ? {} : { signal: exec.signal }
				}) === "allowed-once" ? "allow" : "deny" };
			} catch {
				return { decision: "deny" };
			}
		}
	};
}
/**
* `agent_switch_model` — change THIS conversation's model when the user asks in natural
* language. Session-scoped by design (the Bot's configured model is unchanged; switching
* there is a settings action).
*
* Unknown ids are rejected with the available list, so the agent can tell the user what it
* can switch to instead of silently sending a bad model to the CLI.
*/
function switchModelTool(port) {
	return {
		name: "agent_switch_model",
		description: "Switch the model used for THIS conversation when the user asks for it (for example \"use opus\" or \"换成 sonnet\"). Only the current conversation is affected; the Bot default model is changed in settings. Returns the applied model, or the list of available models when the request is unavailable.",
		parameters: {
			type: "object",
			properties: { model: {
				type: "string",
				description: "The model id or name to switch to"
			} },
			required: ["model"]
		},
		output: {
			schema: {
				type: "object",
				properties: {
					ok: { type: "boolean" },
					model: { type: "string" },
					available: {
						type: "array",
						items: { type: "string" }
					},
					error: { type: "string" }
				},
				required: ["ok"]
			},
			render: (_args, value) => [{
				type: "text",
				text: JSON.stringify(value ?? { ok: false })
			}]
		},
		async execute(args, exec) {
			const switchPort = port();
			const sessionId = exec.agent !== null && typeof exec.agent === "object" && typeof exec.agent.id === "string" ? exec.agent.id : void 0;
			if (switchPort === void 0 || sessionId === void 0) return {
				ok: false,
				error: "model switching is unavailable in this host"
			};
			const wanted = String((args !== null && typeof args === "object" ? args : {})["model"] ?? "").trim();
			if (wanted === "") return {
				ok: false,
				error: "a model is required"
			};
			try {
				return await switchPort.switchModel(sessionId, wanted);
			} catch (error) {
				const available = await switchPort.availableModels(sessionId).catch(() => []);
				return {
					ok: false,
					error: error instanceof Error ? error.message : String(error),
					...available.length === 0 ? {} : { available }
				};
			}
		}
	};
}
function emptyState() {
	return {
		version: 1,
		custom: [],
		sessions: {}
	};
}
function isSessionRecord(value) {
	if (value === null || typeof value !== "object") return false;
	const record = value;
	return typeof record["route"] === "string" && typeof record["updatedAt"] === "string";
}
function isCustomAgent(value) {
	if (value === null || typeof value !== "object") return false;
	const agent = value;
	return typeof agent.id === "string" && typeof agent.name === "string" && typeof agent.command === "string" && Array.isArray(agent.args) && agent.args.every((arg) => typeof arg === "string");
}
/** Parse a state file tolerantly; undefined means "unreadable, start empty". */
function parseState(raw) {
	try {
		const parsed = JSON.parse(raw);
		if (parsed.version !== 1 || !Array.isArray(parsed.custom)) return void 0;
		const sessions = {};
		if (parsed.sessions !== null && typeof parsed.sessions === "object") {
			for (const [sessionId, value] of Object.entries(parsed.sessions)) if (isSessionRecord(value)) sessions[sessionId] = value;
		}
		return {
			version: 1,
			custom: parsed.custom.filter(isCustomAgent).map((agent) => ({
				id: agent.id,
				name: agent.name,
				command: agent.command,
				args: [...agent.args]
			})),
			sessions
		};
	} catch {
		return;
	}
}
/** Read state; a missing file is a normal first run. */
async function loadState(path, warn) {
	try {
		const parsed = parseState(await readFile(path, "utf8"));
		if (parsed !== void 0) return parsed;
		warn(`[local-agent] ignoring unreadable state at ${path}; starting empty`);
		return emptyState();
	} catch (error) {
		if (error.code !== "ENOENT") warn(`[local-agent] cannot read state at ${path}: ${String(error)}`);
		return emptyState();
	}
}
/** Atomic write: temp file in the same directory, then rename. */
async function saveState(path, state) {
	await mkdir(dirname(path), { recursive: true });
	const temp = `${path}.tmp-${randomUUID()}`;
	await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, {
		encoding: "utf8",
		mode: 384
	});
	await rename(temp, path);
}
/** Stable-enough id for a user-added agent. */
function newCustomAgentId() {
	return `agent-${randomUUID().replaceAll("-", "").slice(0, 10)}`;
}
//#endregion
//#region src/index.ts
/**
* Local Agent — host service (A1: discovery foundation).
*
* WHAT THIS PACKAGE IS FOR. A Bot's model route can be served by an agent CLI already
* installed and signed in on the user's machine (Claude Code, Codex, any ACP agent). A2/A6
* register those routes as DSH LLM providers; this file is the base they build on: find the
* CLIs, keep the user's custom ACP agents, persist the little state involved, and expose the
* settings snapshot over the plugin's Remote surface.
*
* WHY A SEPARATE SERVICE. Discovery is useful even when route registration is unavailable on
* an older host (`supported` is reported separately), and keeping it out of the 8k-line
* agent-community service keeps the failure surface small.
*
* @module
*/
/** Plugin config schema; every new knob is documented on the interface in types.ts. */
const Config = z.object({
	enabled: z.boolean().default(true),
	homeDir: z.string().required(false),
	extraSearchDirs: z.array(z.string()).default([]),
	versionProbeTimeoutMs: z.number().step(1).min(1e3).default(1e4),
	toolsBridge: z.boolean().default(true)
});
/** The methods the browser may call through the Remote gateway. */
const REMOTE_METHODS = [
	"snapshot",
	"refresh",
	"addCustomAgent",
	"updateCustomAgent",
	"removeCustomAgent"
];
/**
* Where `local-agent/state.json` lives.
*
* Same precedence as the community board: explicit config, then the harness home, then the
* default. An isolated `$DSH_HOME` must stay isolated.
*/
function resolveLocalAgentHome(configured) {
	if (configured !== void 0 && configured !== "") return configured;
	const fromEnv = process.env.DSH_HOME;
	if (fromEnv !== void 0 && fromEnv !== "") return fromEnv;
	return join(homedir(), ".dsh");
}
function routeView(spec, custom, path) {
	return {
		route: spec.route,
		name: spec.name,
		kind: spec.kind,
		custom,
		available: path !== void 0,
		...path === void 0 ? {} : { path },
		...spec.signInHint === void 0 ? {} : { signInHint: spec.signInHint }
	};
}
/**
* Scan every built-in route plus the custom agents.
*
* Pure discovery: no state is written, no process is started. Exported so tests and the
* spike harness can verify discovery without booting the service.
*/
async function discoverAgents(custom, extraSearchDirs = []) {
	await refreshSearchDirs(extraSearchDirs);
	const views = [];
	for (const spec of Object.values(ENGINES)) views.push(routeView(spec, false, findExecutable(spec.command, spec.appPaths)));
	for (const agent of custom) views.push(routeView({
		route: customRoute(agent.id),
		name: agent.name,
		kind: "acp"
	}, true, findExecutable(agent.command)));
	return views;
}
/** Host service: discovery + custom agents + settings RPC. */
var LocalAgentService = class extends TypertRemoteService {
	/** A2/A6 need `llm`; declaring it here keeps activation honest (no half-mounted service). */
	static inject = ["llm"];
	static Config = Config;
	cfg;
	home;
	statePath;
	state = emptyState();
	detected = [];
	scannedAt = "";
	writeQueue = Promise.resolve();
	/** Driver per registered route (currently Codex only; ACP/Claude add entries later). */
	drivers = /* @__PURE__ */ new Map();
	/** Executable each driver was created for, so a rescan can tell "unchanged" from "moved". */
	driverPaths = /* @__PURE__ */ new Map();
	adapter;
	registration;
	/** Host approval service, captured when present; absent means every agent approval is denied. */
	approvalService;
	toolsDisposers = [];
	/** Permission reported by the Bot's session runner before the first turn of a session. */
	pendingPermissions = /* @__PURE__ */ new Map();
	/** Resolved when Cordis injects the host's LLM registry (absent on hosts that cannot route). */
	llmService;
	constructor(ctx, config = {}) {
		super(ctx, "localAgent");
		this.cfg = {
			enabled: config.enabled ?? true,
			extraSearchDirs: config.extraSearchDirs ?? [],
			versionProbeTimeoutMs: config.versionProbeTimeoutMs ?? 1e4,
			toolsBridge: config.toolsBridge !== false
		};
		this.home = resolveLocalAgentHome(config.homeDir);
		this.statePath = join(this.home, "local-agent", "state.json");
		ctx.inject(["llm"], (child) => {
			const service = child.llm;
			if (service !== null && typeof service === "object" && typeof service.registerAdapter === "function") {
				this.llmService = service;
				this.scanSync();
				this.rebuildRoutes();
			}
		});
		ctx.inject(["approval"], (child) => {
			const approval = child.approval;
			if (approval !== void 0 && typeof approval.request === "function") this.approvalService = approval;
		});
		ctx.inject(["tools"], (child) => {
			const tools = child.tools;
			if (tools === void 0 || typeof tools.register !== "function") return;
			const port = this;
			this.toolsDisposers.push(tools.register(approveAgentActionTool(() => this.approvalService)), tools.register(switchModelTool(() => port)));
		});
		try {
			const off=ctx.on("agent-community:codex-inspect-stop",(payload)=>void this.inspectCodexStop(payload),{global:true});
			ctx.effect(()=>()=>off?.(),"local-agent: stop reconciliation");
		} catch {}
		ctx.effect(() => () => {
			this.dispose();
		}, "local-agent: runtime");
		setTimeout(() => {
			this.initialize().catch((error) => {
				ctx.logger?.warn?.(`[local-agent] initialization failed: ${String(error)}`);
			});
		}, 0).unref?.();
	}
	async initialize() {
		this.state = await loadState(this.statePath, (message) => this.ctx.logger?.warn?.(message));
		if (!this.cfg.enabled) {
			this.ctx.logger?.info?.("[local-agent] disabled by config; no scan performed");
			return;
		}
		await this.scan();
		await this.probeVersions();
		this.rebuildRoutes();
		const startupReceipt=process.env.DSH_AGENT_COMMUNITY_RELAY_STARTUP_RECEIPT;
		if (startupReceipt) await writeFile(startupReceipt+".local-agent.json",JSON.stringify({
			pid:process.pid,module:import.meta.url,loadedAt:new Date().toISOString(),statePath:this.statePath,
			sha256:createHash("sha256").update(await readFile(new URL(import.meta.url))).digest("hex").toUpperCase(),
			recoveryModuleSha256:createHash("sha256").update(await readFile(new URL("codex-writer-recovery.mjs",import.meta.url))).digest("hex").toUpperCase(),
			engine:this.detected.find(agent=>agent.route==="codex-cli"),
			recoveredSessions:Object.entries(this.state.sessions).filter(([,row])=>row.writerRecoveries?.length)
				.map(([sessionId,row])=>({sessionId,resumeId:row.resumeId,recovery:row.writerRecoveries.at(-1)}))
		},null,2),{flag:"wx"});
	}
	/** The host LLM registry, or undefined on a host that cannot register routes. */
	llm() {
		return this.llmService;
	}
	/**
	* [BARU-PATCH 2026-11-15] Republish driver progress on the host bus.
	*
	* Two plugins live in this process: `local-agent` owns the Codex turn, `agent-community` owns
	* the run budget that must stop declaring 「无进展」 while a tool is legitimately still running.
	* Neither package can import the other, so the host context is the seam. Payloads carry ids,
	* kinds and timestamps only — never prompt text, tool output or reasoning bodies.
	*/
	interruptBoundCodexTurn(input) {
		if (this.state.sessions[input.sessionId]?.resumeId !== input.threadId) return false;
		return this.drivers.get("codex-cli")?.interruptOwnedTurn(input) ?? false;
	}
	async verifyCodexIdleCheckpoint(input) {
		const binding = this.state.sessions[input.sessionId];
		if (binding?.route !== "codex-cli" || binding.resumeId !== input.threadId) return;
		this.assertExclusiveCodexBinding(input.sessionId, input.threadId);
		return await this.drivers.get("codex-cli")?.verifyIdleCheckpoint(input);
	}
	async inspectCodexStop(payload) {
		if(typeof payload?.threadId!=="string"||typeof payload?.turnId!=="string"||typeof payload?.runId!=="string")return;
		const driver=this.drivers.get("codex-cli");let status="unknown";
		try{if(typeof driver?.inspectTurn==="function")status=await driver.inspectTurn(payload.threadId,payload.turnId)??"unknown";}catch{}
		this.reportCodexProgress({kind:payload.verification?"upstream-checked":"stop-inspected",runId:payload.runId,threadId:payload.threadId,turnId:payload.turnId,status,at:Date.now(),source:"thread/read"});
	}

	reportCodexProgress(payload) {
		try {
			this.ctx.emit?.("agent-community:codex-progress", payload);
		} catch (error) {
			this.ctx.logger?.warn?.(`[local-agent] progress publish failed: ${String(error)}`);
		}
	}
	/**
	 * Restore an aggregate-owned Codex relation into the driver cache before the
	 * next DSH session turn.  The aggregate remains the authority; this plugin's
	 * state record is only the adapter input that supplies `resumeId` to stream().
	 * It is intentionally host-only (not a browser RPC), so an untrusted client
	 * cannot point a Bot at an arbitrary Codex thread.
	 */
	async restoreCodexContinuation(input) {
		const sessionId=typeof input?.sessionId==="string"?input.sessionId:"",threadId=typeof input?.threadId==="string"?input.threadId:"";
		if(!sessionId||!threadId)throw Error("Codex continuation needs a trusted sessionId and threadId");
		const previous=this.state.sessions[sessionId]??{};
		if (previous.resumeId===threadId) return {ok:true,sessionId,threadId};
		if (this.codexWriterRecoveryFrom(sessionId,threadId,previous.resumeId)) {
			return {ok:true,sessionId,threadId:previous.resumeId,supersededThreadId:threadId};
		}
		this.assertExclusiveCodexBinding(sessionId,threadId);
		const driver=this.drivers.get("codex-cli");
		const live=driver?.sessions?.get?.(sessionId);
		if (live?.awaitingTurn || live?.turnId || live?.opening) return {ok:false,sessionId,reason:"当前 Codex 回合仍在使用本会话"};
		if(live?.threadId!==void 0&&live.threadId!==threadId)await driver.resetSession?.(sessionId);
		this.state={...this.state,sessions:{...this.state.sessions,[sessionId]:{...previous,route:"codex-cli",resumeId:threadId,cwd:previous.cwd??process.cwd(),model:previous.model??"default",updatedAt:new Date().toISOString()}}};
		await this.persist();
		return {ok:true,sessionId,threadId};
	}
	codexWriterRecoveryFrom(sessionId, previousThreadId, threadId) {
		return recoveryChain(this.state.sessions[sessionId],previousThreadId,threadId);
	}
	assertExclusiveCodexBinding(sessionId, threadId) {
		if (Object.entries(this.state.sessions).some(([id,row]) => id!==sessionId && row.route==="codex-cli" && row.resumeId===threadId)) {
			throw Error("Codex 原线程已绑定其他会话，禁止串用");
		}
	}
	/** Persist the native identity before this logical turn is allowed to start. */
	async persistCodexThreadSession(binding) {
		const {sessionId,threadId,recovery}=binding;
		if (!sessionId || !threadId) throw Error("Codex thread binding needs sessionId and threadId");
		const previous=this.state.sessions[sessionId]??{};
		this.assertExclusiveCodexBinding(sessionId,threadId);
		if (recovery) {
			if (previous.route!=="codex-cli" || previous.resumeId!==recovery.previousThreadId ||
				recovery.threadId!==threadId || !recovery.checkpointTurnId ||
				!this.ctx.get?.("agentCommunity")?.teamOrchestrator?.codexWriterRecoveryScope(sessionId)?.mayFork) {
				throw Error("Codex 恢复时原线程或接话授权已变动");
			}
			this.assertExclusiveCodexBinding(sessionId,recovery.previousThreadId);
		}
		const permission=binding.permission??previous.permission??this.pendingPermissions.get(sessionId);
		const next={...previous,route:"codex-cli",resumeId:threadId,cwd:binding.cwd??previous.cwd??process.cwd(),
			model:binding.model??previous.model??"default",...(permission===void 0?{}:{permission}),updatedAt:new Date().toISOString()};
		if (recovery) next.writerRecoveries=[...(previous.writerRecoveries??[]),{...recovery,at:next.updatedAt}];
		else if (previous.resumeId!==threadId) delete next.writerRecoveries;
		this.state={...this.state,sessions:{...this.state.sessions,[sessionId]:next}};
		try { await this.persist(true); } catch (error) {
			if (this.state.sessions[sessionId]===next) this.state={...this.state,sessions:{...this.state.sessions,[sessionId]:previous}};
			throw error;
		}
		await this.ctx.get?.("agentCommunity")?.teamOrchestrator?.bindCodexThread(binding);
		return {ok:true,sessionId,threadId};
	}
	/** Whether this host can register model routes (A2); independent of discovery. */
	supported() {
		return this.llm() !== void 0;
	}
	/**
	* Synchronous scan used at registration time: PATH + app-bundle candidates only.
	* The login-shell PATH and version probes are filled in by the async scan afterwards.
	*/
	scanSync() {
		const detected = [];
		for (const spec of Object.values(ENGINES)) detected.push(routeView(spec, false, findExecutable(spec.command, spec.appPaths, this.cfg.extraSearchDirs)));
		for (const agent of this.state.custom) detected.push(routeView({
			route: customRoute(agent.id),
			name: agent.name,
			kind: "acp"
		}, true, findExecutable(agent.command, [], this.cfg.extraSearchDirs)));
		this.detected = detected;
		this.scannedAt = (/* @__PURE__ */ new Date()).toISOString();
	}
	async scan() {
		this.detected = await discoverAgents(this.state.custom, this.cfg.extraSearchDirs);
		this.scannedAt = (/* @__PURE__ */ new Date()).toISOString();
		const found = this.detected.filter((entry) => entry.available);
		const summary = found.length === 0 ? "no agent CLI found" : found.map((entry) => `${entry.route}=${entry.path ?? "?"}`).join(", ");
		this.ctx.logger?.info?.(`[local-agent] scan: ${summary}`);
	}
	/** Fill in `--version` for the routes that resolved; display-only, never throws. */
	async probeVersions() {
		this.detected = await Promise.all(this.detected.map(async (entry) => {
			if (!entry.available || entry.path === void 0) return entry;
			const spec = engineOf(entry.route, this.state.custom);
			if (spec === void 0) return entry;
			const version = await probeVersion(entry.path, spec.versionArgs ?? ["--version"], this.cfg.versionProbeTimeoutMs);
			return version === void 0 ? entry : {
				...entry,
				version
			};
		}));
	}
	persist(strict = false) {
		const next = this.state;
		const saved = this.writeQueue.then(() => saveState(this.statePath, next));
		this.writeQueue = saved.catch(error => this.ctx.logger?.warn?.("[local-agent] cannot save state: "+String(error)));
		return strict ? saved : this.writeQueue;
	}
	/** Detached snapshot for the settings page. */
	snapshot() {
		return {
			enabled: this.cfg.enabled,
			supported: this.supported(),
			home: this.home,
			scannedAt: this.scannedAt,
			detected: this.detected.map((entry) => ({ ...entry })),
			custom: this.state.custom.map((agent) => ({
				...agent,
				args: [...agent.args]
			})),
			registeredRoutes: [...this.drivers.keys()]
		};
	}
	/** Re-scan on demand (settings refresh), including version probes. */
	async refresh() {
		if (!this.cfg.enabled) return this.snapshot();
		await this.scan();
		await this.probeVersions();
		this.rebuildRoutes();
		return this.snapshot();
	}
	async addCustomAgent(input) {
		const clean = validateCustomAgent(input);
		const agent = {
			id: newCustomAgentId(),
			...clean
		};
		this.state = {
			...this.state,
			custom: [...this.state.custom, agent]
		};
		await this.persist();
		await this.scan();
		this.rebuildRoutes();
		return this.snapshot();
	}
	async updateCustomAgent(input) {
		const existing = this.state.custom.find((agent) => agent.id === input.id);
		if (existing === void 0) throw new Error(`Unknown local agent: ${input.id}`);
		const clean = validateCustomAgent({
			name: input.name ?? existing.name,
			command: input.command ?? existing.command,
			args: input.args ?? existing.args
		});
		this.state = {
			...this.state,
			custom: this.state.custom.map((agent) => agent.id === input.id ? {
				id: existing.id,
				...clean
			} : agent)
		};
		await this.persist();
		await this.scan();
		this.rebuildRoutes();
		return this.snapshot();
	}
	async removeCustomAgent(input) {
		if (!this.state.custom.some((agent) => agent.id === input.id)) throw new Error(`Unknown local agent: ${input.id}`);
		this.state = {
			...this.state,
			custom: this.state.custom.filter((agent) => agent.id !== input.id)
		};
		await this.persist();
		await this.scan();
		this.rebuildRoutes();
		return this.snapshot();
	}
	/**
	* Register the permission the Bot's session was created with (called by the agent-community
	* session runner right after it applies the permission preset).
	*
	* The value lives on the local-agent session record because the LLM adapter only receives a
	* session id; each driver maps it onto its CLI's own sandbox/permission flags (Codex sandbox,
	* Claude --permission-mode). Unknown/older hosts simply never call this and the CLI keeps its
	* default mode.
	*/
	setSessionPermission(sessionId, permission) {
		const record = this.state.sessions[sessionId];
		if (record === void 0) {
			this.pendingPermissions.set(sessionId, permission);
			return;
		}
		if (record.permission === permission) return;
		this.state = {
			...this.state,
			sessions: {
				...this.state.sessions,
				[sessionId]: {
					...record,
					permission,
					updatedAt: (/* @__PURE__ */ new Date()).toISOString()
				}
			}
		};
		this.persist();
	}
	/** Model ids available to one DSH session (empty before its first turn). */
	async availableModels(sessionId) {
		const record = this.state.sessions[sessionId];
		if (record === void 0) return [];
		const driver = this.drivers.get(record.route);
		if (driver === void 0) return [];
		return (await driver.listModels().catch(() => [])).map((model) => model.id);
	}
	/**
	* Session-scoped model switch, used by the `agent_switch_model` tool.
	*
	* Matching is id → display name → substring, case-insensitive; an unknown request returns the
	* available ids instead of silently sending a bad model to the CLI. The override is stored on
	* the session record (not the Bot), so it survives turns but not a new conversation.
	*/
	async switchModel(sessionId, wanted) {
		const record = this.state.sessions[sessionId];
		if (record === void 0) return {
			ok: false,
			error: "this conversation has no local-agent session yet",
			available: await this.availableModels(sessionId)
		};
		const driver = this.drivers.get(record.route);
		if (driver === void 0) return {
			ok: false,
			error: `no driver registered for route ${record.route}`
		};
		const models = await driver.listModels().catch(() => []);
		const available = models.length === 0 ? ["default"] : models.map((model) => model.id);
		const wantedLower = wanted.toLowerCase();
		const match = models.find((model) => model.id.toLowerCase() === wantedLower) ?? models.find((model) => model.name.toLowerCase() === wantedLower) ?? models.find((model) => model.id.toLowerCase().includes(wantedLower) || model.name.toLowerCase().includes(wantedLower));
		if (match === void 0) return {
			ok: false,
			error: `unknown model: ${wanted}`,
			available
		};
		this.state = {
			...this.state,
			sessions: {
				...this.state.sessions,
				[sessionId]: {
					...record,
					modelOverride: match.id,
					updatedAt: (/* @__PURE__ */ new Date()).toISOString()
				}
			}
		};
		this.persist();
		await driver.setModel?.(sessionId, match.id).catch(() => void 0);
		return {
			ok: true,
			model: match.id
		};
	}
	/**
	* Build the route→driver table for everything discovery found, then register or refresh the
	* adapter's routes.
	*
	* IDEMPOTENCE IS LOAD-BEARING. This runs twice at boot (LLM injection, then the deferred
	* scan) and on every settings refresh. Rebuilding the drivers unconditionally replaced the
	* live Codex process mid-turn: the continuation stream then saw a driver with no session,
	* started a SECOND thread/MCP server, and the parked tool call was never resolved
	* (measured 2026-11-10). Drivers are therefore reused unless the executable moved.
	*/
	rebuildRoutes() {
		if (!this.cfg.enabled || !this.supported()) return;
		const wanted = /* @__PURE__ */ new Map();
		for (const entry of this.detected) {
			if (!entry.available || entry.path === void 0) continue;
			const spec = engineOf(entry.route, this.state.custom);
			if (spec === void 0) continue;
			if (spec.kind === "codex" || spec.kind === "acp" || spec.kind === "claude") wanted.set(entry.route, {
				executable: entry.path,
				name: spec.name,
				kind: spec.kind,
				args: spec.args,
				...spec.env === void 0 ? {} : { env: spec.env }
			});
		}
		if (wanted.size === this.drivers.size && [...wanted].every(([route, spec]) => this.driverPaths.get(route) === spec.executable)) {
			this.ensureRegistration([...this.drivers.keys()]);
			return;
		}
		const next = /* @__PURE__ */ new Map();
		for (const [route, spec] of wanted) {
			const existing = this.drivers.get(route);
			if (existing !== void 0 && this.driverPaths.get(route) === spec.executable) {
				next.set(route, existing);
				continue;
			}
			if (existing !== void 0) existing.dispose();
			next.set(route, spec.kind === "acp" ? new AcpDriver({
				route,
				name: spec.name,
				executable: spec.executable,
				args: spec.args,
				...spec.env === void 0 ? {} : { env: spec.env }
			}) : spec.kind === "claude" ? new ClaudeDriver({
				route,
				name: spec.name,
				executable: spec.executable,
				args: spec.args
			}) : new CodexDriver({
				route,
				name: spec.name,
				executable: spec.executable,
				args: spec.args,
				// [BARU-PATCH 2026-11-15] One progress channel for the whole host: the driver is the
				// only component that sees the upstream turn event by event, so it is the one that
				// publishes "still working / tool running / compacting / stopping".
				onProgress: (payload) => this.reportCodexProgress(payload),
				onSessionOpened: (binding) => this.persistCodexThreadSession(binding),
				writerRecoveryScopeFor: (sessionId) => this.ctx.get?.("agentCommunity")?.teamOrchestrator?.codexWriterRecoveryScope(sessionId),
				prepareWriterRecovery: (sessionId) => this.ctx.get?.("agentCommunity")?.teamOrchestrator?.prepareCodexWriterRecovery(sessionId),
				contextPolicyFor: (sessionId) => this.ctx.get?.("agentCommunity")?.contextPolicyForSession?.(sessionId)
			}));
		}
		for (const [route, driver] of this.drivers) if (!next.has(route)) driver.dispose();
		this.drivers = next;
		this.driverPaths = new Map([...wanted].map(([route, spec]) => [route, spec.executable]));
		this.ensureRegistration([...next.keys()]);
		this.ctx.logger?.info?.(`[local-agent] routes registered: ${[...next.keys()].join(", ") || "(none)"}`);
	}
	/** Register the adapter once; afterwards only replace its route list. */
	ensureRegistration(routes) {
		const llm = this.llm();
		if (llm === void 0) {
			this.ctx.logger?.warn?.("[local-agent] this host cannot register model routes; discovery only");
			return;
		}
		if (this.registration === void 0) {
			if (routes.length === 0) return;
			this.adapter = new LocalAgentAdapter(this.adapterDeps());
			this.registration = llm.registerAdapter(routes, this.adapter);
			return;
		}
		this.registration.replace(routes);
	}
	adapterDeps() {
		return {
			driverFor: (route) => this.drivers.get(route),
			specFor: (route) => engineOf(route, this.state.custom),
			recordFor: (sessionId) => this.state.sessions[sessionId],
			dispatchForSession: (sessionId) => this.ctx.get?.("agentCommunity")?.executor?.codexDispatchForSession(sessionId),
      taskPromptFor: (sessionId,dispatchId) => this.ctx.get?.("agentCommunity")?.state.runs.find(run=>
        run.sessionId===sessionId && run.dispatchId===dispatchId && run.teamTaskId && run.status==="running")?.prompt,
			saveRecord: (sessionId, record) => {
				const previous = this.state.sessions[sessionId];
				const permission = record.permission ?? previous?.permission ?? this.pendingPermissions.get(sessionId);
				if (record.route==="codex-cli" && this.codexWriterRecoveryFrom(sessionId,record.resumeId,previous?.resumeId)) return;
				const next = {...record,...permission===void 0?{}:{permission}};
				if (record.route==="codex-cli" && record.resumeId===previous?.resumeId && previous?.writerRecoveries) {
					next.writerRecoveries=previous.writerRecoveries;
				}
				this.state = {
					...this.state,
					sessions: {
						...this.state.sessions,
						[sessionId]: next
					}
				};
				this.persist();
			},
			permissionFor: (sessionId) => this.state.sessions[sessionId]?.permission ?? this.pendingPermissions.get(sessionId),
			cwdFor: () => process.cwd(),
			toolsBridge: this.cfg.toolsBridge
		};
	}
	async dispose() {
		for (const dispose of this.toolsDisposers.splice(0)) try {
			dispose();
		} catch {}
		this.registration?.();
		this.registration = void 0;
		await this.adapter?.dispose();
		this.adapter = void 0;
		for (const driver of this.drivers.values()) await driver.dispose();
		this.drivers = /* @__PURE__ */ new Map();
	}
};
for (const method of REMOTE_METHODS) markRemote(LocalAgentService.prototype, method);
/**
* Register one Remote method marker without decorator syntax.
*
* tsdown/rolldown passes TC39 decorators through unchanged and Node cannot parse decorator
* syntax at runtime, so `@Remote` is unusable here. This is the same workaround the
* agent-community service documents; the fabricated context only has to satisfy the
* decorator contract.
*/
function markRemote(prototype, method) {
	const fn = prototype[method];
	if (typeof fn !== "function") throw new TypeError(`local-agent: no method ${method}`);
	Remote(fn, {
		kind: "method",
		name: method,
		static: false,
		private: false,
		addInitializer(init) {
			init.call(Object.create(prototype));
		}
	});
}
//#endregion
export { Config, ENGINES, LocalAgentService, LocalAgentService as default, customRoute, discoverAgents, engineOf, isLocalAgentRoute, resolveLocalAgentHome, validateCustomAgent };

