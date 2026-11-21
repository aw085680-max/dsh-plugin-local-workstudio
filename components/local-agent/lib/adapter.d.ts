import { LocalAgentEngineSpec, LocalAgentSessionRecord } from "./types.js";
import { GenerateOptions, LlmAdapter, LlmImageRequestPricing, LlmModelInfo, LlmResolvedModelInfo, StreamChunk, TokenUsage } from "@deepseek-ai/dsh-llm";
//#region src/drivers/types.d.ts
/** One model a driver reports. `default` means "whatever the CLI is configured to use". */
interface DriverModel {
  readonly id: string;
  readonly name: string;
}
/** One bridged DSH tool, in the shape an MCP `tools/list` returns. */
interface DriverMcpTool {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
}
/** A resolved DSH tool call handed back to the waiting agent. */
interface DriverToolResult {
  readonly callId: string;
  readonly text: string;
  readonly isError: boolean;
}
/** What one turn needs from the driver. */
interface DriverStreamInput {
  /** DSH Session id — the driver keys its own conversation mapping by it. */
  readonly sessionId: string;
  /** The text to hand the agent. Contains conversation content only, never a system prompt. */
  readonly prompt: string;
  /** Session working directory. */
  readonly cwd: string;
  /** Explicit model id, or undefined for the CLI's configured default. */
  readonly model?: string | undefined;
  /** Bot permission, mapped by each driver onto its CLI's sandbox/permission mode. */
  readonly permission?: 'read-only' | 'workspace-write' | 'full-access' | undefined;
  /** CLI-side session/thread to resume, when a previous turn established one. */
  readonly resumeId?: string | undefined;
  /** Tools to expose over loopback MCP for this turn (empty/absent disables the bridge). */
  readonly mcp?: {
    readonly tools: readonly DriverMcpTool[];
  } | undefined;
  /** Results for bridged calls the previous stream parked; this continues the same turn. */
  readonly toolResults?: readonly DriverToolResult[] | undefined;
  readonly signal?: AbortSignal | undefined;
}
/** Normalized driver events. The adapter is the only consumer. */
type AgentEvent = {
  readonly type: 'thread';
  readonly threadId: string;
} | {
  readonly type: 'text';
  readonly text: string;
} | {
  readonly type: 'thought';
  readonly text: string;
} | {
  readonly type: 'activity';
  readonly text: string;
} | {
  readonly type: 'usage';
  readonly usage: TokenUsage;
} |
/** The agent invoked a bridged DSH tool; the stream stops here until the host resolves it. */
{
  readonly type: 'tool-call';
  readonly callId: string;
  readonly name: string;
  readonly arguments: Record<string, unknown>;
} | {
  readonly type: 'done';
  readonly reason?: string;
} | {
  readonly type: 'error';
  readonly error: Error;
} |
/**
 * A permission prompt (ACP/Claude). A3 has no approval bridge yet; the adapter renders it
 * as an activity line so the turn never hangs waiting for a UI that is not mounted.
 */
{
  readonly type: 'permission';
  readonly action: string;
  readonly detail?: string | undefined;
};
/** One engine family, in the shape the adapter consumes. */
interface LocalAgentDriver {
  readonly route: string;
  stream(input: DriverStreamInput): AsyncIterable<AgentEvent>;
  listModels(): Promise<readonly DriverModel[]>;
  /** Drop this conversation's CLI-side state so the next turn starts a fresh thread. */
  resetSession?(sessionId: string): void | Promise<void>;
  dispose(): Promise<void>;
}
//#endregion
//#region src/adapter.d.ts
/** Everything the adapter needs from the host service. */
interface LocalAgentAdapterDeps {
  readonly driverFor: (route: string) => LocalAgentDriver | undefined;
  readonly specFor: (route: string) => LocalAgentEngineSpec | undefined;
  readonly recordFor: (sessionId: string) => LocalAgentSessionRecord | undefined;
  readonly saveRecord: (sessionId: string, record: LocalAgentSessionRecord) => void;
  readonly cwdFor: (sessionId: string) => string;
  /** Bot permission for this session, mapped by drivers onto their CLI's sandbox/permission mode. */
  readonly permissionFor: (sessionId: string) => 'read-only' | 'workspace-write' | 'full-access' | undefined;
  /** Config switch: expose the collaboration tools to the agent over loopback MCP. */
  readonly toolsBridge: boolean;
}
/** What one request contributes as prompt text. */
interface BuiltPrompt {
  readonly prompt: string;
  readonly lastMessageId: string | undefined;
  readonly systemDropped: boolean;
}
/** The adapter. One instance serves every registered route. */
declare class LocalAgentAdapter extends LlmAdapter {
  private readonly deps;
  /** Test-visible counters: assertions about "no persona" read this instead of trusting prose. */
  readonly stats: {
    systemDropped: number;
    turns: number;
  };
  private disposed;
  /** Bridged calls parked by a previous stream, awaiting their DSH tool results. */
  private readonly pendingCalls;
  constructor(deps: LocalAgentAdapterDeps);
  providerInfo(provider: string): {
    id: string;
    name: string;
  };
  providerRetryPolicy(): undefined;
  imageRequestPricing(): LlmImageRequestPricing | undefined;
  imageRequestTarget(_provider: string, _model: string, image: {
    width: number;
    height: number;
    bytes: number;
  }): {
    width: number;
    height: number;
    maxBytes: number;
  };
  listModels(provider: string): Promise<readonly LlmModelInfo[]>;
  resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo>;
  prepareCall(provider: string, model: string): Promise<{
    model: LlmResolvedModelInfo;
    stream: (options: GenerateOptions) => AsyncIterable<StreamChunk>;
  }>;
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
  dispose(): Promise<void>;
  /** Results for bridged calls parked by a previous stream (consumed once). */
  private takeToolResults;
  /** Build prompt text from the request, dropping every injected, non-conversation kind. */
  buildPrompt(options: GenerateOptions, record: LocalAgentSessionRecord | undefined): BuiltPrompt;
  private streamFor;
}
//#endregion
export { LocalAgentAdapter, LocalAgentAdapterDeps };