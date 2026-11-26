import { AddCustomAgentInput, Config as Config$1, CustomAgent, LocalAgentEngineSpec, LocalAgentKind, LocalAgentRouteView, LocalAgentSessionRecord, LocalAgentSnapshot, RemoveCustomAgentInput, UpdateCustomAgentInput } from "./types.js";
import { TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import z from "@deepseek-ai/schemastery";
import { Context } from "@deepseek-ai/cordis";
//#region src/engines.d.ts
/**
 * Known agent CLIs.
 *
 * `args` are the args the DRIVER passes when starting the agent (A2/A6); the discovery layer
 * only needs `command`, `appPaths` and `versionArgs`.
 */
declare const ENGINES: Readonly<Record<string, LocalAgentEngineSpec>>;
/** Route id for a custom agent. */
declare function customRoute(id: string): string;
/**
 * Resolve one route to its engine spec, built-in or custom.
 *
 * @param route - a built-in route id or `acp-<custom id>`.
 * @param custom - the stored custom agents.
 * @returns the spec, or undefined when the route is not one this plugin owns.
 */
declare function engineOf(route: string, custom: readonly CustomAgent[]): LocalAgentEngineSpec | undefined;
/** Whether the route belongs to this feature. */
declare function isLocalAgentRoute(route: string, custom: readonly CustomAgent[]): boolean;
/** What `validateCustomAgent` returns: trimmed, safe for `spawn` without a shell. */
interface NormalizedCustomAgent {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
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
declare function validateCustomAgent(input: {
  readonly name?: unknown;
  readonly command?: unknown;
  readonly args?: unknown;
}): NormalizedCustomAgent;
//#endregion
//#region src/index.d.ts
/** Plugin config schema; every new knob is documented on the interface in types.ts. */
declare const Config: z<Config$1>;
/**
 * Where `local-agent/state.json` lives.
 *
 * Same precedence as the community board: explicit config, then the harness home, then the
 * default. An isolated `$DSH_HOME` must stay isolated.
 */
declare function resolveLocalAgentHome(configured?: string): string;
/**
 * Scan every built-in route plus the custom agents.
 *
 * Pure discovery: no state is written, no process is started. Exported so tests and the
 * spike harness can verify discovery without booting the service.
 */
declare function discoverAgents(custom: readonly CustomAgent[], extraSearchDirs?: readonly string[]): Promise<LocalAgentRouteView[]>;
/** Host service: discovery + custom agents + settings RPC. */
declare class LocalAgentService extends TypertRemoteService {
  /** A2/A6 need `llm`; declaring it here keeps activation honest (no half-mounted service). */
  static inject: readonly ["llm"];
  static Config: z<Config$1>;
  private readonly cfg;
  private readonly home;
  private readonly statePath;
  private state;
  private detected;
  private scannedAt;
  private writeQueue;
  /** Driver per registered route (currently Codex only; ACP/Claude add entries later). */
  private drivers;
  /** Executable each driver was created for, so a rescan can tell "unchanged" from "moved". */
  private driverPaths;
  private adapter;
  private registration;
  /** Host approval service, captured when present; absent means every agent approval is denied. */
  private approvalService;
  private readonly toolsDisposers;
  /** Permission reported by the Bot's session runner before the first turn of a session. */
  private readonly pendingPermissions;
  /** Resolved when Cordis injects the host's LLM registry (absent on hosts that cannot route). */
  private llmService;
  constructor(ctx: Context, config?: Config$1);
  private initialize;
  /** The host LLM registry, or undefined on a host that cannot register routes. */
  private llm;
  /** Whether this host can register model routes (A2); independent of discovery. */
  private supported;
  /**
   * Synchronous scan used at registration time: PATH + app-bundle candidates only.
   * The login-shell PATH and version probes are filled in by the async scan afterwards.
   */
  private scanSync;
  private scan;
  /** Fill in `--version` for the routes that resolved; display-only, never throws. */
  private probeVersions;
  private persist;
  /** Detached snapshot for the settings page. */
  snapshot(): LocalAgentSnapshot;
  /** Re-scan on demand (settings refresh), including version probes. */
  refresh(): Promise<LocalAgentSnapshot>;
  addCustomAgent(input: AddCustomAgentInput): Promise<LocalAgentSnapshot>;
  updateCustomAgent(input: UpdateCustomAgentInput): Promise<LocalAgentSnapshot>;
  removeCustomAgent(input: RemoveCustomAgentInput): Promise<LocalAgentSnapshot>;
  /**
   * Register the permission the Bot's session was created with (called by the agent-community
   * session runner right after it applies the permission preset).
   *
   * The value lives on the local-agent session record because the LLM adapter only receives a
   * session id; each driver maps it onto its CLI's own sandbox/permission flags (Codex sandbox,
   * Claude --permission-mode). Unknown/older hosts simply never call this and the CLI keeps its
   * default mode.
   */
  setSessionPermission(sessionId: string, permission: 'read-only' | 'workspace-write' | 'full-access'): void;
  /** Model ids available to one DSH session (empty before its first turn). */
  availableModels(sessionId: string): Promise<readonly string[]>;
  /**
   * Session-scoped model switch, used by the `agent_switch_model` tool.
   *
   * Matching is id → display name → substring, case-insensitive; an unknown request returns the
   * available ids instead of silently sending a bad model to the CLI. The override is stored on
   * the session record (not the Bot), so it survives turns but not a new conversation.
   */
  switchModel(sessionId: string, wanted: string): Promise<{
    ok: boolean;
    model?: string;
    available?: readonly string[];
    error?: string;
  }>;
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
  private rebuildRoutes;
  /** Register the adapter once; afterwards only replace its route list. */
  private ensureRegistration;
  private adapterDeps;
  dispose(): Promise<void>;
}
//#endregion
export { type AddCustomAgentInput, Config, type CustomAgent, ENGINES, type LocalAgentEngineSpec, type LocalAgentKind, type LocalAgentRouteView, LocalAgentService, LocalAgentService as default, type LocalAgentSessionRecord, type LocalAgentSnapshot, type RemoveCustomAgentInput, type UpdateCustomAgentInput, customRoute, discoverAgents, engineOf, isLocalAgentRoute, resolveLocalAgentHome, validateCustomAgent };