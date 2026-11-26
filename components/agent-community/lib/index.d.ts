type DeliverableAddress = {roomId: string} & (
  {runId: string; index: number} | {reminderKey: string; fileId: string; runId?: string}
);
import { $ as FinishEvidence, $t as RunRetryPolicy, A as BotSkillProfile, At as RunFaultSide, B as ConfirmGroupRequest, Bt as SubmitFinalRequest, C as BotRoomId, Ct as RoomGoal, D as BotRun, Dt as RoomTaskAssignment, E as BotRoomSpeculation, Et as RoomPatternRequest, F as BotTeamMembership, Ft as ScopedMemoryView, G as DeclineGroupRequest, Gt as ThreadSubscription, H as CreateBotRequest, Ht as TeamApprovalAnswer, I as BotTeamMessageKind, It as SendRoomMessageAttachment, J as DeleteRoomMemoryRequest, Jt as UpdateBotRequest, K as DecomposeTasksRequest, Kt as ThreadSubscriptionAuthority, L as BotTeamRunOrigin, Lt as SendRoomMessageRequest, M as BotTaskStatus, Mt as ScopedMemoryEntryView, N as BotTeam, Nt as ScopedMemoryJournalRow, O as BotRunId, Ot as RoomTaskState, P as BotTeamLeader, Pt as ScopedMemoryScopeName, Q as DismissTeamRequest, Qt as UpdateScopedMemoryRequest, R as CompactExperienceRequest, Rt as SettleBotRunRequest, S as BotRoomAssessment, St as RoomExperienceCard, T as BotRoomPolicy, Tt as RoomMemoryView, U as CreateRoomRequest, Ut as TeamMessageResult, V as ControlBotRunRequest, Vt as TeamApproval, W as CreateTeamRequest, Wt as TeamOverview, X as DeleteScopedMemoryRequest, Xt as UpdateRoomMemoryRequest, Y as DeleteRoomRequest, Yt as UpdateRoomExperienceRequest, Z as DeliveredFile, Zt as UpdateRoomRequest, _ as BotMessageUsage, _t as RemoveBotsRequest, a as BotAvatar, at as ListScopedMemoryRequest, b as BotRoom, bt as RevertRoomMemoryRequest, c as BotId, ct as NoticeRoomRequest, d as BotMemoryEntry, dt as OpenWorkRoom, en as RunTimeoutPolicy, et as FinishTaskRequest, f as BotMemoryRecord, ft as OpenWorkView, g as BotMessageSenderKind, gt as ProposeGroupRequest, h as BotMessageId, ht as PostTeamMessageRequest, i as AssignTasksRequest, it as ListRoomMemoryRequest, j as BotTask, jt as RunFinishPath, k as BotRunStatus, kt as RunEvidence, l as BotIdentity, lt as OpenWorkItem, m as BotMessageAttachment, mt as PostBotMessageRequest, n as AdmissionMode, nt as GroupProposal, o as BotCommunitySnapshot, ot as MarkRoomReadRequest, p as BotMessage, pt as PendingGroupProposal, q as DeleteBotRequest, qt as ThreadSubscriptionSource, r as AnswerBotQuestionRequest, rt as HarnessAttribution, s as BotConnectionState, st as MemoryMutationResult, t as AbstainRequest, tt as GroupPatternCard, u as BotMailboxItem, ut as OpenWorkKind, v as BotPresence, vt as ReportTaskRequest, w as BotRoomNotice, wt as RoomGoalAuthorization, x as BotRoomAdmission, xt as RevertScopedMemoryRequest, y as BotProfileBinding, yt as RetryBotRunRequest, z as CompactExperienceResult, zt as SpeculationMode } from "./types-CCMbdGS6.js";
import { TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import z from "@deepseek-ai/schemastery";
import { Context } from "@deepseek-ai/cordis";
import { SessionId } from "@deepseek-ai/dsh-session";
//#region src/visibility.d.ts
interface SessionVisibilityRecord {
  readonly sessionId: SessionId;
  /** null = successfully hidden; string = last error from hide attempt */
  readonly lastError: string | null;
  readonly hiddenAt: string | null;
}
//#endregion
//#region src/intake.d.ts
/**
 * Intake (S1-1) — one normalized event envelope in front of every way a room is driven.
 *
 * WHY THIS EXISTS. A room is driven today by four unrelated paths: a user message (inline in
 * `sendMessage`), an A2A/bot message, a fired reminder (`bot-schedules`) and a goal continuation
 * (`room-goal`). Each one knows a different amount about why it is running, and none of them leaves
 * a trace a human can query: when a bot answers something surprising, the answer is "one of these
 * four started it" with the reason buried in a log line.
 *
 * The Super-agent article's event-driven section starts with the same observation: the input is no
 * longer a prompt a person typed, it is a semi-structured EVENT from the environment. This module
 * is the shared envelope and the program-level (Fast Path) filter for those existing sources.
 *
 * V1 IS OBSERVATION-ONLY (deliberate). It builds the envelope, applies the deterministic filter,
 * stamps the event id onto the runs it created and keeps a bounded in-memory ring that
 * `listRecentEvents` exposes. It does NOT gate behaviour: the four paths still do exactly what they
 * did before, and with `intakeEnabled` off nothing at all changes. Rewriting the delivery pipeline
 * around the envelope is the second half of the plan, and doing it in the same commit as the
 * envelope would trade eleven commits of stabilised behaviour for unverified refactoring.
 *
 * @module
 */
/** Where an event came from. The set is closed on purpose: a new source is a product decision. */
type RoomEventKind = 'user-message' | 'a2a-message' | 'schedule-due' | 'goal-continuation' | 'system';
/** Who/what produced the event. `id` is a bot id for `bot`, otherwise opaque. */
interface RoomEventActor {
  readonly kind: 'user' | 'bot' | 'schedule' | 'system';
  readonly id?: string | undefined;
  readonly name?: string | undefined;
}
/** What the event carries. Text is stored clipped (a trace, not a second transcript). */
interface RoomEventPayload {
  readonly text?: string | undefined;
  readonly botId?: string | undefined;
  readonly scheduleId?: string | undefined;
  readonly goalId?: string | undefined;
}
/** The program-level filter's verdict, kept on the event so the trace explains itself. */
interface RoomEventDecision {
  readonly accept: boolean;
  readonly reason: string;
}
interface RoomEvent {
  /** C12: the run this event produced (filled by the service view; absent while still routing). */
  readonly runId?: string | undefined;
  readonly id: string;
  readonly kind: RoomEventKind;
  readonly roomId: string;
  /** Epoch millis. */
  readonly at: number;
  readonly actor: RoomEventActor;
  readonly payload: RoomEventPayload;
  readonly threadId?: string | undefined;
  readonly taskId?: string | undefined;
  readonly decision: RoomEventDecision;
}
//#endregion
//#region src/batching.d.ts
/**
 * Message batching (S0-5) — merge a burst of user messages into the ONE run that is still
 * waiting to start.
 *
 * WHY THIS EXISTS. A person types two or three lines instead of one. Today each line routes
 * independently and creates its own run, so the same bot answers the same request several times
 * and pays for several full prompts; the Super-agent article's router avoids this by batching the
 * triggers that arrived while it was busy. This module is the deterministic half of that idea for
 * a room: given the open batch for one `(room, bot)` pair, decide whether the next user message
 * may be folded into the waiting run instead of opening another one.
 *
 * WHAT MAY MERGE (all must hold):
 *   · batching is enabled for the deployment;
 *   · an open batch exists and its run is still `queued` (never a running or settled run — folding
 *     into a turn the model already started would produce an answer to a prompt nobody read);
 *   · the new message arrives within the window of the LAST merge, and the batch holds fewer
 *     messages than the cap;
 *   · the new message belongs to the SAME thread/task key, so two unrelated instructions in the
 *     same room are never silently combined.
 *
 * The service only merges when EVERY target of the message is batchable; a partially merged
 * instruction would leave one bot answering a combined prompt and another answering half of it.
 * That decision is made by the caller from per-target {@link mergeBatch} results.
 *
 * @module
 */
/** Deployment-level batching settings; `enabled` is false until the feature is validated. */
interface BatchingConfig {
  readonly enabled: boolean;
  /** How long after the last merge another message may still join (milliseconds). */
  readonly windowMs: number;
  /** Most messages one batch holds; the next one opens a fresh run. */
  readonly maxMessages: number;
}
//#endregion
//#region src/health.d.ts
/**
 * Subsystem health (S0-7) — the notification rule, not the logging.
 *
 * WHY THIS EXISTS. A room can be quietly broken while every individual failure looks handled:
 * routing throws and is caught, prompt assembly degrades, a schedule's delivery fails, memory
 * writes are logged and retried. Each site already logs once; nobody aggregates. The article's
 * Watchdog section makes the point that process liveness is not enough — a subsystem that fails
 * three times in a row is a real signal, and one that succeeded again is not.
 *
 * WHAT IT IS. A pure record/level/notify policy over `(subsystem, outcome)` pairs:
 *   · consecutive failures accumulate, any success resets them to zero;
 *   · `warning` at 1–2 failures, `error` from the threshold (default 3) up;
 *   · only an `error` produces a notice, at most once per cooldown window (default 10 min),
 *     so a broken subsystem explains itself once instead of flooding the room.
 *
 * WHAT IT IS NOT. It does not catch, retry or repair anything — callers keep their own failure
 * handling. It stores no message text beyond the first line of the error (which is already shown
 * in the room's diagnosis row) and never enters prompts.
 *
 * LIFETIME. The rolling record lives in the service's memory only: a plugin reload / host restart
 * clears the streak and the notice cooldown, so a subsystem that keeps failing starts counting
 * again. That is deliberate — this is a live-process health signal, not a durable audit log (the
 * room notices it already wrote are durable; see `BotRoom.notices`).
 *
 * @module
 */
type HealthLevel = 'ok' | 'warning' | 'error';
/** One subsystem's rolling state. Timestamps are milliseconds; absent means "never". */
interface HealthRecord {
  readonly subsystem: string;
  readonly consecutiveFailures: number;
  /** First line of the latest error, clipped — enough to recognise it, never a prompt. */
  readonly lastError?: string | undefined;
  readonly lastFailureAt?: number | undefined;
  readonly lastOkAt?: number | undefined;
  /** When the last ERROR notice was written, for the cooldown. */
  readonly lastNotifiedAt?: number | undefined;
}
/** What `getHealth` returns: one plain snapshot per subsystem, worst first. */
interface HealthSnapshot {
  readonly subsystem: string;
  readonly level: HealthLevel;
  readonly consecutiveFailures: number;
  readonly lastError?: string | undefined;
  readonly lastFailureAt?: string | undefined;
  readonly lastOkAt?: string | undefined;
}
/** Snapshots sorted worst-first, then by name, so a diagnostic list leads with what matters. */
declare function healthSnapshots(records: Iterable<HealthRecord>, threshold?: number): HealthSnapshot[];
//#endregion
//#region src/presence.d.ts
/**
 * Member presence — what a leader needs to know before it dispatches work.
 *
 * WHY THIS EXISTS. `assign_task` wakes a member whether or not that member is already busy, and
 * the leader had no way to see the difference: the roster in its prompt says who EXISTS, not who
 * is mid-turn, queued, blocked on a user approval or waiting for a peer. The result was visible
 * in real rooms — two tasks handed to the same busy member, a leader re-assigning work to the bot
 * it just woke. Presence is derived state (runs + approvals + assignments + mailbox), never a
 * stored flag, so it cannot drift from the runs the panel already shows.
 *
 * PURE: the service collects the raw facts and this module decides the ONE state a member is in,
 * so the ordering rule (working beats queued beats waiting beats idle) is testable without a host.
 *
 * @module
 */
/** The one state a room member is in, in decreasing order of "do not give it more work". */
type MemberPresenceState = 'working' | 'queued' | 'waiting-approval' | 'waiting-other' | 'idle';
/** One member as the list_bots tool reports it. */
interface MemberPresenceView {
  readonly botId: string;
  readonly name: string;
  readonly state: MemberPresenceState;
  /** Chinese label for the transcript/tool rendering. */
  readonly label: string;
  readonly pendingApprovals: number;
  readonly mailboxPending: number;
  readonly assignment?: {
    readonly status: string;
    readonly task: string;
  } | undefined;
}
//#endregion
//#region src/ledger.d.ts
interface LedgerEntryBase {
  readonly id: string;
  readonly roomId: BotRoomId;
  readonly at: string;
  readonly sequence: number;
  /**
   * Bumped on every in-place update. `sequence` stays put for an entry's whole
   * life, so a client that already fetched an entry cannot detect later edits
   * (streaming text, `streaming: false`) from the sequence alone.
   */
  readonly rev: number;
  /**
   * Global change counter — bumped by EVERY `push` and EVERY `patch` in this projector.
   *
   * `rev` says "this ROW changed"; it cannot say "something changed SINCE you polled".
   * The incremental poll used to be keyed on `sequence`, and a patched row keeps its
   * sequence: a reply whose row was reserved at the start of the turn (small sequence)
   * and settled at the end (large change) sat BELOW the client's cursor for ever, so the
   * panel showed the turn's work but never its answer. This is the cursor that moves for
   * the whole room: `changedAfterChangeSeq` compares against it.
   */
  readonly changeSeq: number;
}
interface LedgerUserEntry extends LedgerEntryBase {
  readonly type: 'user';
  readonly text: string;
  readonly senderName: string;
  /**
   * Files the user attached, for the bubble to draw. Passed through from the persisted
   * message on both paths — the live push in `sendMessage` and the rebuild in
   * `seedLedgerRoom` — because the panel renders ONLY the ledger: metadata that lives
   * only on `state.messages` would vanish on the next reload.
   */
  readonly attachments?: readonly BotMessageAttachment[] | undefined;
  /**
   * OP-14 threading/task linkage, passed through from the persisted message on both paths (live
   * push and restart rebuild). Optional and additive: a reader that does not render threads
   * ignores it, and older rows simply lack it.
   */
  readonly replyTo?: string | undefined;
  readonly threadId?: string | undefined;
  readonly taskId?: string | undefined;
  /**
   * The persisted message id this row draws, when the host knows it.
   *
   * The panel and `copyBot` live in two different id spaces: a live user row gets a random
   * ledger id while the message it represents has its own id, so passing the ledger id to
   * the fork RPC was answered with `Message "…" not found`. The host stamps this on every
   * user row (seed rows already use the message id as their row id) and
   * `resolveForkCutId` accepts either form. Optional and additive: old rows simply lack it
   * and the resolver falls back to the room's newest user message.
   */
  readonly messageId?: string | undefined;
}
interface LedgerBotTextEntry extends LedgerEntryBase {
  readonly type: 'bot-text';
  readonly botId: BotId;
  readonly botName: string;
  readonly runId?: BotRunId | undefined;
  readonly text: string;
  /**
   * Wall-clock duration of the run that produced this row, so the panel can render
   * the native "已完成，用时 …" footer without a reload. Only the persisted message
   * carried it before, which is why a freshly finished turn showed no duration
   * until DSH restarted and re-seeded the ledger from state.
   */
  readonly durationMs?: number | undefined;
  readonly usage?: {
    readonly inputTokens?: number | undefined;
    readonly uncachedInputTokens?: number | undefined;
    readonly outputTokens?: number | undefined;
    readonly totalTokens?: number | undefined;
    readonly cacheReadTokens?: number | undefined;
    readonly cacheWriteTokens?: number | undefined;
  } | undefined;
  /** true while the turn is still streaming */
  readonly streaming: boolean;
  /** OP-14 threading/task linkage carried by the reply (absent when it had none). */
  readonly replyTo?: string | undefined;
  readonly threadId?: string | undefined;
  readonly taskId?: string | undefined;
  /**
   * The persisted BotMessage id this row draws, when the host knows it.
   *
   * Same reason as the user row's field: a live `bot-text` row's ledger id is
   * `run:<runId>:bot-text`, which names no message, so a reply aimed at that row was answered
   * with silence (the host validates `replyTo` against real message ids and drops what it cannot
   * find). The host stamps this when the delivered message exists; the panel prefers it over
   * the row id, and the restart rebuild keeps using the message id as the row id anyway.
   */
  readonly messageId?: string | undefined;
}
interface LedgerBotReasoningEntry extends LedgerEntryBase {
  readonly type: 'bot-reasoning';
  readonly botId: BotId;
  readonly botName: string;
  /** Turn identity: keeps reasoning in the same rendered turn as its answer. */
  readonly runId?: BotRunId | undefined;
  readonly text: string;
}
interface LedgerToolCallEntry extends LedgerEntryBase {
  readonly type: 'tool-call';
  readonly botId: BotId;
  readonly botName: string;
  /** Turn identity: keeps tool cards inside the turn that issued them. */
  readonly runId?: BotRunId | undefined;
  readonly callId: string;
  readonly name: string;
  readonly args: string;
}
interface LedgerToolResultEntry extends LedgerEntryBase {
  readonly type: 'tool-result';
  readonly botId: BotId;
  readonly botName: string;
  readonly runId?: BotRunId | undefined;
  readonly callId: string;
  readonly ok: boolean;
  readonly output: string;
}
/**
 * Files a turn declared as deliverables for the user.
 *
 * One row per turn, not one per file: the card group renders after the reply, so a
 * second row for the same turn would render as a second, disconnected card stack.
 * Repeated declarations in one turn merge into this row's `files`.
 */
interface LedgerDeliverableEntry extends LedgerEntryBase {
  readonly type: 'deliverable';
  readonly botId: BotId;
  readonly botName: string;
  /** Turn identity: the card group belongs to this reply. */
  readonly runId: BotRunId;
  readonly files: readonly DeliveredFile[];
}
interface LedgerApprovalEntry extends LedgerEntryBase {
  readonly type: 'approval';
  readonly botId: BotId;
  readonly botName: string;
  readonly callId: string;
  readonly toolName: string;
  readonly args: string;
  readonly outcome?: 'allowed-once' | 'rejected' | undefined;
  /**
   * OP-06 (approval–execution binding) — optional and additive.
   *
   * The host's approval request carries no arguments; the bridge captures them at
   * `tools/pre-execute` and records this fingerprint so a reader can tell that the grant described
   * a concrete call rather than only a tool name. Rows written before the binding existed, and
   * rows whose arguments the host never exposed, simply omit these fields.
   */
  readonly argsHash?: string | undefined;
  /** `verified-args` when the grant was bound to captured arguments; `args-unavailable` otherwise. */
  readonly binding?: 'verified-args' | 'args-unavailable' | undefined;
  /** When the binding stops being executable (ISO 8601). */
  readonly expiresAt?: string | undefined;
}
/**
 * A question a bot asked the user, and the answer once it arrives.
 *
 * Its own row type rather than an `approval`: an approval is a yes/no about a tool call,
 * while a question is a prompt with options the user picks from. Both block the bot's turn
 * until the user acts, which is why both live in the transcript next to the turn that asked.
 */
interface LedgerQuestionEntry extends LedgerEntryBase {
  readonly type: 'question';
  readonly botId: BotId;
  readonly botName: string;
  readonly questionId: string;
  readonly runId?: BotRunId | undefined;
  readonly question: string;
  /** Selectable answers; empty means free text only. */
  readonly options: readonly string[];
  readonly allowFreeText: boolean;
  readonly status: 'pending' | 'answered' | 'skipped' | 'expired';
  readonly answer?: string | undefined;
  readonly answeredAt?: string | undefined;
}
interface LedgerErrorEntry extends LedgerEntryBase {
  readonly type: 'error';
  readonly botId: BotId;
  readonly botName: string;
  readonly message: string;
  readonly code?: string | undefined;
}
interface LedgerDispatchEntry extends LedgerEntryBase {
  readonly type: 'dispatch';
  readonly text: string;
}
/**
 * One row of a group round's lifecycle (P2-1): started / a member PASSed / settled /
 * interrupted by a newer instruction.
 *
 * Kept as its own non-bubble row so the transcript can show "本轮开始：…", "X 跳过本轮",
 * "本轮收口" without pretending a bot said them. `phase` is what the panel keys its styling on;
 * `text` is already the human-readable Chinese line.
 */
interface LedgerRoundEntry extends LedgerEntryBase {
  readonly type: 'round';
  readonly text: string;
  readonly roundId: string;
  readonly phase: 'started' | 'pass' | 'settled' | 'interrupted';
}
type LedgerEntry = LedgerUserEntry | LedgerBotTextEntry | LedgerBotReasoningEntry | LedgerToolCallEntry | LedgerToolResultEntry | LedgerApprovalEntry | LedgerQuestionEntry | LedgerErrorEntry | LedgerDispatchEntry | LedgerDeliverableEntry | LedgerRoundEntry;
//#endregion
//#region src/bot-schedules.d.ts
/** One reminder owned by the plugin. */
interface BotSchedule {
  readonly id: string;
  readonly roomId: BotRoomId;
  readonly botId: BotId;
  readonly title: string;
  readonly prompt: string;
  /** Next fire time, ISO. */
  readonly dueAt: string;
  /** Fixed interval for a repeating reminder; undefined for a one-shot. */
  readonly everySeconds?: number | undefined;
  /** Host reminder this was imported from, for the audit trail and for settling it. */
  readonly hostId?: string | undefined;
  /**
   * The session id the HOST row is bound to, verbatim.
   *
   * It is not recomputable: the binding carries the generation the reminder was created in
   * (`ac:<room>:<bot>:gN`), while `sessionIdFor` returns the room's CURRENT generation. Settling
   * the row with the wrong id would silently fail its lookup, so the exact string is kept.
   */
  readonly hostSessionId?: string | undefined;
  readonly importedAt: string;
  readonly lastFiredAt?: string | undefined;
}
//#endregion
//#region src/skills-profile.d.ts
/** One discovered skill, as the prompt builder and the composer menu consume it. */
interface SkillEntry {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly path: string;
}
//#endregion
//#region src/persistence.d.ts
interface RoomAgentSession {
  readonly roomId: BotRoomId;
  readonly botId: BotId;
  readonly sessionId: SessionId;
}
//#endregion
//#region src/room-goal.d.ts
/** What a Bot's `agent_community_goal` call asks for. */
type BotGoalAction = 'set' | 'resume' | 'pause' | 'done';
//#endregion
//#region src/dispatch.d.ts
/**
 * `dispatch` — handing work to OTHER MEMBERS OF THE ROOM.
 *
 * This is the plugin's answer to "let the bot use something like workflow, without copying
 * DSH's workflow". DSH's `workflow` runs a JavaScript orchestration that spawns child agents
 * INSIDE the caller's session: those children are invisible to the room (no transcript rows,
 * no concurrency accounting, nothing the stop button reaches) and they duplicate the one
 * mechanism a room already has. The user's rule is explicit: workflow should call other BOTS,
 * not create sub-agents.
 *
 * So dispatch is `assign_task`, in bulk, with the waiting handled by the room:
 *
 *   leader calls dispatch → runs are queued for the named members → dispatch returns at once
 *   → the leader's own answer this turn IS the progress report
 *   → when the members settle, the plugin wakes the leader with their reports
 *   → the leader continues (or `finish_task`s)
 *
 * NOTHING BLOCKS. The earlier design had the leader's run wait up to ten minutes, which raced
 * the run timeout (also ten minutes) and lost the summary when the timeout won.
 *
 * @module
 */
/** One piece of work handed to one member. */
interface DispatchTask {
  readonly bot: string;
  readonly task: string;
}
//#endregion
//#region src/context-pressure.d.ts
/** Level thresholds as fractions of the context window; every field is optional. */
interface ContextPressureThresholds {
  /** Where `soft` begins (compaction advisable). Defaults to 0.60. */
  readonly softRatio?: number | undefined;
  /** Where `hard` begins (compaction urgent). Defaults to 0.80. */
  readonly hardRatio?: number | undefined;
  /** Where `overflow` begins (compaction can no longer help). Defaults to 0.95. */
  readonly overflowRatio?: number | undefined;
}
//#endregion
//#region src/compact.d.ts
/** `compactRoom`'s request, as the RPC carries it. */
interface CompactRoomRequest {
  readonly roomId: string;
  /** Newest messages to keep verbatim. Defaults to {@link DEFAULT_KEEP_LAST}, clamped to ≥ {@link MIN_KEEP_LAST}. */
  readonly keepLast?: number | undefined;
}
/** `compactRoom`'s result. A refusal is a normal answer, not an exception. */
interface CompactRoomResult {
  /** True only when the room was actually rewritten. */
  readonly compacted: boolean;
  /** Why nothing happened, when `compacted` is false. Safe to show verbatim. */
  readonly reason?: string | undefined;
  /** How many older messages were replaced by the summary. */
  readonly removed: number;
  /** How many newest messages were kept verbatim. */
  readonly kept: number;
  /** The summary text, for the caller's notice. Absent on a refusal. */
  readonly summary?: string | undefined;
  /**
   * How many stale session ids were retired with the messages.
   *
   * A summary only compresses what the bot carries forward if it can no longer replay
   * the full transcript from its session log, so a successful compaction retires the
   * room's previous session generation (`clearCount`-style) and purges those logs.
   */
  readonly sessionsRetired: number;
}
//#endregion
//#region src/index.d.ts
declare const name = "agent-community";
interface Config {
  readonly maxBots?: number;
  readonly maxRooms?: number;
  readonly maxMessages?: number;
  readonly maxRuns?: number;
  /**
   * Explicit agent-community home — where `agent-community/state.json` lives.
   *
   * Highest precedence. When unset the home is the HARNESS home (`$DSH_HOME`, else
   * `~/.dsh`), so a second runtime started with an isolated `$DSH_HOME` no longer
   * reads and writes the first one's board.
   */
  readonly homeDir?: string;
  /**
   * When false, never adopt an existing board from the legacy `~/.dsh` location if the harness
   * home (`$DSH_HOME`) has no board yet (default true, preserving upgrade behaviour).
   *
   * Set false for throwaway/acceptance instances: it makes "$DSH_HOME is a fresh directory"
   * actually mean "isolated". See `resolveAgentCommunityHome`.
   */
  readonly adoptLegacyBoard?: boolean;
  /** Max runs executing concurrently (default 2). */
  readonly maxConcurrentRuns?: number;
  /**
   * DEPRECATED legacy knob. Kept only so an older deployment patch that sets it still
   * parses; the runtime deadline is ADAPTIVE now (see `runTimeoutPolicy`). Its default is
   * the policy bootstrap, not a hidden 600 s constant.
   */
  readonly runTimeoutMs?: number;
  /**
   * Lease duration in milliseconds (default 60_000). The heartbeat cadence is lease/4, so
   * this one option controls both; it used to be a dead setting with 60 s hardcoded twice.
   */
  readonly runLeaseMs?: number;
  /**
   * Adaptive task-time allowance: the deadline comes from measured run durations, per
   * (bot, origin, task class), never from one hardcoded number. Every field is configurable;
   * defaults live in `run-budget.ts` (bootstrap 15 min, floor 3 min, cap 2 h, p95 × 1.5,
   * no-progress 2 min–30 min, up to 2 × 50 % extensions).
   */
  readonly runTimeoutPolicy?: Partial<RunTimeoutPolicy>;
  /** Retry budget for transient failures: attempts + exponential backoff base. */
  readonly runRetryPolicy?: Partial<RunRetryPolicy>;
  /**
   * How many IDLE bot agents stay materialised (default 12). Past this the
   * least-recently-used one is disposed, which releases its session write lease —
   * so this is the knob that decides when another runtime may open that session.
   */
  readonly idleLimit?: number;
  /** Ceiling on total live agents, running ones included (default 24). */
  readonly hardLimit?: number;
  /**
   * S0-4: reserve ONE extra live-agent slot for a human-initiated run (default true).
   *
   * A user message must not queue behind the bots it woke up. When true, a run whose origin is
   * `user`/`team-user` may keep one more live agent than `hardLimit`; automation keeps the normal
   * ceiling. Set false to restore the pre-S0-4 ceiling for every run.
   */
  readonly humanPriority?: boolean;
  /**
   * S0-5: merge a burst of user messages into the queued run that has not started yet.
   *
   * Default OFF. When enabled, a message arriving within `windowMs` of the previous one, for the
   * same target and the same thread/task, joins that queued run's prompt instead of creating a
   * second run. A run that already started never merges. `maxMessages` caps one batch.
   */
  readonly batching?: Partial<BatchingConfig>;
  /**
   * S1-2: inject a user's follow-up into a run that is ALREADY executing for the same pair and
   * thread/task, instead of queueing a second run behind it. Default OFF: steering changes what a
   * running turn sees, so it ships behind a switch and is validated on an isolated instance first.
   */
  readonly steerEnabled?: boolean;
  /**
   * S1-3: route a message in a known thread/task to the bots that own it instead of re-guessing
   * from the text. Default OFF: it changes who answers a follow-up, so it ships behind a switch.
   */
  readonly threadSubscriptionsEnabled?: boolean;
  /** How long an idle thread subscription stays valid (refreshed while it resolves messages). */
  readonly threadSubscriptionTtlMs?: number;
  /**
   * S1-5: retry fallible host side effects durably (currently settling a fired reminder's host
   * row). Default ON: this is internal reliability, not a new user-facing behaviour. Off falls
   * back to the old fire-and-forget path.
   */
  readonly outboxEnabled?: boolean;
  /**
   * S1-4: on the FIRST turn of a new ASSIGNED task, inject a `[任务段]` boundary plus a handoff
   * built from the previous segment's finish report. Default OFF (it changes prompt bytes and is
   * a new harness: `PROMPT_CONTRACT_VERSION` is bumped to 6).
   */
  readonly taskSegmentsEnabled?: boolean;
  /**
   * S1-1: stamp every run with the intake EVENT that created it and keep a bounded trace
   * (`listRecentEvents`). Observation only — the four drive paths behave exactly as before.
   */
  readonly intakeEnabled?: boolean;
  /**
   * S0-6: stop a Bot from blocking its own turn with sleeps / long foreground commands /
   * long job waits. `observe` (default) only logs; `enforce` refuses the call with a model-readable
   * reason; `off` disables the guard. User sessions are never affected.
   */
  readonly noWaitGuard?: {
    readonly mode?: string | undefined;
    readonly maxForegroundMs?: number | undefined;
    readonly maxJobWaitMs?: number | undefined;
  };
  /**
   * S0-7 subsystem health: consecutive failures that turn a warning into an `error` notice
   * (default 3), and the minimum gap between two notices for one subsystem (default 10 min).
   */
  readonly healthFailureThreshold?: number;
  readonly healthNoticeCooldownMs?: number;
  /**
   * 2026-11-09: how an UNADDRESSED group message is handled when the room has no setting of its
   * own. `legacy` keeps the old routing; `observe` records only; `auto` hands the message to the
   * room leader for triage (it answers or dispatches). Default `legacy`; a deployment can set
   * this to `auto` without touching every room.
   */
  readonly admissionDefault?: string;
  /** Number of recent room messages to include in each Bot prompt (default 10). */
  readonly historyMessagesInPrompt?: number;
  /**
   * S2-2: chain-of-recall. When true, the history window leaves a short id-stub for old messages
   * instead of dropping them, the prompt gains a `[更早内容与引用]` section, and every bot gets the
   * three read-only tools (`agent_community_read_history/read_run/read_task`). Default false: the
   * prompt bytes, tool catalog and window are unchanged.
   */
  readonly recallEnabled?: boolean;
  /** Characters a history stub keeps (default 50). */
  readonly recallStubChars?: number;
  /** Max stubs kept per window (default 40). */
  readonly recallMaxStubs?: number;
  /**
   * S2-4: the deployment-wide default for rooms whose own `speculation` is absent.
   * Product default is `off`; a deployment can switch all rooms to `observe`/`on` here,
   * with the same hard daily budget bound (default/ceiling 100).
   */
  readonly speculationDefault?: {
    readonly mode?: string;
    readonly dailyLimit?: number;
  } | undefined;
  /**
   * @deprecated NOT READ BY ANY CODE (verified across the package): a2a chattiness is bounded
   * by the one-hop rule instead — a bot answering a peer message never starts another run
   * (see `postBotMessage`). Kept only so existing config files and the schema keep parsing;
   * removing it is a separate, user-visible config change.
   */
  readonly a2aMinIntervalMs?: number;
  /**
   * How long the user has to answer a group proposal before it counts as a refusal
   * (§5.4 timeout = decline). Defaults to the panel dialog's own two minutes so the
   * two deadlines agree; this one is the backstop for a closed panel.
   */
  readonly groupProposalTimeoutMs?: number;
  /**
   * How long one of a Bot's approval dialogs may stay open before it is rejected automatically.
   *
   * A Bot session is a hidden `subagent` session, so an unanswered dialog is a hung turn rather
   * than a waiting one. The executor's own watchdog runs this value plus a grace period later,
   * so it only catches requests the bridge never claimed. `0` disables BOTH watchdogs and waits
   * forever (the pre-watchdog behaviour) — the grace period must not turn `0` into "15 s".
   */
  readonly approvalTimeoutMs?: number;
  /**
   * P3-3 guardrails: deterministic checks on a bot turn's INPUT (the task text) and OUTPUT
   * (the reply + tool names). Each entry is `{type:'maxChars'|'mustInclude'|'forbiddenTerms'|
   * 'toolAllowlist', action?:'repair'|'block', ...}`; invalid entries are skipped with a warning
   * at startup. Absent/empty installs NO rule and leaves the turn path unchanged.
   */
  readonly guardrails?: readonly unknown[];
  /**
   * P5-1 conservative context guard (default DISABLED = zero behaviour change).
   *
   * When enabled, after a bot turn settles the plugin samples the host's context pressure
   * for that bot's session; hard/overflow puts ONE grey notice in the room (rate-limited),
   * and with `autoCompact` it also asks the host to compact the session. Absent host
   * services (sessions/tokenMeter/compaction) degrade to nothing — never an error.
   */
  readonly contextGuard?: {
    readonly enabled?: boolean;
    readonly autoCompact?: boolean;
    readonly notifyCooldownMs?: number;
    readonly thresholds?: ContextPressureThresholds;
  };
  /**
   * Where DSH keeps its session logs. Defaults to `<home>/sessions` — the same
   * `~/.dsh/sessions` the runtime uses. Overridable so a test can exercise the
   * deletion and sweep paths without touching the user's real session store.
   */
  readonly sessionsDir?: string;
  /**
   * Default reasoning effort for bot model calls when a bot sets none.
   *
   * `''` (the default) means "whatever the provider/model defaults to", which is the only
   * value that is safe on every route: a model that publishes NO reasoning levels rejects any
   * explicit level before the request leaves the process (UNSUPPORTED_REASONING_EFFORT), so a
   * non-empty default here makes every bot turn fail on such a deployment. A provider that
   * does publish levels honours what each bot sets for itself (see the bot settings form).
   */
  readonly botReasoningEffort?: string;
  /** Agent preset for bot sessions (default `standard`). */
  readonly botAgentPreset?: string;
  /**
   * S2-1: the preset mounted for Bots whose stored role is `coordinator`.
   *
   * Defaults to `coordinator` (the bundle ships that preset row). A deployment that mounts its
   * own coordinator preset can rename it here; bots whose role is absent/`bot` keep using
   * `botAgentPreset`, so this field alone changes nothing.
   */
  readonly coordinatorAgentPreset?: string;
  /** Global tools bot sessions must never see (default `['plugin_manager']`). */
  readonly botDeniedTools?: string[];
  /** Maximum files one `agent_community_deliver` call may declare (DSH present uses 8). */
  readonly deliverMaxFiles?: number;
  /**
   * How many remembered entries one (room, bot) pair keeps, newest kept (default 12).
   *
   * Every finished turn adds one line, so this is what bounds the board and the rendered prompt
   * block. Set to 0 to keep bots from remembering anything automatically — an explicit
   * `agent_community_remember` note is still stored, because the bot asked for it.
   */
  readonly memoryEntriesPerRoom?: number;
  /**
   * How many of those room entries are rendered into a turn's prompt (default 8).
   *
   * `0` turns memory injection OFF for the turn entirely — the room delta AND the two
   * long-lived partitions (Bot 长期 / 团队). The long-lived blocks have their own entry/character
   * budget (see `longTermMemoryBlock`), not this number.
   */
  readonly memoryPromptEntries?: number;
}
declare const Config: z<Config>;
declare module '@deepseek-ai/cordis' {
  interface Context {
    agentCommunity: AgentCommunityService;
  }
}
declare class AgentCommunityService extends TypertRemoteService {
  static inject: readonly ["sessions", "agents", "workspaceRegistry", "approval", "permissionPresets", "llm", "sessionController"];
  static Config: z<Config>;
  private state;
  /** Root of this plugin's own data — see `resolveAgentCommunityHome`. */
  private readonly home;
  private readonly statePath;
  private readonly sessionsDir;
  private saveQueue;
  /**
   * Pending coalesced write, if any.
   *
   * Every state mutation used to enqueue its own FULL write of state.json (8+ MB on this
   * board, including one per heartbeat). A mutation burst — one settled run updates runs,
   * messages, ledger and goal — therefore serialized several full copies of the same growing
   * file. This timer collapses all mutations inside one window into a single write of the
   * CURRENT state; `flushNow` bypasses and drains it.
   */
  private writeTimer;
  /** Set when the state file is unreadable/damaged: no writer may run. See blockWrites(). */
  private writesBlocked;
  /** Human-readable reason surfaced through snapshot() when writes are blocked. */
  private stateError;
  /** Monotonic id of the newest state handed to the writer, so a stale snapshot cannot land late. */
  private writeRevision;
  private writtenRevision;
  private readonly cfg;
  /**
   * File-backed memory, one Markdown file per (room, bot).
   *
   * The PROMPT path needs memory synchronously (`buildPrompt` runs inside a turn), so the
   * service keeps an in-memory mirror that is loaded once at startup and updated on every
   * write. The files stay the source of truth: the mirror is a cache of them, not a second one.
   */
  private memoryStore;
  private readonly memoryMirror;
  /**
   * P1 second half: the two LONG-LIVED memory partitions (see memory-scopes.ts).
   *
   * Same rule as the room mirror: the prompt path is synchronous, so the service caches the
   * files in memory, loads them once at startup and refreshes a partition after any write. The
   * files stay the source of truth.
   */
  /**
   * P3-1: crash-recovery checkpoints for runs (claim / approval / settle + restart recovery).
   *
   * One coordinator for the whole service; its snapshots live under
   * `<home>/agent-community/run-state/`. Constructed here, loaded and recovered in `load()`.
   */
  private runState;
  /**
   * P4: each room's durable append-only ledger journal (`ledger/<roomId>.jsonl`).
   *
   * The in-memory projector stays the render source; the journal is what survives a crash
   * between two `state.json` saves and what the export/replay features can trust.
   */
  private readonly ledgerJournal;
  /** Rows replayed from the journal at startup, kept for LAZY room hydration. */
  private ledgerJournalRows;
  /**
   * P5-2: room knowledge Markdown (`knowledge/rooms/<roomId>.md`).
   *
   * The prompt path is SYNCHRONOUS, so the content a turn renders comes from this cache; it is
   * filled at startup and kept current by the knowledge RPCs. A file edited directly on disk
   * therefore becomes visible to prompts after a restart (documented limitation).
   */
  private readonly knowledgeStore;
  private readonly roomKnowledgeCache;
  /** P3-3 rules parsed once at startup; empty means zero behaviour change. */
  private readonly guardrailsRules;
  /** P5-1 conservative context guard; undefined unless `contextGuard.enabled` is true. */
  private readonly contextSteward;
  private memoryScopeStore;
  /** Bot id → that Bot's cross-room memory ([Bot 长期记忆]). */
  private readonly botScopeMirror;
  /** The team-wide rules every Bot reads ([团队记忆]). */
  private teamScopeMirror;
  private readonly ready;
  /** Rooms whose ledger has already been hydrated from state. */
  private readonly ledgerHydrated;
  /**
   * Rooms with a `compactRoom` call in flight.
   *
   * A compaction is a model call followed by a rewrite of the room's history; two of them
   * overlapping would have the second delete messages the first had already summarised.
   */
  private readonly compacting;
  /** Skill discovery + per-bot profiles, signature-driven (§5.3). */
  private readonly skills;
  /** Proposal → confirm/decline → invite → dissolve → hand-off (§5.4–5.9). */
  private readonly groupFlow;
  private executor;
  private readonly ledger;
  /**
   * One native DSH agent per `(roomId, botId)`.
   *
   * Created in `start()` rather than the constructor: it needs the ledger and the
   * skill lifecycle to exist first, and building it eagerly would let a partially
   * constructed service hand out agents.
   */
  private sessionRunner;
  /** Projects native session events into ledger rows. */
  private ledgerProjection;
  /** Leader-driven group coordination. */
  private groupTask;
  private approvalBridge;
  /** Bots asking the user a question: the card blocks the turn until answered. */
  private questionBridge;
  private approvalBridgeDispose;
  /** Expires unanswered group proposals even when no panel is open. */
  private proposalSweeper;
  /** Fires bot reminders the host cannot deliver (subagent-owned sessions). */
  private botScheduleTimer;
  /**
   * S1-5: the durable side-effect queue (see `outbox.ts`). Only effects whose failure would
   * otherwise be lost live here; room state and the ledger remain the source of truth.
   */
  private outboxEffects;
  private readonly outboxConfig;
  private outboxPath;
  private outboxTimer;
  private outboxSaveTimer;
  private readonly outboxHandlers;
  /**
   * `finish_task` reports waiting for the run that produced them to settle.
   *
   * The report is NOT a room row of its own: a ledger push carried no runId and no
   * reasoning, while the turn's answer carried both — the user saw one delivery twice.
   * `finish_task` runs INSIDE the leader's turn, before `settleRun` has written that
   * turn's reply, so this is the hand-off point: stash by run id here, consume in
   * `settleRun`, and publish exactly one message. Keyed by run id; the `room\0leader`
   * key is the fallback for a finish that arrives outside a run (older callers).
   */
  private readonly pendingFinishReports;
  /**
   * Consecutive finish-gate rejections per (room, leader), plus the task-board signature they
   * belong to. OP-02: the first two refusals are strict; the third lets the task close as
   * `bypassed` (recorded as unverified) so a leader that cannot produce verifiable evidence
   * cannot deadlock the room for ever. A changed board resets the count (new task).
   */
  private readonly finishGateRejections;
  /**
   * OP-18: one quiet reputation reminder per room per ten minutes after a group task closes.
   * It reads only the persisted board and only WRITES a notice; no dispatch or roster change.
   */
  private readonly reputationWatchdog;
  /**
   * Last goal-drift warning per room (OP-13). The watchdog only WARNS, and one notice per room
   * per 10 minutes is enough: repeated notices would bury the transcript without adding facts.
   */
  private readonly goalDriftWarnedAt;
  /**
   * S0-3 observe aggregation per room: the last notice time and how many inferred messages have
   * been held back since then. Absent = no notice written yet.
   */
  private readonly admissionObserved;
  /** S0-5: normalized batching config (see `batching.ts`), read once at construction. */
  private readonly batchingConfig;
  /**
   * S0-5: the open batch per `(room, bot)` pair — the queued run that may still accept a burst of
   * user messages. In memory only: a restart leaves the merged prompt persisted on the run and
   * simply forgets that the batch is still open, which is the safe direction (no further merge).
   */
  private readonly openBatches;
  /**
   * S1-2: the thread/task key a RUN was created from, so a later follow-up can tell "correction to
   * this work" from "a different instruction". Keyed by run id; in memory only — a missing entry
   * means "room-level", which makes steering more conservative (it simply will not apply to a run
   * this process did not create).
   */
  private readonly runThreadKeys;
  /** S1-1: bounded in-memory trace of the events that drove the rooms (see `intake.ts`). */
  private recentRoomEvents;
  /** S2-4: in-memory per-room daily budget (a restart resets it; the hard cap still holds per day). */
  private readonly speculationBudget;
  /** C9: prevents two overlapping drains from running the same effect twice. */
  private outboxDraining;
  /** 2026-11-09: at most one experience-condense turn per room per cooldown window. */
  private readonly experienceRefineAt;
  /** S0-6: disposer for the no-wait tool guard, if the host installed it. */
  private noWaitDispose;
  /**
   * S0-6: last progress line per `(room, bot)`, so a long task cannot turn the transcript into a
   * progress feed. Keyed by room NUL bot; three minutes between lines.
   */
  private readonly progressNoticedAt;
  /**
   * S0-7: one rolling record per subsystem (routing / context / memory / schedules / …).
   * Updated on the same paths that already log a failure; `getHealth` exposes the snapshot.
   */
  private readonly healthRecords;
  /**
   * Runs that already got their one grey diagnosis line. A settle can be observed twice (a
   * re-delivered settle, a recovery pass); the transcript must not say it twice.
   */
  private readonly diagnosedRunIds;
  constructor(ctx: Context, config?: Config);
  /** Resolve once the persisted state has been read. Callers that must observe
   *  prior state before mutating should await this first. */
  whenReady(): Promise<void>;
  /**
   * The one sanctioned way to call a model without a session (§24.4).
   *
   * `ctx.llm.stream` is used for work that has no history to keep — skill profiles
   * and the "is this a group task?" judgement. Routing these through an Agent would
   * mint a session per call, which is exactly the session pile-up the visibility
   * rules exist to prevent.
   */
  private directStream;
  /** Persist an analysed skill profile onto its bot (§5.3). */
  private saveSkillProfile;
  /**
   * How many notices one room keeps on disk.
   *
   * Notices are status feedback, not user data, so an unbounded list would let a long-lived room
   * grow `state.json` forever. Keeping the newest rows means the transcript a user re-opens shows
   * the recent history of what happened to the room, which is what the row is for.
   */
  private static readonly MAX_ROOM_NOTICES;
  /** S0-5: one open-batch entry per `(room, bot)` pair. */
  private batchKey;
  /** S0-5/S0-6: forget a room's batch windows and progress throttles (deleted / cleared history). */
  private clearBatchesForRoom;
  /**
   * S0-5: drop batches whose window closed long ago, so an idle board does not keep one entry
   * per pair forever. Runs are not touched: this map is only the merge hint.
   */
  private pruneBatches;
  /**
   * Record one system notice — the durability half of the transcript's grey divider row.
   *
   * Persisted on the ROOM and pushed to the ledger in one move, so the live view and the reloaded
   * view cannot disagree. Two deliberate choices:
   *
   *  · `state.messages` is NOT touched. The unread badge is derived from the room's messages and the
   *    model prompt is built from them, so keeping notices off that list is what makes "a notice
   *    never counts as unread and is never sent to the bot" true by construction rather than by a
   *    filter each new reader has to remember.
   *  · An unknown room is a no-op, not a throw: the caller is reporting something that ALREADY
   *    happened (a model was set, a bot was invited), and failing the report would not undo it.
   */
  private recordNotice;
  /**
   * S0-3 `observe`: aggregate one minute of held-back INFERRED messages into one grey line.
   *
   * Only reached when the room's admission mode is `observe` AND `routing.ts` picked someone
   * without being addressed. Nothing here creates a run, a task or a round: the count is evidence
   * for the user's decision to switch the room to `auto`, and one line per minute keeps the
   * transcript readable while still naming the latest sample (who + why).
   */
  private noteAdmissionSuppressed;
  /**
   * S1-1: build and record one intake event. Returns undefined when the feature is off (so no
   * event id is ever stamped and the run rows are byte-identical to the pre-S1-1 shape) or the
   * room vanished.
   */
  private recordIntakeEvent;
  /**
   * S2-3: the cross-room attention index — METADATA ONLY (ids, counts, timestamps).
   *
   * A projection over existing state; nothing is persisted, nothing enters a bot prompt, and no
   * message text leaves its room. The panel uses it for room-row badges.
   */
  listOpenWork(): OpenWorkView;
  /** S1-1: newest-first trace of recent intake events, optionally filtered (diagnostics only). */
  listRecentEvents(input?: {
    readonly kind?: RoomEventKind | undefined;
    readonly roomId?: string | undefined;
    readonly limit?: number | undefined;
  }): RoomEvent[];
  /**
   * C12: the trace actor a queued run stands for.
   *
   * A dispatch is attributed to the SENDER (the leader) and an a2a run to the bot its prompt
   * names, not to the woken member the run belongs to. Falls back to the owner when the prompt
   * carries no sender, which is still more honest than calling the receiver the sender.
   */
  private intakeActorIdFor;
  /** S1-1: the actor a legacy origin stands for, for the trace. */
  private intakeActorFor;
  /**
   * S0-6: one grey progress line from a Bot, rate-limited per `(room, bot)`.
   *
   * Deliberately a LIVE control row (the same `dispatch` row the schedule trigger writes), not a
   * durable notice and not a bot message: progress is "it is still moving", it must not count as
   * an answer, must not be replayed into prompts, and must not survive a reload as history.
   * A throttled call returns `ok:false` with the reason — the tool reports it to the model instead
   * of failing the turn.
   */
  private recordProgress;
  /**
   * S1-3: a Bot hands back the thread/task it is working on.
   *
   * The thread key comes from the RUN the bot is currently executing (recorded when the run was
   * created), so the model cannot name another thread/room. Removing the bot from the subscription
   * is all the routing change; a room notice explains it to the user and the leader.
   */
  handbackThread(input: {
    roomId: string;
    botId: string;
    reason: string;
  }): {
    ok: boolean;
    reason?: string | undefined;
  };
  /**
   * S1-4: the trusted `[任务段]` block for one turn, or undefined when the same task continues.
   *
   * Injected ONLY on the first turn of a new assigned task: repeating the boundary every turn
   * would cost tokens and re-anchor the model on already-finished work. The handoff comes from
   * the previous segment's recorded report (facts, never a model summary).
   */
  taskSegmentBlock(roomId: string, botId: string, assignment: {
    readonly subject: string;
    readonly fromName: string;
  } | undefined): string | undefined;
  /**
   * S1-4: fold a settled assigned run's facts into its segment.
   *
   * The handoff is built deterministically from the finish report, the delivered text and the
   * declared files — no model call, so it cannot invent work. A stale key (the bot moved on before
   * this run settled) is ignored by `recordSegmentReport`.
   */
  private recordTaskSegmentReport;
  /**
   * S0-7: fold one subsystem outcome into the rolling record, and decide whether the room hears
   * about it. The caller already handles the failure; this only aggregates and throttles.
   */
  private recordHealthOutcome;
  /** A subsystem succeeded again (clears its streak). */
  healthOk(subsystem: string): void;
  /**
   * A subsystem failed. Public because `RunExecutor` records prompt-assembly faults with it;
   * everything else in the plugin calls it from the path that already caught the error.
   */
  healthFailure(subsystem: string, error: unknown, roomId?: string): void;
  /** S0-7: per-subsystem health for diagnostics. Worst first; never includes prompt text. */
  getHealth(): ReturnType<typeof healthSnapshots>;
  /**
   * OP-12: record a bot's structured abstention as a visible notice.
   *
   * The tool surface is `agent_community_abstain`; this is its service half. It deliberately:
   *  · returns a failure ONLY for a missing reason — the one case where the model can fix it;
   *  · writes a `dispatch` notice (durable + live) so the USER sees the bot explaining itself; by
   *    the notice rule the line is NOT injected into any bot's next prompt (and never becomes a
   *    bot message);
   *  · does NOT post as the bot, end the turn, or touch memory: an abstention is information, not
   *    a verdict. The run keeps its own reply path.
   */
  private recordAbstain;
  /**
   * OP-22: copy one member's produced file into another member's workspace (file-first handoff).
   *
   * WHY THE SERVICE AND NOT THE TOOL. Both workspaces are service knowledge (`runWorkspaceDir`),
   * and the source path is untrusted input. Everything is checked before a byte is copied:
   *   · the room must be a live group and both bots must be members of it;
   *   · the target must be named exactly as the room roster names it (no ids, no "someone");
   *   · the source must canonicalize INSIDE the sender's workspace (realpath, so `..` and
   *     symlink escapes are refused), be a regular non-empty file, ≤32MB;
   *   · the copy lands in `<target workspace>/handoffs/<UTC stamp>-<safe name>`.
   *
   * A handoff is a COPY: the sender keeps its file (nothing is moved or deleted). The receiver is
   * woken through the normal member-message path with the new absolute path, and the room gets a
   * visible notice so the user can see the artifact changed hands.
   */
  private handoffFileToMember;
  /**
   * The panel's notice row: 「已把「X」的模型设为：…」 and friends.
   *
   * Returns whether the row was recorded, so a caller that cares can tell "the room is gone" from
   * "done". The panel does not care: it fires and forgets, because the row is feedback about an
   * action whose result it has already shown.
   */
  noticeRoom(input: NoticeRoomRequest): Promise<{
    readonly stored: boolean;
  }>;
  /** The state access the group flow needs; the flow owns decisions, not storage. */
  private groupFlowPort;
  /**
   * Queue exactly one run for one bot.
   *
   * Unlike `sendMessage` this never fans out over the member list: both callers
   * (a confirmed group's leader, a declined proposal's direct chat) act on behalf of
   * a single bot, and starting the others would resurrect the "everyone runs once"
   * model the leader-driven design replaced.
   */
  /**
   * S2-4 hard guard: is the CURRENT running turn for this pair a speculative rehearsal?
   *
   * Runs for one (room, bot) pair are serialized, so the live run the pair is executing is the
   * caller. Mutating tool adapters refuse while this is true: the prompt asks the model not to
   * call them, but a model that ignores the prompt must not be able to post questions, dispatch,
   * deliver cards, write memory or close tasks from inside a rehearsal.
   */
  private speculationTurnActive;
  /**
   * S2-4: the one place that decides whether a user message is worth a speculative rehearsal.
   *
   * Pure policy in `speculation.ts`; this method only reads the room's setting, the in-memory
   * daily budget, and the routed message. `observe` never starts a run (it exists to measure how
   * often a room WOULD have speculated); `on` starts ONE hidden run for the room's leader, under
   * the hard daily budget, and it is never published.
   */
  private maybeStartSpeculation;
  /** Newest-first message lookup by id (reply chains usually point at recent messages). */
  private messageById;
  /**
   * S2-1: a role change cannot re-shape the existing session (its preset is recorded in the header
   * at creation). Log it once so the operator knows why the next turn still has the old tool set;
   * the new role takes effect when the session is recreated (clear the room / restart).
   */
  private notePresetChangeTakesEffectLater;
  /**
   * S2-2: one page of this room's history for a bot's `agent_community_read_history`.
   *
   * The tool is read-only and the ids come from the caller's own session, so the only authority
   * check needed is "this room exists" (already true for a live agent). Pages are bounded; text is
   * clipped to a page-sized snippet; nothing outside this room is reachable.
   */
  private readHistoryForBot;
  /**
   * S2-2: one run summary for `agent_community_read_run` (own room only; no prompt text).
   */
  private readRunForBot;
  /**
   * S2-2: the room's task board for `agent_community_read_task` (read-only summary).
   */
  private readTaskForBot;
  /**
   * S1-3: the subscription key for one message, walking reply chains to a thread root.
   *
   * The lookup runs over persisted messages, so a chain is resolved without trusting any
   * client-supplied root. The result is empty when the message has neither explicit threading nor
   * a reply — and an empty key binds nothing (see `subscriptions.ts`).
   */
  private threadingKeyForSubscription;
  /**
   * The group's coordinator — the SAME answer the group flow and the task board use.
   *
   * The stored `team.leader` wins while it is a bot that is still a member; otherwise the first
   * member in join order, so a group can never end up leaderless while it still has members and
   * a hand-made/legacy room (no `team` at all) still has a working coordinator. Delegated to
   * `resolveRoomLeader` so there is exactly one implementation of that rule.
   */
  private leaderOfRoom;
  /**
   * Enqueue one member's work in a group.
   *
   * `bot-message` rather than `user`: the prompt was written by the leader, not typed
   * by the user, and the distinction is what lets a later reader tell a hand-off from
   * something the user actually said.
   *
   * `options.internal` marks the leader's INTEGRATE turn: it runs (and may finish the
   * task), but its prose is coordination, not an answer — the members' own replies are
   * already in the room. Published turns (a member's assigned work) omit it.
   */
  private enqueueGroupRun;
  /**
   * Tag a run with how it may speak, after creation.
   *
   * Written here rather than inside `queueRoomRun` because that is the single creation
   * point shared by every wake-up path and it carries no policy; the run is still
   * `queued`, so no consumer (executor, projection) has read it yet. The flag is what
   * `publish-policy` and every row writer consult.
   */
  private markRunPublish;
  private installCollaborationTools;
  /**
   * Queue exactly one run, unless the room is paused.
   *
   * THE PAUSED GUARD LIVES HERE, not only in `sendMessage`: the panel's 「暂停（不创建新运行）」
   * promised that no run is created, but schedules, goal continuations, a2a wakes and group
   * hand-offs each called this method directly and only the user-message path checked the flag.
   * Refusing at the single creation point makes the promise true for every source, and returns
   * undefined so a caller that needs the run (the goal continuation) can skip its bookkeeping.
   */
  private queueRoomRun;
  /**
   * Keep the direct-chat turn alive after a group proposal is refused (§5.4).
   *
   * A live turn is only nudged; a follow-up is queued solely when nothing is
   * running, so a decline can never run the same task twice.
   */
  private resumeSoloTurn;
  /**
   * Tear down every live agent a room owns, then abort anything still in flight.
   *
   * The executor owns the agents, so this asks it through a duck-typed hook rather
   * than reaching into its internals: `abortRoom` exists today, and an executor that
   * later materialises DSH Agents exposes `disposeRoomAgents` for the same purpose.
   * Missing hooks are not an error — the plugin's own LLM-direct path creates no
   * Agent at all.
   */
  private disposeRoomAgents;
  /** Same, scoped to one bot across every room it belongs to. */
  private disposeBotAgents;
  /**
   * C11 / 2026-11-09: internal turns are scoped to the process that started them.
   *
   * Their markers are persisted (so a settle can never publish them), but a restart cannot resume
   * the intent — the queue would execute them as ordinary work and the room reactions would fire.
   * Any queued/running speculation or experience-condense run left by a previous process is
   * cancelled here, before the executor starts, with a metadata-only reason.
   */
  private abortOrphanedInternalRuns;
  /** C14: drop the in-memory maps keyed by a room that is going away (or being cleared). */
  private forgetRoomRuntime;
  private load;
  /**
   * Stop persisting, and say why.
   *
   * Set when the state file is unreadable or damaged. Every writer checks it, because the failure it
   * prevents is the worst one this service has: writing an empty community over the user's only copy.
   */
  private blockWrites;
  /** Copy an unparseable state file aside so the user can inspect or repair it. */
  private quarantineState;
  /**
   * Persist immediately and await it, instead of queueing behind the coalescing writer.
   *
   * Deletion must be on disk before its folders are removed, so the "gone" state can never be
   * lost to a crash between the two. This call also DROPS a pending coalesced write: the
   * state written here is at least as new as anything that timer would have written.
   */
  private flushNow;
  /**
   * Schedule one state write, coalescing every mutation inside the window.
   *
   * WHY NOT WRITE PER MUTATION: a single settled run mutates the runs array, appends a
   * message, bumps the goal and pushes a ledger row — four `enqueueWrite()` calls inside one
   * millisecond, each of which used to serialize the whole (multi-megabyte) state. With a
   * full write per heartbeat on top, the writer was the board's hottest path for no gain.
   *
   * The timer captures nothing: when it fires, the CURRENT `this.state` is written and it is
   * stamped with a new revision (`queueStateWrite`), so mutations that happen while a write is
   * in flight still end up in the next one. `flushNow()` cancels this timer and writes at once.
   */
  private enqueueWrite;
  /**
   * Enqueue one serialized write of the state AS OF NOW.
   *
   * The revision is captured here, not when the queued task finally runs: bytes on disk are
   * ordered by mutation order, and a write a newer one already covered can be skipped
   * (`writeSnapshot` compares revisions). This is also why two writers — this queue and
   * `flushNow` — cannot interleave a stale snapshot over a newer one.
   */
  private queueStateWrite;
  /** One serialized write. Skips work when a newer revision already reached the disk. */
  private writeSnapshot;
  /**
   * Copy a bot into a new bot and hand back its direct room, so the UI can jump
   * straight into the copy's conversation.
   *
   * Naming follows the source: forking the same bot repeatedly yields
   * "name（1）", "name（2）", … A copy is itself forkable and starts its own series.
   * The copy inherits configuration, model, workspace, prompt, permission and
   * avatar, plus the source conversation's messages, so the fork continues from
   * the point it was taken at rather than opening empty.
   *
   * @param sourceRoomId room whose transcript is carried over; the bot's direct
   *   room is used when omitted.
   */
  copyBot(botId: string, sourceRoomId: string, upToMessageId: string): Promise<{
    bot: BotIdentity;
    room: BotRoom;
  }>;
  /** Drop a trailing "（n）" so copies of copies do not stack suffixes. */
  private stripForkSuffix;
  createBot(input: CreateBotRequest): Promise<BotIdentity>;
  updateBot(input: UpdateBotRequest): Promise<BotIdentity>;
  deleteBot(input: DeleteBotRequest): Promise<void>;
  listBots(): BotIdentity[];
  getBot(id: string): BotIdentity | undefined;
  createRoom(input: CreateRoomRequest): Promise<BotRoom>;
  /**
   * Who is asking for a room, from the calling agent's session id.
   *
   * A session id this plugin owns (`ac:<roomId>:<botId>`) identifies a Bot and the room it is
   * working in — which is what makes `screenRoomCreation` able to refuse a second group. Anything
   * else (no session, the user's own agent session, a session of another plugin) is the user
   * acting through the panel or the CLI, and is allowed.
   */
  private roomCreationActor;
  private buildTeam;
  continueTeamTask(input: {roomId: string; messageId: string; taskKey: string; expectedRevision: number; mode: "stop-task"}): Promise<{ok: boolean; taskKey: string; taskId: string; requestId: string; revision: number; status: string}>;
  continueTeamTask(input: {roomId: string; messageId: string; botId: string; dispatchId: string; mode: "check-member-receipt" | "retry-member-delivery"}): Promise<{ok: true; status?: string; runId?: string; alreadyRetried?: boolean}>;
  continueTeamTask(input: {roomId: string; messageId: string; mode: "cancel-selection"}): Promise<{ok: true; requestId: string; status: "cancelled" | "expired"}>;
  continueTeamTask(input:{roomId:string;messageId:string;taskKey:string;mode?:"resume-pending"}):Promise<{ok:boolean;taskKey:string;taskId:string;requestId:string;revision:number;status:string;runId?:string;alreadySelected?:boolean;alreadyRunning?:boolean}>;
  taskContinuationCandidates(roomId:string):readonly {taskKey:string;messageId:string;text:string;label:string;relayId?:string;status:string}[];
  updateRoom(input: UpdateRoomRequest): Promise<BotRoom>;
  deleteRoom(input: DeleteRoomRequest): Promise<void>;
  listRooms(): BotRoom[];
  getRoom(id: string): BotRoom | undefined;
  sendMessage(input: SendRoomMessageRequest): Promise<BotMessage>;
  listMessages(roomId: string): BotMessage[];
  /**
   * §17.4 (b): the session id a (room, bot) pair owns, derived rather than stored.
   *
   * Deterministic on purpose. Visibility is enforced by archiving session ids, and a
   * hand-maintained list of ids fails silently the first time a creation site forgets
   * to register: the session becomes visible on the user's sidebar. A derived id
   * cannot be forgotten, and it makes the id list recomputable from state alone.
   */
  /** The room's current session generation; 0 until its messages are cleared or compacted. */
  private generationOf;
  private sessionIdFor;
  /**
   * Clear a room's visible history AND the memory behind it (§23.1).
   *
   * The two are separate stores: the ledger is what the user reads, the bot sessions
   * are what the model remembers. Clearing only the ledger left every bot still
   * "remembering" text the user had deleted — the next turn could quote it back, which
   * is a content leak, not a cosmetic bug. So this disposes the room's live agents and
   * deletes their session logs in the same step; the next run starts from an empty
   * history (§23.1 G4).
   *
   * Also cancels stale non-running runs so failed badges disappear from the UI.
   *
   * The room's TASK BOARD and round state go with it. They are the round's memory of
   * "what this conversation is about", and `agent_community_get_context` hands them to
   * every bot that orients itself — a tool description that says "Call this first".
   * Leaving them behind made a cleared room lie: the first bot to answer a fresh "你好"
   * reported the PREVIOUS round's deliverables as current progress ("tokens.json already
   * delivered, only the AA patch is undecided"), and because each later bot read that
   * answer as room context, the whole group built on a round that no longer existed.
   * Clearing the conversation clears the board that belongs to it.
   */
  clearMessages(roomId: string): Promise<void>;
  /**
   * Erase this room's bot memory WITHOUT touching the transcript.
   *
   * The clear dialog's opt-in checkbox calls this: the default clear keeps memory (the
   * product rule), but a user who typed a 口令 and wants it forgotten can clear it in the
   * same action. Per-room: other rooms' partitions and `_archive` are untouched (deleting
   * a room still archives; only deleting a Bot deletes everything).
   *
   * Returns the number of memory files removed (0 when the room had no memory).
   */
  clearRoomMemory(roomId: string): Promise<{
    cleared: number;
  }>;
  /**
   * Compress a room's older history into ONE summary row, keeping the newest `keepLast` verbatim.
   *
   * WHY THE ROOM'S OWN MESSAGES ARE THE THING TO COMPRESS. There is no host-side
   * compaction API: the bot's session is hidden inside this plugin, and `RunExecutor`'s
   * memory is exactly `historyMessagesInPrompt` messages read from `state.messages`
   * (plus `SessionRunner`'s seed of the same list into a fresh session). So replacing the
   * old messages with a summary is the one lever that shrinks what every later turn —
   * and every fresh session — actually carries.
   *
   * THE THREE STORES MOVE TOGETHER, or the compression is a lie in one of them:
   *
   *   · `state.messages` — the older segment becomes {@link summaryMessageText}'s single
   *     `压缩摘要` message; the newest `keepLast` stay byte-for-byte.
   *   · the LEDGER — the panel renders the ledger, not the messages, so it is rebuilt
   *     from the new list (`seedLedgerRoom`) and the pre-compaction rows are gone.
   *   · the SESSIONS — the summary only compresses what a bot carries forward if the old
   *     session is not resumable: refreshing its seed from `state.messages` would restore
   *     the whole transcript from the runtime's own log. The room's generation therefore
   *     advances (`compactCount`) and the retired logs are purged, exactly as
   *     `clearMessages` does for a cleared room.
   *
   * ORDERING IS THE SAFETY PROPERTY. Every refusal — too short, a live turn, a model
   * failure, a message that arrived while the model was thinking — happens BEFORE the
   * first write, so a rejected compaction leaves the room byte-for-byte unchanged.
   */
  compactRoom(input: CompactRoomRequest): Promise<CompactRoomResult>;
  /** True while any run of this room is queued or running. */
  private liveRunIn;
  listRuns(botId?: string): BotRun[];
  retryRun(input: RetryBotRunRequest): Promise<BotRun>;
  controlRun(input: ControlBotRunRequest): Promise<BotRun>;
  /**
   * Terminal transition for one run, the only way a run leaves `running`.
   * `controlRun` can only interrupt or cancel; without this a completed run
   * would keep its owner reported as busy forever.
   */
  settleRun(input: SettleBotRunRequest): Promise<BotRun>;
  /**
   * Root that holds one private directory per bot.
   *
   * Follows the SAME home as the board (see `resolveAgentCommunityHome`): a bot's
   * workspace is its session's `cwd`, and that `cwd` decides which on-disk session
   * bucket the conversation lands in. Hardcoding `~/.dsh` here while the board moved
   * with `$DSH_HOME` would put an isolated instance's sessions back in the shared store.
   */
  private botWorkspaceRoot;
  /**
   * A bot's private workspace directory.
   *
   * Bots used to default to the shared DSH workspace, so a file one bot created
   * during a direct chat was visible to every other bot in every group chat —
   * which looked exactly like the group bot "remembering" the private chat. Each
   * bot now gets its own directory.
   */
  private botWorkspaceDir;
  /**
   * The bot's workspace, created on disk if it is missing.
   *
   * `botWorkspaceDir` only builds a path. Without this the directory never existed,
   * and since the path is handed to the session as its `cwd`, session creation failed
   * and the bot silently produced nothing. Awaiting the mkdir before persisting the
   * bot keeps the invariant true from the moment the bot exists.
   */
  private ensureBotWorkspace;
  /**
   * The directory a bot's sessions actually run in.
   *
   * `bot.workspace` wins when the user configured one — that IS the session's `cwd` —
   * and `botWorkspaceDir` is the fallback, the same rule `session-runner` applies. An
   * attachment must land in the first of those: a file written to the default directory
   * of a bot that runs somewhere else sits outside its workspace, where a sandboxed bot
   * cannot read it — which is the same as not attaching it at all.
   */
  private runWorkspaceDir;
  /**
   * Store a message's attachments in the workspace of every bot that may read it.
   *
   * A direct room writes exactly one copy (it has one bot). A group writes one copy per
   * member, because the routing decision that picks the answering bot is made further
   * down `sendMessage` — writing only for the room's leader would hand the file to a bot
   * that never answers, and a file the winner cannot open is the same as no attachment.
   *
   * Returns `undefined` when the message carries no files, so the caller can leave the
   * model payload byte-for-byte as it was.
   */
  private storeMessageAttachments;
  private defaultWorkspaceCache;
  resolveDefaultWorkspace(): Promise<string>;
  /** Returns defaults the UI needs to pre-populate the create-bot form. */
  getDefaults(): Promise<{
    defaultWorkspace: string;
  }>;
  teamMembership(sessionId: string): Promise<BotTeamMembership | undefined>;
  postTeamMessage(input: PostTeamMessageRequest): Promise<TeamMessageResult>;
  dismissTeam(input: DismissTeamRequest): Promise<void>;
  /**
   * The session a (room, bot) pair owns, registered in state and returned.
   *
   * The id is DERIVED, not randomised (§17.4 b): `ac-<roomId>-<botId>`. A random id
   * per run meant the visibility list could only ever be a hand-maintained
   * bookkeeping table, and any creation site that forgot to register left a session
   * on the user's sidebar. With a derived id the list is recomputable from
   * `state.rooms × state.bots`, and `listKnownSessionIds` cannot fall out of date.
   *
   * Idempotent: re-registering the same pair writes nothing, so the hot paths
   * (sendMessage, clear-then-reseed) no longer churn state.json.
   */
  ensureStableSession(roomId: string, botId: string): SessionId;
  /** Transition a queued run to running state with a lease. */
  claimRun(input: {
    id: string;
    expectedRevision: number;
    leaseOwner: string;
    leaseExpiresAt: string;
  }): Promise<BotRun>;
  /**
   * Settle + reconcile the run's checkpoint (P3-1).
   *
   * The snapshot is the crash-recovery aid, never the user-visible truth: a failed snapshot write
   * is logged and swallowed so it cannot make the settle itself fail.
   */
  /**
   * Sample one bot session's context pressure from the HOST services (P5-1).
   *
   * Optional by contract: a host without `sessions`/`tokenMeter` (or a session already
   * disposed) reads as "no sample", which the steward turns into `unavailable` — the guard
   * never changes behaviour on a partial host.
   */
  private sampleContextPressure;
  /**
   * Ask the HOST to compact one bot session (P5-1, opt-in via `contextGuard.autoCompact`).
   *
   * `compactIfNeeded` is the automatic-pressure entry point (no maintenance task needed);
   * the signal bounds how long a stuck summarization may hold the background check. The
   * host may answer "nothing to compact" (null), which is not a failure.
   */
  private compactBotSession;
  /**
   * A bot turn finished: let the opt-in context guard look at its session.
   *
   * FIRE-AND-FORGET: this runs after the settle is persisted and must never delay or fail a
   * settlement (the steward itself also never throws). Only a COMPLETED turn is checked —
   * a failed/interrupted session may still be mid-teardown, where compaction is unsafe.
   */
  private noteContextPressure;
  private settleRunState;
  /**
   * Startup recovery of the run checkpoints left by the previous process.
   *
   * The pure planner decides; this method only applies its plan to the board and tells the room.
   * THE RULE: an unfinished turn is FAILED with an explanation (its model call is gone; a
   * deterministic resume does not exist), never silently completed and never left running.
   */
  private recoverRunStates;
  /**
   * The harness a run claimed NOW would be attributed to (OP-01).
   *
   * Read at claim time, from the live configuration, and stored on the run: a later config
   * change, a plugin upgrade or a prompt-contract bump must not retroactively relabel the runs
   * that already produced results. `readPluginVersion` reads package.json at runtime — the
   * source deliberately contains no version literal.
   */
  private currentHarnessAttribution;
  /**
   * Persist the adaptive-timeout state of a running run (called by the executor).
   *
   * The executor's hot loop keeps its own copy; this is the durable half — a panel (or a
   * restart) can show the deadline it is running against, and how much progress was seen.
   * Writes are throttled by the caller (progress at most every few seconds; a deadline or an
   * extension immediately).
   */
  updateRunBudget(id: string, patch: {
    deadlineAt?: string;
    lastProgressAt?: string;
    extensions?: number;
    progressEvents?: number;
  }): void;
  /**
   * A run's adaptive budget was exceeded (timeout / no progress). Called by the executor
   * BEFORE it settles the run, because this is the half only the service can do:
   *
   *   · the room gets a durable, human-readable notice (the error row is diagnostics);
   *   · a GOAL CONTINUATION round that timed out pauses its goal. Without this the goal
   *     would stay active and the next settle would queue another round into the same
   *     timeout — the "automatic work that never finishes" pattern S3 was about.
   */
  onRunTimedOut(input: {
    readonly runId: string;
    readonly roomId: string;
    readonly botId: string;
    readonly origin: string | undefined;
    readonly prompt: string;
    readonly kind: 'timeout' | 'no-progress';
    readonly detail: string;
  }): void;
  /**
   * Take over a run whose lease has expired, without needing to know its owner.
   *
   * `claimRun` is the queued→running transition and refuses a running run, and
   * `settleRun` refuses a lease owner that does not match the stored one. Together
   * those two guards made a run left behind by a killed process **unrecoverable**:
   * its `leaseOwner` is a random UUID minted by that dead process, so nothing this
   * process can pass will ever match, the settle throws, and the run stays `running`
   * for good — with the room showing a 排队 banner and a dead 停止生成 button while
   * every later message queues behind it.
   *
   * An EXPIRED lease is the plugin's own proof that the holder is gone (a live turn
   * renews it every 15 s), so recovery may take it: this re-stamps the lease under
   * `leaseOwner` and bumps the revision, after which a normal `settleRun` succeeds.
   * The revision check and the expiry check are both enforced here, so this cannot
   * steal a run that a live process is still heartbeating.
   *
   * @param input.id - the run to reclaim.
   * @param input.expectedRevision - caller's view of the run's revision.
   * @param input.leaseOwner - the owner taking over (this process's LEASE_OWNER).
   * @param input.now - current time, for the expiry test.
   * @returns the updated run.
   * @throws when the run is missing, moved on, not running, or its lease is still valid.
   */
  reclaimStaleRun(input: {
    id: string;
    expectedRevision: number;
    leaseOwner: string;
    now: number;
  }): BotRun;
  /** Extend the lease on a running run (called on a heartbeat interval). */
  heartbeatRun(id: string, leaseOwner: string, leaseExpiresAt: string): void;
  /**
   * Return the bot's session in a room, if one has been created.
   * Session creation is now handled by ensureStableSession; this is read-only.
   */
  ensureRoomAgentSession(roomId: string, botId: string): SessionId;
  /** The bot's session in a room, if one has been created. */
  roomAgentSession(roomId: string, botId: string): SessionId | undefined;
  /** Every room-scoped bot session, for UI listings. */
  listRoomAgentSessions(): readonly RoomAgentSession[];
  /**
   * All session ids the executor should detach from workspace / archive (§17.4 b).
   *
   * DERIVED, not stored: one deterministic id per (existing room, existing member),
   * plus whatever the legacy bookkeeping table still holds. The persisted entries are
   * kept in the union for one reason only — sessions minted by an older build carry a
   * random id, and dropping them from this list would un-hide them on the user's
   * sidebar (N12). Nothing writes a random id any more.
   */
  listKnownSessionIds(): readonly string[];
  /**
   * Return the session id the client should retain for a room's conversation.
   *
   * - DM: the same derived id the run executor uses for this bot.
   * - Group: the LEADER's derived session. The group used to allocate a separate
   *   host session here (`roomSessionId`) for the dispatcher agent; that role is gone
   *   (§24.5 — the leader schedules), so nothing is allocated and nothing is written
   *   to state. A group with no leader falls back to the first member's id so the
   *   caller always gets a stable, hideable session id rather than a fresh UUID that
   *   no visibility sweep could ever know about.
   */
  ensureRoomSession(roomId: string): {
    sessionId: SessionId;
    isGroup: boolean;
  };
  /** Return the room id for a given session id, or undefined if not found. */
  roomForSession(sessionId: string): string | undefined;
  /** Return a snapshot of the room context as seen by a Bot. */
  getRoomContext(roomId: string): unknown;
  /** Post a message from a Bot, with optional a2a direct delivery. */
  postBotMessage(input: PostBotMessageRequest & {
    internal?: boolean;
  }): Promise<BotMessage>;
  /**
   * Whether the calling Bot is answering the room RIGHT NOW.
   *
   * Used to warn a bot that posts its own reply instead of letting the executor publish it:
   * the answer is appended to the transcript when the turn ends, so an extra
   * `agent_community_post_message` call makes the user see the same reply twice. The tool
   * description and the group system prompt both say so; this is the runtime backstop for a
   * session that learned the old habit (measured: a bot answered a greeting and then posted
   * the same text again — two rows for one message).
   *
   * @param roomId - the room the message was posted into.
   * @param senderSessionId - the calling Bot's session, which identifies the bot.
   * @returns true when that bot has a live run in that room.
   */
  isAnsweringNow(roomId: string, senderSessionId: string): boolean;
  /** Leader tool: decompose the user request into tasks. */
  decomposeTasks(input: DecomposeTasksRequest): Promise<BotTask[]>;
  /** Leader tool: assign or re-assign tasks. */
  assignTasks(input: AssignTasksRequest): Promise<BotTask[]>;
  /** Return all tasks and their status for the current room. */
  getTaskStatus(roomId: string): BotTask[];
  /** Member tool: submit a progress report for a task. */
  reportTask(input: ReportTaskRequest): Promise<BotTask>;
  /** Leader tool: finalize the round and post a summary message. */
  submitFinal(input: SubmitFinalRequest): Promise<BotMessage>;
  /**
   * Record a group proposal for one direct-chat message.
   *
   * The judgement belongs to the BOT. Either the `propose_group` tool hands over a
   * proposal the model actually wrote (memberIds present), or the direct-chat bot's
   * own model is asked through a direct `llm.stream` call. What no longer happens is
   * the old heuristic — "there are at least two bots, so suggest the first two" —
   * which produced a dialog the user had not been offered by any bot, and whose
   * roster knew nothing about the task.
   *
   * Returns undefined whenever a group is not warranted: fewer than two bots, a
   * group room, no such message, or a model that answered "single bot is enough".
   */
  proposeGroup(input: ProposeGroupRequest): Promise<GroupProposal | undefined>;
  /**
   * User confirmed: create the group, move the user's original task into it verbatim,
   * and start ONLY the leader (§5.4).
   *
   * A proposal whose members have since been deleted is re-filtered here — the
   * dialog may have been open across a delete, and a group containing a bot that no
   * longer exists would have no valid members to run.
   */
  confirmGroup(input: ConfirmGroupRequest): Promise<BotRoom>;
  /**
   * User declined (or the dialog timed out): mark it declined and let the direct
   * chat finish the task on its own — the bot must never be left waiting.
   */
  declineGroup(input: DeclineGroupRequest): Promise<void>;
  /** The room's pending proposal, if any (expiry applied). Used by the panel. */
  pendingGroupProposal(roomId: string): PendingGroupProposal | undefined;
  /**
   * `invite_bot` (§5.6): add one bot, enforcing 4 per turn and 20 per room.
   *
   * Returns a failure object instead of throwing: the caller is a model tool, and
   * the model needs the reason in its own turn so it can adapt.
   */
  /**
   * Take bots out of a group (§membership).
   *
   * The single entry point for both callers: `remove_bot` from a bot (leader-only, see
   * `groupFlow.remove`) and the UI's `removeRoomMembers`. Authority is enforced HERE as
   * well, never only in the tool — a tool is a convenience wrapper, not a boundary.
   */
  removeBots(input: {
    roomId: string;
    botIds: readonly string[];
    actorId?: string | undefined;
    reason?: string | undefined;
  }): Promise<{
    ok: boolean;
    removed: readonly string[];
    refused: ReadonlyArray<{
      botId: string;
      reason: string;
    }>;
    error?: string | undefined;
    memberIds?: readonly string[] | undefined;
  }>;
  inviteBot(input: {
    roomId: string;
    botId: string;
    reason?: string | undefined;
    roundToken?: string | undefined;
  }): Promise<{
    ok: boolean;
    error?: string | undefined;
    alreadyMember?: boolean | undefined;
  }>;
  /** The room's background task board (§5.4: no UI, but the record exists). */
  /**
   * The run a (room, bot) pair is currently executing, if any.
   *
   * Used to hang a question row inside the turn that asked it, so the card renders with the
   * bot's work instead of floating at the bottom of the transcript.
   */
  /**
   * Validate and record the files a bot declared with `agent_community_deliver`.
   *
   * Mirrors DSH's `present` rules instead of inventing new ones: relative paths resolve
   * against the bot's own workspace, absolute paths may point outside it, and only an
   * existing regular file passes (a directory or a final symlink is refused). The paths
   * are canonicalised here, before anything is shown, so a card can never point at a
   * path the host would later refuse to open.
   */
  private deliverBotFiles;
  /**
   * Act on one declared deliverable with the Host desktop: list its OS applications,
   * open it with one, or reveal it in the file manager.
   *
   * Addressed by (room, run, index) like the preview, so the only paths this can reach
   * are the ones a Bot already delivered. The call goes through the Host's own
   * `sessionController` service, which is the same implementation DSH's chat cards use
   * from the browser — it does not depend on the client Remote surface.
   */
  deliverableFileAction(input: DeliverableAddress & {
    action: 'applications' | 'open' | 'reveal';
    application?: string | undefined;
  }): Promise<{
    ok: true;
    applications?: Array<{
      id: string;
      name: string;
      default: boolean;
      icon: string | null;
    }>;
  } | {
    ok: false;
    error: string;
  }>;
  /**
   * Convert one delivered Office document to PDF for the in-panel preview.
   *
   * The plugin's own page cannot host DSH's right Sidebar (the Sidebar exists only
   * while a Session surface is mounted), so the preview renders inside the panel.
   * Office fidelity comes from the Host's own `office-to-pdf` provider — the same
   * engine DSH's document preview uses — addressed through the delivery record.
   */
  renderDeliverableDocument(input: DeliverableAddress): Promise<{
    ok: true;
    name: string;
    dataUrl: string;
  } | {
    ok: false;
    error: string;
  }>;
  /**
   * Read one declared deliverable for the panel's preview.
   *
   * Addressed by `(room, run, index)` and never by a client-supplied path: the only
   * files this can read are the ones a bot already declared for the user. Text is
   * paged and capped; images, PDF and the browser-rendered Word/Excel formats are
   * returned as data URLs under a byte cap; everything else reports its metadata so
   * the card can hand it to a native app. Bot session ids never cross this boundary
   * (the ledger's red line).
   */
  readDeliverablePreview(input: DeliverableAddress & {
    offset?: number | undefined;
  }): Promise<{
    kind: 'text';
    name: string;
    text: string;
    offset: number;
    truncated: boolean;
  } | {
    kind: 'data';
    name: string;
    mime: string;
    dataUrl: string;
  } | {
    kind: 'binary';
    name: string;
    size: number;
  } | {
    kind: 'missing';
    name: string;
  }>;
  private currentRunIdFor;
  /** The newest live run for a (room, bot) pair, or undefined when that bot is idle. */
  private liveRunFor;
  /**
   * Publish mode of a run, by id.
   *
   * Read from state rather than captured at creation: the executor asks this from inside
   * the run (skipping the row reservation / final-answer write for an internal run), and
   * the flag lives on the run record. An unknown id stays visible — silencing a bot
   * because a record could not be found would be the worse failure.
   */
  private publishOfRunId;
  /**
   * The ledger as the run executor sees it — with one gate.
   *
   * The projection is not the only writer of a turn's rows: `runs.ts` reserves a live
   * row before the model runs and writes the final answer afterwards, for EVERY run. An
   * internal run must leave no turn behind (that is the duplicate the user saw), and
   * suppressing only the projection would still leave an empty reserved row — which the
   * panel renders as a bot bubble with no answer. Those two writes are therefore dropped
   * for an internal run; everything else delegates untouched, and the one row the run
   * does owe the user (its finish report) is pushed by `settleRun`.
   */
  private executorLedgerView;
  /**
   * The room's task board as the gate sees it.
   *
   * `room.taskState` is the PERSISTED board (assignments carry `done` once a member reported),
   * which is exactly what "this task was really delivered" must be checked against — the
   * in-memory driver has its own copy but this one survives a reload.
   */
  private finishGateBoard;
  /** Signature of the current board, so a rejection streak cannot leak into the NEXT task. */
  private finishGateBoardSignature;
  /**
   * Gate a `finish_task` declaration, then close the task through the driver.
   *
   * THE GATE IS THE AUTHORITY. Evidence is checked by `checkFinishEvidence` (files on the
   * leader's disk, messages in THIS room, assignments reported on THIS board); every failure
   * is returned at once so the model can fix them in one retry. Three consecutive rejections
   * for the same leader+board are the deadlock guard: the third one closes the task with
   * `gate: 'bypassed'` and a visible notice saying it is UNVERIFIED.
   *
   * `workspaceRoot` is the leader's real working directory (`runWorkspaceDir`): a relative
   * evidence path means "the file the bot actually wrote", not a path relative to the server.
   */
  private gateFinishTask;
  /**
   * OP-18 reputation watchdog: derive per-bot completion rates from THIS room's board and,
   * when a bot is genuinely below the threshold with enough samples, write one notice.
   * Advisory only — no roster/assignment/run is changed, and the cooldown lives in memory.
   */
  private maybeWarnReputation;
  /**
   * Fold the settle's inputs into the run's evidence record (OP-04).
   *
   * Pure apart from reading the request: the executor supplies counters, this adds what only
   * the service knows — the wall-clock duration up to settle and the REAL finish path (a
   * `finish_task` report is `finish_task`, not just `reply`). A failed run also gets its
   * `faultSide`, which is persisted both on the run and inside the evidence.
   */
  private finalizeRunEvidence;
  /** Remember a `finish_task` report until its run settles (see `pendingFinishReports`). */
  private recordFinishReport;
  /** Take (and forget) the finish report belonging to one run, if it called finish_task. */
  private takeFinishReport;
  /**
   * Make the ledger show exactly one finished delivery row for a run.
   *
   * The row id is derived from the run id (`run:<id>:bot-text`), so a visible run's row
   * already exists — the executor reserves it before the turn — and is finalised here with
   * the delivered body and its duration. An internal run has no row at all (every writer
   * skipped it), so the report it delivered is pushed here. Either way the panel shows one
   * row per run, with the same metadata a reload would rebuild from the message.
   */
  private writeDeliveredRow;
  /**
   * Test seam: ask a question exactly as the tool does, without a model turn.
   *
   * Kept deliberately on the service (the harness constructs a real service and drives the real
   * bridge) so the flow is asserted end-to-end rather than through a mock.
   */
  /** The user answered (or dismissed) a bot's question. */
  answerBotQuestion(input: AnswerBotQuestionRequest): Promise<{
    ok: boolean;
    reason?: string;
  }>;
  /** Reminders this plugin owns (for tests and for the panel's future schedule view). */
  listBotSchedules(): readonly BotSchedule[];
  /**
   * Take over host reminders bound to this plugin's sessions.
   *
   * The host cannot deliver them at all — its resolver refuses `origin: "subagent"` sessions —
   * so the row is imported and then DELETED: leaving it would mean the host keeps a reminder it
   * will never deliver, and the user would see a task in 自动化任务 that never fires.
   */
  private importHostSchedules;
  /**
   * Fire every reminder whose time has come, through the plugin's own run pipeline.
   *
   * The run goes into the ROOM, which is what a reminder like "send 你好 in the room" wants: the
   * bot's turn happens where the user can see it, instead of inside a hidden session.
   */
  private fireBotSchedules;
  /** Enqueue one host effect, deduplicated by kind+key (the latest intent wins). */
  private enqueueOutbox;
  /** Coalesce file writes: a drain can settle several effects at once. */
  private scheduleOutboxSave;
  /** Write the queue atomically. A write failure is logged, never thrown (startup must survive). */
  private flushOutbox;
  /** Load the queue; a missing file is empty and a damaged one keeps its usable entries. */
  private loadOutbox;
  /**
   * Run due effects once. Never throws: a failed effect is rescheduled with backoff, and one that
   * exhausts its attempts is dropped with a health failure — never retried forever, never silent.
   */
  private drainOutbox;
  private drainOutboxOnce;
  /**
   * Settle the host row once this plugin has delivered the reminder.
   *
   * Best-effort wrapper for the legacy direct path (outbox disabled); the durable path calls
   * {@link settleHostRowStrict} so a failure is retried instead of swallowed.
   */
  private settleHostRow;
  /**
   * The actual host call. Throws on a transient host failure so the caller (outbox) can retry.
   *
   * The host delivered nothing, so it cannot record a receipt: a finished one-shot would sit in
   * 自动化任务 as a permanently "active" reminder that never fires again, so it is removed. A
   * recurring reminder is re-timed to its next occurrence instead, which keeps it visible in that
   * page with a correct upcoming time — and the host's own delivery attempt for the old instant
   * simply fails and is forgotten (it does not retry refused admissions).
   */
  private settleHostRowStrict;
  /**
   * Unread bot messages per room, derived from each room's read water mark.
   *
   * `roomReadAt[room]` is the highest message sequence the user has seen; everything ABOVE it that a
   * bot sent (or another bot relayed — anything that is not the user's own line) is unread. Messages,
   * not ledger rows: the room's own list is what the number has to agree with, and it counts a native
   * run's answer and a tool-posted message exactly once each.
   */
  private unreadByRoom;
  /**
   * Unread totals for the plugin's sidebar entry — ONE tiny read, no messages attached.
   *
   * The entry badge is visible on every DSH screen, but the panel that computed it only exists while
   * the plugin is the foreground panel. Updating it from the panel's own snapshot poll therefore
   * stopped the moment the user switched to another panel: a reply that finished while they were
   * elsewhere left the old number on screen. A background poller calls THIS instead, so the count
   * tracks reality regardless of what is on screen.
   */
  unreadTotals(): {
    readonly total: number;
    readonly rooms: Readonly<Record<string, number>>;
  };
  /**
   * What one Bot remembers about ONE room.
   *
   * THE ONLY READ PATH, and it takes the pair on purpose: no caller can obtain "everything this
   * bot remembers" and therefore cannot mix a 1:1 task into a group (or one group into another).
   * The prompt builder is the only consumer.
   */
  botMemoryFor(roomId: string, botId: string): readonly BotMemoryEntry[];
  /**
   * The two LONG-LIVED partitions this Bot reads every turn: its own ([Bot 长期记忆]) and the
   * team's ([团队记忆]).
   *
   * Bot-keyed like `botMemoryFor` and for the same isolation reason: no caller can ask for
   * another bot's long-term memory, so one bot's preference never leaks into another's prompt.
   * The team partition is the deliberate exception — it is written for the whole team.
   */
  longTermMemoryFor(botId: string): {
    readonly bot: ReadonlyArray<{
      readonly text: string;
      readonly at?: string | undefined;
    }>;
    readonly team: ReadonlyArray<{
      readonly text: string;
      readonly at?: string | undefined;
    }>;
  };
  /**
   * Record one deliberate note for the calling Bot, in the room its SESSION belongs to.
   *
   * The room is derived from the session id and is not a parameter: a model that passes someone
   * else's room id must not be able to write there, and taking the room from the session is what
   * makes that impossible rather than merely refused. Same rule as the read path, from the other
   * side.
   */
  rememberForSession(input: {
    readonly sessionId: string;
    readonly text: string;
    /** room (default) = this room; bot = this Bot's cross-room memory; team = shared rules. */
    readonly scope?: 'room' | ScopedMemoryScopeName | undefined;
  }): Promise<{
    readonly ok: boolean;
    readonly reason?: string | undefined;
    readonly scopeLabel?: string | undefined;
  }>;
  /**
   * One memory write, whichever scope names it — the only place the three scopes diverge.
   *
   * Authority lives HERE, not in the tool description: the team partition is written only by the
   * room's leader (or the user through the panel), because a member writing team rules would be
   * one Bot editing every other Bot's prompt. The bot and room scopes belong to the caller.
   */
  rememberScoped(input: {
    readonly roomId: string;
    readonly botId: string;
    readonly text: string;
    readonly scope: 'room' | ScopedMemoryScopeName;
  }): Promise<{
    readonly ok: boolean;
    readonly reason?: string | undefined;
    readonly scopeLabel?: string | undefined;
  }>;
  /** Append one line to a long-lived partition and refresh its mirror from the file. */
  private appendScopedEntry;
  /**
   * The panel has this room on screen: everything in it is read.
   *
   * Recorded as the room's newest message sequence, so a message that arrives later is unread again
   * while nothing already displayed can become unread retroactively.
   */
  markRoomRead(input: MarkRoomReadRequest): Promise<{
    readonly roomId: string;
    readonly cleared: boolean;
  }>;
  /**
   * This room's goal, or undefined.
   *
   * The ONLY read path, keyed by the room it is given: there is no "all goals" accessor, so no
   * caller can mix two rooms' objectives — the same structural rule the memory partitions use.
   */
  roomGoal(roomId: string): RoomGoal | undefined;
  /** The `[本房间目标]` block for a turn, or undefined when the room has no goal. */
  roomGoalBlock(roomId: string): string | undefined;
  /**
   * The `[本房间必须遵守的硬性约束]` block for a turn, or undefined when nothing is pinned.
   *
   * OP-03. These are the user's own hard rules, extracted verbatim when a compaction folded the
   * messages they were stated in. Rendering them into EVERY turn's prompt (rather than only
   * inside the summary row, which ages out of the window) is what makes "压缩不丢约束" true at
   * the prompt level. Room-keyed like the goal/memory accessors: a rule pinned in one room can
   * never be rendered for another.
   */
  roomConstraintsBlock(roomId: string): string | undefined;
  /**
   * The `[本群经验卡]` block for a room (OP-09).
   *
   * Built from the deterministic pattern cards this room accumulated on previous finishes.
   * Returns undefined when the room has none, so an unused group pays zero prompt cost.
   */
  roomPatternsBlock(roomId: string): string | undefined;
  /**
   * Learn a pattern card from a finished task (OP-09).
   *
   * The task comes from the room's board objective, falling back to the newest user message —
   * i.e. what the user actually asked for, not a bot's paraphrase. `report` supplies the
   * approach/pitfalls and the finish evidence supplies references. One `patchRoom` = one state
   * update (and one coalesced write).
   */
  private recordGroupPatternCard;
  /**
   * 2026-11-09: condense the group experience card when it approaches its cap.
   *
   * One hidden leader turn, marked `experienceRefine` and published `internal`; settleRun stores
   * its text on the room and never publishes it. A per-room cooldown and the in-flight check keep
   * a busy room from spawning one condense turn per finish.
   */
  private maybeRefineExperience;
  /**
   * 2026-11-09: user-triggered "condense the group experience now".
   *
   * Useful before the card reaches the automatic 80% trigger, and as a deterministic way to
   * exercise the hidden condense turn on a real host. It goes through the same
   * `maybeRefineExperience` path (internal leader run, never published, 30-min guard).
   */
  compactGroupExperience(input: CompactExperienceRequest): Promise<CompactExperienceResult>;
  /** Remove one learned experience card from a room (user management; no prompt side effects beyond). */
  deleteRoomPattern(input: RoomPatternRequest): Promise<{
    ok: boolean;
    reason?: string;
  }>;
  /** Confirm a pending card (from a bypassed finish) so it may enter the prompt. */
  confirmRoomPattern(input: RoomPatternRequest): Promise<{
    ok: boolean;
    reason?: string;
  }>;
  /**
   * Save the room's ONE editable experience card. Manual text wins over auto-generation; an
   * empty string is a deliberate clear (and suppresses the legacy fallback).
   */
  updateRoomExperience(input: UpdateRoomExperienceRequest): Promise<{
    ok: boolean;
    reason?: string;
  }>;
  /** What this room was asked to do: the board objective, else the newest user message. */
  private patternTaskText;
  /**
   * Warn ONCE per room per window when a completed answer looks off-goal (OP-13).
   *
   * Advisory only: writes a visible notice and nothing else. It never pauses the goal, cancels
   * a run or spends a round — the user (or a later, authorized round) decides what to do.
   */
  private maybeWarnGoalDrift;
  /**
   * In-session failure diagnosis: ONE plain grey line in the room that explains a failure.
   *
   * This replaced the settings-page run-diagnostics panel: the reason is useful exactly where
   * the failure is visible. The line is built by the pure `diagnoseRunFailure` (cause + short
   * error detail + largest context section) and deliberately contains none of the words the UI
   * uses for its coloured, actionable rows (建议复盘/审计/目标可能偏移/bypass).
   *
   * Deduplicated per run id (settles can be observed twice), and nothing else: no retry, no
   * pause, no task changes.
   */
  private maybeDiagnoseRun;
  /**
   * Create, edit, pause, resume or finish THIS room's goal.
   *
   * Authority has TWO layers, and the second one is the fix for "the bot started working
   * without me":
   *
   *   · WHO MAY TOUCH THE OBJECTIVE — decided here, as before: in a group only the leader (or
   *     the user); in a 1:1 the room's bot may. The room comes from the calling session, so a
   *     model cannot name another room's goal.
   *   · WHO MAY MAKE IT RUN BY ITSELF — the USER only. A bot's `set`/`resume` becomes
   *     `status:'proposed'` (a suggestion, inert until authorized); it can only refresh the
   *     text of a goal that is already active under a live user grant, preserving that grant
   *     and its spent rounds. `pause`/`done` stay allowed.
   */
  setRoomGoal(input: {
    readonly roomId: string;
    readonly text?: string | undefined;
    readonly status?: 'active' | 'paused' | 'done' | undefined;
    /** Which tool action this is, for a Bot caller; the legacy status-only call defaults to 'set'. */
    readonly action?: BotGoalAction | undefined;
    readonly actorSessionId?: string | undefined;
    readonly maxRounds?: number | undefined;
  }): Promise<{
    readonly ok: boolean;
    readonly goal?: RoomGoal | undefined;
    readonly reason?: string | undefined;
  }>;
  /**
   * Start the FIRST authorized round, or explain why it is not starting yet.
   *
   * A grant would otherwise be useless until something else settled: a bot proposes a goal
   * near the end of its turn, the turn settles (nothing to continue), and the goal the user
   * just authorized would sit active-but-idle until the user typed again. Authorizing is the
   * user's explicit "go", so the grant itself kicks off round 1.
   *
   * THREE CASES, and only one of them queues:
   *   · a live run in the room → authorize only. That run's settle continues the goal through
   *     `afterRunSettled`; queueing now would race its bookkeeping and could duplicate work.
   *   · the room is paused → queueRoomRun refuses every source (returns undefined): authorize,
   *     spend nothing, and say so.
   *   · otherwise → queue round 1 now and count it HERE. `afterRunSettled` counts only the
   *     rounds it queues itself, so the first round is spent exactly once.
   */
  private startFirstAuthorizedRound;
  /**
   * USER-ONLY: grant automatic continuation for this room's goal.
   *
   * Carries no `actorSessionId` at all, which is what keeps a Bot out: the panel is the only
   * caller. This is the one act that turns a Bot's proposed goal (or a paused one) into work
   * the plugin may continue without a new user message — and it starts round 1 immediately
   * (see `startFirstAuthorizedRound`).
   */
  authorizeRoomGoal(input: {
    readonly roomId: string;
    readonly maxRounds?: number | undefined;
  }): Promise<{
    readonly ok: boolean;
    readonly goal?: RoomGoal | undefined;
    readonly reason?: string | undefined;
  }>;
  /** USER-ONLY: pause this room's goal; no automatic continuation until an explicit resume. */
  pauseRoomGoal(input: {
    readonly roomId: string;
  }): Promise<{
    readonly ok: boolean;
    readonly goal?: RoomGoal | undefined;
    readonly reason?: string | undefined;
  }>;
  /**
   * USER-ONLY: resume a paused goal, starting its next authorized round immediately.
   *
   * A grant with rounds left is kept as-is (resume is not a top-up); a spent/expired grant is
   * replaced with a fresh one, because resuming IS an explicit user authorization. Either way
   * the resumed round is queued now unless the room has live work / is paused (the shared
   * helper owns those cases and the single count of that round).
   */
  resumeRoomGoal(input: {
    readonly roomId: string;
    readonly maxRounds?: number | undefined;
  }): Promise<{
    readonly ok: boolean;
    readonly goal?: RoomGoal | undefined;
    readonly reason?: string | undefined;
  }>;
  /**
   * Queue work for several members and return IMMEDIATELY (§4.1).
   *
   * Nothing waits here: the leader's own answer this turn is the progress report, and the
   * plugin wakes it again through `onMemberFinished` when the members settle. An earlier
   * design blocked the leader's run for up to ten minutes, which raced the run timeout —
   * also ten minutes — and dropped the reports whenever the timeout won.
   */
  dispatchToMembers(input: {
    readonly roomId: string;
    readonly actorSessionId?: string | undefined;
    readonly tasks: readonly DispatchTask[];
    /** The leader says every dispatched task must produce a file. */
    readonly requiresDeliverables?: boolean | undefined;
    readonly waitMs?: number | undefined;
  }): {
    readonly ok: boolean;
    readonly queued: readonly string[];
    readonly refused: ReadonlyArray<{
      readonly bot: string;
      readonly reason: string;
    }>;
    readonly reason?: string | undefined;
  };
  /**
   * What every member of this room is doing right now (the leader's `list_bots` tool).
   *
   * DERIVED, never stored: runs in this room say who is working/queued, the approval bridge
   * says who is blocked on the user, the persisted task board says what each member was
   * assigned, and the mailbox says who has unread messages. A stored presence flag would drift
   * from all four within one turn.
   */
  listBotsPresence(roomId: string): readonly MemberPresenceView[];
  /** The meta a partition file records about itself; undefined when room or bot is gone. */
  private memoryMetaFor;
  /**
   * One write, through the store, updating the mirror only when the file really changed.
   *
   * THE MIRROR AFTER THE FILE, never before: a failed write must not leave the prompt believing
   * something was remembered.
   */
  private memoryWrite;
  /**
   * Record what a finished turn did, then look for something worth learning (§3.3).
   *
   * OP-08 lifecycle, in order:
   *   1. DECAY what the user has since corrected (same task family, last 3-task window). That is
   *      an IN-PLACE edit of existing entries, so the partition must be REWRITTEN
   *      (`writePartition`), not appended to; the mirror is refreshed from the file afterwards.
   *      A failed rewrite is logged and does not block the new line: the decay is best-effort
   *      maintenance, losing a new memory is worse.
   *   2. APPEND this turn's line, carrying provenance from the run's origin (user-driven runs are
   *      active/positive; peer-woken and timer turns are probation/unknown).
   *   3. PROMOTE, now gated by `promotable` inside the scanner.
   *
   * Promotion runs here — after the task line exists — because both of its channels need the
   * run-backed history this line completes.
   */
  private rememberTask;
  /**
   * Move what this pair has LEARNED into the bot's own instruction file.
   *
   * Only run-backed candidates get here (the scanner decides), and the block is inside a file
   * the user owns: everything outside the markers is preserved, human-edited lines are never
   * rewritten, and an identical line is never added twice.
   */
  private promoteIfEarned;
  /**
   * Startup: load the mirror, and migrate a board that still carries the old inline field.
   *
   * The migration is idempotent: it writes files only for entries the store does not already
   * have, then clears the field, so a crash halfway through leaves a board that migrates again
   * on the next boot instead of losing the entries.
   */
  private loadMemory;
  /**
   * Load the two long-lived memory partitions before any prompt can use them.
   *
   * Missing files are empty partitions (that is the normal state before the first write), and the
   * store never throws; a failure here would only cost long-term context, so each half is
   * best-effort with a log line rather than a startup failure.
   */
  private loadScopedMemory;
  /**
   * Archive a room's memory instead of deleting it (the room is gone, the knowledge is not).
   *
   * Called BEFORE the room record disappears, because the member list is what says whose
   * partitions to move.
   */
  private archiveRoomMemory;
  /**
   * Archive a bot's GROUP partitions before it is deleted.
   *
   * The user's rule for deleting a bot is "erase it from the device", with one exception: what
   * it wrote inside a group belongs to that group. Those files move to `_archive/<roomId>/`,
   * which is OUTSIDE the bot's directory — so the deletion that follows cannot take them with
   * it. Direct-chat partitions are not archived: a DM is the bot's own memory.
   */
  private archiveBotGroupMemory;
  /** The bot's own workspace, used when a bot record has none. */
  private defaultBotWorkspace;
  /**
   * Search THIS room's memory (and the bot's learned lines) for entries matching a query.
   *
   * The result carries PROVENANCE — file, timestamp, run id — because the whole point of the
   * feature is that the model can go back to what actually happened instead of trusting a
   * summary. Scoped to the caller's own room, like every other memory read.
   */
  recallMemory(input: {
    readonly roomId: string;
    readonly botId: string;
    readonly query: string;
    readonly limit?: number | undefined;
  }): Promise<{
    readonly hits: ReadonlyArray<{
      readonly text: string;
      readonly at: string;
      readonly runId?: string | undefined;
    }>;
    /** Matching lines from this Bot's cross-room memory ([Bot 长期记忆]). */
    readonly bot: ReadonlyArray<{
      readonly text: string;
      readonly at?: string | undefined;
    }>;
    /** Matching lines from the shared team rules ([团队记忆]). */
    readonly team: ReadonlyArray<{
      readonly text: string;
      readonly at?: string | undefined;
    }>;
    readonly learned: readonly string[];
    readonly path: string;
  }>;
  /** One `(room, bot)` partition as the panel shows it: the entries plus their change journal. */
  listRoomMemory(input: ListRoomMemoryRequest): Promise<RoomMemoryView>;
  /** Edit one entry's text. The text is redacted BEFORE the store sees it (same rule as writes). */
  updateRoomMemory(input: UpdateRoomMemoryRequest): Promise<MemoryMutationResult>;
  /** Delete one entry. The store journals the removal, so the panel can offer undo. */
  deleteRoomMemory(input: DeleteRoomMemoryRequest): Promise<MemoryMutationResult>;
  /** Undo one recorded change. `journalId` names the row the list RPC returned. */
  revertRoomMemory(input: RevertRoomMemoryRequest): Promise<MemoryMutationResult>;
  /**
   * Run one store mutation and re-sync the mirror from the file afterwards.
   *
   * Shared by the three mutation RPCs so they cannot drift on the two rules above (existence
   * check, mirror after the file, errors as values). The action receives the resolved meta the
   * store needs, so no RPC builds its own file-path meta.
   */
  private memoryMutation;
  /** One long-lived partition and its undo journal. Throws for an impossible request. */
  listScopedMemory(input: ListScopedMemoryRequest): Promise<ScopedMemoryView>;
  /** Replace one line of a long-lived partition; the store journals before/after for undo. */
  updateScopedMemory(input: UpdateScopedMemoryRequest): Promise<MemoryMutationResult>;
  /** Delete one line of a long-lived partition. Undoable through the journal. */
  deleteScopedMemory(input: DeleteScopedMemoryRequest): Promise<MemoryMutationResult>;
  /** Undo one recorded change in a long-lived partition. */
  revertScopedMemory(input: RevertScopedMemoryRequest): Promise<MemoryMutationResult>;
  /**
   * Resolve the partition a request addresses, refusing a bot scope without a live bot.
   *
   * A missing/existing-bot check here (not in the pure validator) is deliberate: the validator
   * only sees the request, and a bot id that names nothing must not silently write into whatever
   * partition a default would pick.
   */
  private scopedTarget;
  /**
   * Run one scoped store mutation, re-sync that partition's mirror afterwards, and turn a
   * failure into `{ok:false,error}` (the panel shows it; it must not become a thrown 500).
   */
  private scopedMutation;
  /** Re-read one long-lived partition from its file into the prompt mirror. */
  private refreshScopedMirror;
  /** The goal-writing actor for one call: a plugin bot session, or the user. */
  private goalActor;
  /** Replace one room immutably and persist. No-op when the room is gone. */
  private patchRoom;
  /** Open a round for one group instruction, superseding any round still in flight. */
  private beginUserRound;
  /** Persist the room's current round (or clear it). */
  private setRoomRound;
  /**
   * Re-hydrate persisted rounds on startup.
   *
   * A round that is still `open` when the process starts can never settle: its runs were the
   * previous process's, and the startup sweep cancels those without a per-run settle callback.
   * So an open round is closed as `interrupted` (never revived), while settled rounds from the
   * last instruction are kept — they are the dock's receipt until the next instruction replaces
   * them. Corrupt rows are dropped rather than trusted (see `parseRoundState`).
   */
  private recoverRounds;
  /** Bot display names of a round's participants, in participant order. */
  private roundNames;
  /** Bot display name, with the raw id as the fallback (a deleted bot must not print blank). */
  private botNameOf;
  /** A claimed run belongs to the open round: mark its participant as running (idempotent). */
  private noteRoundRunStarted;
  /** The pure settle decision for a finished run, or undefined when the run is not in a round. */
  private decideRoundForRun;
  /**
   * Persist one round transition and act on it: PASS is silent, the closing batch calls the
   * leader in EXACTLY once, and the transcript gets a grey row for both.
   */
  private commitRoundDecision;
  /** A removed member will never settle its run: record the round participant as failed. */
  private forgetRoundMember;
  /** The prompt for the single leader integration turn that closes a parallel round. */
  private roundIntegratePrompt;
  /**
   * Everything that follows a settled run: the leader's hand-off integration, and the room
   * goal's progress/stall bookkeeping.
   *
   * Deliberately NOT async and never awaited by `settleRun`: a settle must not depend on an
   * enqueue that itself may fail, and the run's own state is already durable at this point.
   */
  private afterRunSettled;
  /**
   * One leader turn closed: spend a round of the task budget and move the stall clock.
   *
   * WHY HERE AND NOT IN THE DRIVER: the budget lives on the persisted board
   * (`room.taskState.round`, compared against `maxRounds` by `group-flow.advanceRound`), and
   * the stall guard lives in the driver. A leader turn is the unit both count, and the only
   * signal that a turn ended is its run settling — so this is the joint point.
   *
   * Two stop conditions, both ending automation without `finish_task` (the room is told,
   * the driver closes its board, no further integration turn can start):
   *   · the round budget is exhausted (`round > maxRounds`, §5.5);
   *   · nothing moved for three consecutive leader turns (`onLeaderIdle`).
   *
   * A hand-made group may carry no `team.leader`; the board refuses the advance and the
   * fallback leader still coordinates, so that is not an error — the stall guard still runs.
   */
  private afterLeaderTurnSettled;
  /**
   * The panel's poll payload — TRIMMED, because it is polled every 400 ms.
   *
   * The transcript, reasoning, tool cards and deliverables all reach the panel through the
   * LEDGER (an incremental cursor), not through this snapshot; what the snapshot's messages
   * are actually used for is the unread water mark (newest id/createdAt per room) and nothing
   * else. Serializing the whole community here — every message's reasoning and tool output,
   * every run's full prompt — put megabytes on the wire for fields no surface reads.
   *
   * `summarizeSnapshot*` are structural copies, so a heavy field added later cannot leak into
   * the payload by accident. The declared return type stays `BotCommunitySnapshot` (the state
   * schema is unchanged); the two arrays now carry the documented lite subset, which is a
   * superset of every field the panel reads.
   */
  snapshot(): BotCommunitySnapshot;
  getBotPresence(botId: string): BotPresence;
  /**
   * Return up to `limit` ledger entries before `beforeSequence`.
   * Clients use this for initial load and "load earlier" pagination.
   *
   * NOTE: the signature must stay plain identifiers only. The Typert Gateway
   * validates SRC-mode Remote methods and rejects any parameter with a default
   * value ("must use unique identifier parameters without destructuring,
   * defaults, or rest"), which failed the whole method with
   * `gateway/signature-invalid`. The `{}` default now lives in the body.
   */
  /** The host skill registry, when this DSH build provides one. */
  /**
   * The host skill registry.
   *
   * Cordis exposes services as typed properties gated by `static inject`, which is
   * why `ctx.get('skills')` could never resolve here — the native providers use
   * `ctx.skills` and so must we. Optional in the type because a DSH build without
   * the skill packages still runs the rest of the plugin.
   */
  private skillsRegistry;
  /**
   * Load a skill's full text.
   *
   * This is what gives skills "strong" semantics: the menu can invoke one directly
   * and the text lands in the conversation, instead of the bot only being told the
   * skill exists.
   */
  loadSkill(roomId: string, name: string): Promise<{
    name: string;
    content: string;
  } | undefined>;
  /**
   * Discover the skills available to a room's bot.
   *
   * Skills follow the same on-disk convention the host uses: a `SKILL.md` file with
   * a YAML frontmatter block holding `name` and `description`, found under
   * `.dsh/skills/<dir>/` or `.agents/skills/<dir>/` inside the bot's workspace.
   * Reading them from disk keeps the plugin's skills declarative — dropping a file
   * in the workspace is all it takes to add one.
   */
  /**
   * Shallow listing of one skill directory.
   *
   * The model needs to know which reference files exist; without this it explored
   * with bash/glob, which was slow and wandered outside the workspace (raising a
   * macOS folder-access prompt). One listing removes that whole round trip.
   */
  listSkillFiles(dir: string): Promise<Array<{
    path: string;
    isDir: boolean;
  }>>;
  listSkills(roomId: string): Promise<Array<{
    id: string;
    name: string;
    description: string;
    path: string;
  }>>;
  /**
   * Cached skills for a room, for synchronous callers such as the prompt builder.
   *
   * Never blocks and never throws: a stale entry is served while a background scan
   * runs, and a missing one returns empty for this round and fills in for the next.
   */
  listSkillsSync(roomId: string): SkillEntry[];
  /**
   * The `[可用技能]` block for one bot (§5.3 prompt 三态): the profile's picks first,
   * then the full name list, plus the explicit note that any skill can be loaded.
   *
   * Exposed for the prompt builder; undefined when the room has no skills, so a
   * skill-less room's prompt is byte-identical to before.
   */
  skillPromptFor(roomId: string, botId: string): string | undefined;
  /** Force a profile re-analysis (background, never throws). */
  refreshSkillProfile(roomId: string, botId: string): Promise<void>;
  /**
   * The bot's profile when it still matches its identity AND the room's skill set.
   *
   * Undefined means "stale": the prompt then serves the full list and re-analyses in
   * the background. Exposed so callers (and the acceptance harness) can see the
   * freshness decision rather than infer it from prompt text.
   */
  currentSkillProfile(roomId: string, botId: string): BotSkillProfile | undefined;
  /** Signature of the room's current skill set, for diagnostics and tests. */
  skillSignature(roomId: string): string | undefined;
  /** Re-scan every room's skills; called at startup so the cache is warm. */
  private refreshSkillCache;
  listLedger(roomId: string, opts?: {
    beforeSequence?: number;
    afterSequence?: number;
    changedAfterSequence?: number;
    /** Monotonic change cursor; unlike sequence it also re-delivers patched old rows. */
    changedAfterChangeSeq?: number;
    limit?: number;
    /** Ignore cursors and return the room's current rows. */
    force?: boolean;
  }): LedgerEntry[];
  /**
   * Replay every room's durable journal on top of the message rebuild (P4 startup).
   *
   * ORDER MATTERS: `seedLedgerFromState` runs first (messages are the authority for user/bot
   * text), then journal rows are merged by id so only rows the rebuild cannot produce are
   * added. After the merge the journal is COMPACTED to exactly those rows — the append log
   * keeps every patch, so without this a busy room grows without bound.
   */
  private recoverLedgerJournals;
  /**
   * Load every stored room knowledge document into the prompt cache.
   *
   * Only EXISTING files are read; a missing room is simply "no knowledge". Failures are logged
   * and skipped — a damaged knowledge file must never stop the plugin from starting.
   */
  private preloadRoomKnowledge;
  /**
   * The `[本房间知识]` block for a turn, or undefined when this room has no knowledge.
   *
   * Synchronous by contract (the prompt builder is sync): reads the startup/RPC-maintained
   * cache. The header is added here so one place owns the prompt wording.
   */
  roomKnowledgeBlock(roomId: string): string | undefined;
  /** Read this room's knowledge for the settings panel (P5-2). */
  getRoomKnowledge(roomId: string): Promise<{
    readonly ok: boolean;
    readonly content?: string | undefined;
    readonly chars?: number | undefined;
    readonly reason?: string | undefined;
  }>;
  /**
   * Save this room's knowledge (P5-2). Whitespace-only content CLEARS it (removes the file)
   * rather than storing an empty document — an empty document must never reach a prompt.
   */
  setRoomKnowledge(roomId: string, content: string): Promise<{
    readonly ok: boolean;
    readonly chars?: number | undefined;
    readonly reason?: string | undefined;
  }>;
  /**
   * Export ONE room's ledger as a downloadable text blob.
   *
   * THE FORMATS ARE DELIBERATELY DIFFERENT TOOLS:
   *   · json / jsonl — the FULL rows (thinking, tool calls, approvals included), for archival
   *     or a replay tool that needs the whole record;
   *   · markdown / transcript — a READ-ONLY share document that defaults to dropping thinking,
   *     tool details and coordination rows, so pasting it somewhere does not leak the internal
   *     workings of the bots.
   *
   * The rows come from `listLedger(force)` so an export is exactly what the panel shows, not a
   * second projection that could disagree with it.
   */
  exportLedger(roomId: string, format: string): {
    readonly ok: boolean;
    readonly content?: string | undefined;
    readonly filename?: string | undefined;
    readonly reason?: string | undefined;
  };
  /**
   * Called by the client when the user clicks Allow/Reject on an approval card.
   * Routes the decision to the ApprovalBridge which resolves the pending promise.
   */
  /**
   * The user answered an approval card.
   *
   * Returns a RECEIPT rather than void: a card whose dialog no longer exists (already answered,
   * expired on a timer, or from a process that has since restarted) used to make the click
   * silently do nothing. The panel can now say so.
   */
  approveBotToolCall(callId: string, outcome: 'allowed-once' | 'rejected'): {
    readonly ok: boolean;
    readonly reason?: string | undefined;
  };
  /**
   * Return visibility records for all known bot sessions.
   * The UI surfaces sessions with lastError so users can trigger a retry.
   */
  getSessionVisibility(): SessionVisibilityRecord[];
  /**
   * Trigger a full reconcile of session visibility.
   * Idempotent — safe to call from a UI retry button.
   */
  reconcileSessionVisibility(): Promise<void>;
  private readonly maintenance;
  private maintenanceHost;
}
//#endregion
export { type AbstainRequest, type AdmissionMode, AgentCommunityService, AgentCommunityService as default, type AnswerBotQuestionRequest, type AssignTasksRequest, type BotAvatar, type BotCommunitySnapshot, type BotConnectionState, type BotId, type BotIdentity, type BotMailboxItem, type BotMemoryEntry, type BotMemoryRecord, type BotMessage, type BotMessageAttachment, type BotMessageId, type BotMessageSenderKind, type BotMessageUsage, type BotPresence, type BotProfileBinding, type BotRoom, type BotRoomAdmission, type BotRoomAssessment, type BotRoomId, type BotRoomNotice, type BotRoomPolicy, type BotRoomSpeculation, type BotRun, type BotRunId, type BotRunStatus, type BotSkillProfile, type BotTask, type BotTaskStatus, type BotTeam, type BotTeamLeader, type BotTeamMembership, type BotTeamMessageKind, type BotTeamRunOrigin, type CompactExperienceRequest, type CompactExperienceResult, Config, type ConfirmGroupRequest, type ControlBotRunRequest, type CreateBotRequest, type CreateRoomRequest, type CreateTeamRequest, type DeclineGroupRequest, type DecomposeTasksRequest, type DeleteBotRequest, type DeleteRoomMemoryRequest, type DeleteRoomRequest, type DeleteScopedMemoryRequest, type DeliveredFile, type DismissTeamRequest, type FinishEvidence, type FinishTaskRequest, type GroupPatternCard, type GroupProposal, type HarnessAttribution, type LedgerEntry, type ListRoomMemoryRequest, type ListScopedMemoryRequest, type MarkRoomReadRequest, type MemoryMutationResult, type NoticeRoomRequest, type OpenWorkItem, type OpenWorkKind, type OpenWorkRoom, type OpenWorkView, type PendingGroupProposal, type PostBotMessageRequest, type PostTeamMessageRequest, type ProposeGroupRequest, type RemoveBotsRequest, type ReportTaskRequest, type RetryBotRunRequest, type RevertRoomMemoryRequest, type RevertScopedMemoryRequest, type RoomExperienceCard, type RoomGoal, type RoomGoalAuthorization, type RoomMemoryView, type RoomPatternRequest, type RoomTaskAssignment, type RoomTaskState, type RunEvidence, type RunFaultSide, type RunFinishPath, type ScopedMemoryEntryView, type ScopedMemoryJournalRow, type ScopedMemoryScopeName, type ScopedMemoryView, type SendRoomMessageAttachment, type SendRoomMessageRequest, type SettleBotRunRequest, type SpeculationMode, type SubmitFinalRequest, type TeamApproval, type TeamApprovalAnswer, type TeamMessageResult, type TeamOverview, type ThreadSubscription, type ThreadSubscriptionAuthority, type ThreadSubscriptionSource, type UpdateBotRequest, type UpdateRoomExperienceRequest, type UpdateRoomMemoryRequest, type UpdateRoomRequest, type UpdateScopedMemoryRequest, name };