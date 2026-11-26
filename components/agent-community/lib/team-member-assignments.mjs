import { apply, digest, effectiveMembers } from "./team-machine.mjs";
import { requestText } from "./team-chat-routing.mjs";

const clauseLead = /^(?:(?:请|由|让|先|再|随后|然后|最后|接着|安排)\s*)+/u;
const workLead = /^(?:(?:请|帮我|负责|来|先|再|最后)\s*)+/u;
const action = /^(整理|梳理|编写|拟定|撰写|核对|复核|检查|验证|验收|汇总|总结|统计|分析|设计|制定|修改|修复|补充|完成|制作|准备|执行|输出|确认|对照|列出|给出|回复|读|查|写|做)/u;
const shortName = bot => bot?.name?.split(/--|——/u).at(-1)?.trim() || "成员";

export function parseMemberAssignments(text, roster) {
  const aliases = new Map();
  for (const bot of roster) {
    for (const label of new Set([bot.name?.trim(), shortName(bot)])) {
      if (!label || label === "成员") continue;
      const owners = aliases.get(label) ?? new Set();
      owners.add(bot.id);
      aliases.set(label, owners);
    }
  }
  const labels = [...aliases.keys()].sort((a, b) => b.length - a.length);
  const body = requestText(text).replace(/^(?:请)?(?:按以下分工|分工如下|各自完成)[:：]\s*/u, "");
  const clauses = body.split(/[，,；;。！!\r\n]+|→/u).map(clause => clause.trim()).filter(Boolean);
  const assignments = [];
  for (const clause of clauses) {
    if (/^[「『“"'\x60>|]/u.test(clause)) continue;
    const nameFirst = clause.replace(clauseLead, "").replace(/^@/u, "");
    const label = labels.find(value => nameFirst.startsWith(value));
    if (!label) continue;
    const owners = aliases.get(label);
    let tail = nameFirst.slice(label.length).replace(/^[\s:：]+/u, "");
    const wait = tail.match(/^等(?:待)?(.+?)(?:交稿|交付|回复|完成|提交)(?:之)?后\s*/u);
    if (wait) tail = tail.slice(wait[0].length);
    const sequenced = /^(?:再|随后|然后|最后|接着)/u.test(clause) || /^(?:再|最后)/u.test(tail);
    const work = tail.replace(workLead, "").trim();
    const verb = work.match(action)?.[1];
    if (!verb || /[？?]/u.test(work) || /^(?:了|过|的|得|完了?吗)/u.test(work.slice(verb.length))) continue;
    const dependencies = wait ? wait[1].split(/和|与|及|、|\s+/u).filter(Boolean) : [];
    const dependsOn = dependencies.map(name => {
      const sources = aliases.get(name.trim().replace(/^@/u, ""));
      return sources?.size === 1 ? [...sources][0] : null;
    });
    if (!wait && (sequenced || /^(?:汇总|总结)$/u.test(work))) dependsOn.push(...assignments.map(row => row.botId));
    assignments.push({ botId: owners.size === 1 ? [...owners][0] : null, label, work, verb, dependsOn });
  }
  if (assignments.length < 2) return null;
  const first = clauses[0]?.replace(clauseLead, "").replace(/^@/u, "");
  if (!first?.startsWith(assignments[0].label)) return null;
  if (assignments.some(row => !row.botId)) return { error: "分工中有重名成员，请用完整成员名。" };
  const merged = new Map();
  for (const { label, ...row } of assignments) {
    const old = merged.get(row.botId);
    if (!old) merged.set(row.botId, row);
    else {
      old.work += "；" + row.work;
      old.dependsOn.push(...row.dependsOn.filter(id => id !== row.botId));
    }
  }
  if (merged.size < 2) return null;
  const result = [...merged.values()].map(row => ({ ...row, dependsOn: [...new Set(row.dependsOn)] }));
  if (result.some(row => row.dependsOn.some(id => !merged.has(id)))) {
    return { error: "分工的前置成员无法确定，请把前置任务也写在同一条消息里。" };
  }
  const ready = new Set();
  for (const _row of result) {
    for (const row of result) if (row.dependsOn.every(id => ready.has(id))) ready.add(row.botId);
  }
  if (ready.size !== result.length) return { error: "分工的前置关系相互等待，请调整先后顺序。" };
  return { assignments: result };
}

export class TeamMemberAssignments {
  constructor(team) {
    this.team = team;
    this.svc = team.svc;
  }

  origin(state) {
    const assignment = state.roles.assignment;
    return this.svc.state.messages.find(row => row.id === assignment.sourceMessageId &&
      row.roomId === state.roomId && row.sender.kind === "user");
  }

  current(record) {
    const state = record?.state;
    const step = state?.steps[state.currentStepId];
    return state?.dispatches[step?.attempts[step.currentAttemptId]?.dispatchId];
  }

  reply(record) {
    const dispatch = this.current(record);
    const state = record?.state;
    if (!dispatch || dispatch.terminal?.status !== "succeeded") return undefined;
    return this.svc.state.messages.find(row => row.roomId === state.roomId &&
      row.replyTo === state.roles.assignment.sourceMessageId && row.runId === dispatch.runId &&
      row.sender.kind === "bot" && row.sender.botId === dispatch.targetId && row.text?.trim());
  }

  closed(roomId, taskId) {
    return this.svc.getRoom(roomId)?.threadClosures?.[taskId];
  }

  async create(room, message, parsed) {
    if (parsed.error) throw Error(parsed.error);
    const ids = parsed.assignments.map(row => row.botId);
    if (ids.some(id => !message.authorizationSnapshot.members.includes(id))) {
      throw Error("分工中有成员当前不可用或未获点名，请确认群成员后重发。");
    }
    const batchTaskId = "thread:" + message.id;
    message.memberAssignments = parsed.assignments.map((row, index) => ({
      ...row, taskId: index === 0 ? batchTaskId : batchTaskId + ":member:" + row.botId
    }));
    if(!message.routeDecision?.sequentialMembers)message.mentions = ids;
    message.authorizationSnapshot = { ...message.authorizationSnapshot, members: ids };
    message.taskRef = batchTaskId;
    message.mentionTask = batchTaskId;
    await this.team.persistMessage(message);
    await this.schedule(message);
    const first = this.team.store.get(batchTaskId);
    if (first) this.team.setCurrentRequest(room.id, message.id, first);
    await this.svc.flushNow();
    return message;
  }

  dependencies(message, assignment) {
    return assignment.dependsOn.map(botId => {
      const row = message?.memberAssignments?.find(item => item.botId === botId);
      return { botId, reply: row && this.reply(this.team.store.get(row.taskId)) };
    });
  }

  async schedule(message) {
    if (!this.team.opened || !message?.memberAssignments?.length || this.closed(message.roomId, message.taskRef)) return;
    if (this.svc.getRoom(message.roomId)?.paused) return;
    let goalRef;
    for (const assignment of message.memberAssignments) {
      await this.team.serial(assignment.taskId, async () => {
        const team = this.team;
        if (this.closed(message.roomId, message.taskRef) || this.svc.getRoom(message.roomId)?.paused) return;
        const permissions = team.currentMembers(message.roomId);
        let record = team.store.get(assignment.taskId);
        if (!record?.revision) {
          goalRef ??= await team.store.putBlob(message, "json");
          const roles = { kind: "member-assignment", sessionScope: "task", first: assignment.botId,
            reviewer: null, supervisor: null, order: [assignment.botId], confirmers: [],
            assignment: { ...assignment, batchTaskId: message.taskRef, sourceMessageId: message.id } };
          const authorization = { ...message.authorizationSnapshot, members: [assignment.botId] };
          if (assignment.singleFile && message.routeDecision?.intent==="single-file" &&
              message.routeDecision.recipientId===assignment.botId && message.memberAssignments.length===1) {
            authorization.documentWorkOrder={kind:"single-file",taskId:assignment.taskId,roomId:message.roomId,
              origin:message.id,writer:assignment.botId,deliverer:assignment.botId};
          }
          record = await team.store.create(assignment.taskId, [team.events("TASK_CREATED", {
            roomId: message.roomId, authorization, permissions, roles, goalRef, messageRef: goalRef
          })]);
          await team.project(record);
        }
        if (record.state.roomId !== message.roomId || record.state.roles.assignment?.sourceMessageId !== message.id) {
          throw Error("成员派单与原消息不匹配。");
        }
        if (record.state.stop || record.state.currentStepId || !permissions.includes(assignment.botId)) return;
        if (this.dependencies(message, assignment).some(item => !item.reply)) return;
        await team.planStep(assignment.taskId, assignment.botId);
      });
    }
    this.svc.executor?.nudge();
  }

  async payload(state, previous) {
    const assignment = state.roles.assignment;
    const goal = this.origin(state);
    const dependencies = this.dependencies(goal, assignment);
    const request = state.activeAuthorizationId === assignment.sourceMessageId ?
      null : this.svc.state.messages.find(row => row.id === state.activeAuthorizationId && row.roomId === state.roomId);
    if (!goal || dependencies.some(item => !item.reply)) throw Error("成员的原要求或前置回复未就绪。");
    const prior = previous && JSON.parse((await this.team.store.readBlob(previous)).toString());
    return { purpose: "member-assignment", ...(assignment.singleFile ? {singleFile:true,
      attachments:goal.fileSources?.map((item,i)=>item.readMode==="full-text"?item:{...item,path:goal.attachments?.[i]?.path}),
      history:this.svc.state.messages.filter(m=>m.roomId===goal.roomId && m.sequence<goal.sequence).slice(-8).map(m=>({name:m.sender.name,text:m.text})),
      reference:this.svc.state.messages.find(m=>m.roomId===goal.roomId&&m.id===(goal.replyTo??goal.threadId))?.text} : {}),
      work: assignment.work, originalRequirement: goal.text,
      ...(goal.routeDecision?.sequentialMembers ? {hostScheduled: true} : {}),
      ...(goal.routeDecision?.sequentialMembers && goal.attachments?.length ? {attachments: goal.attachments} : {}),
      continuation: request?.text, previousReply: prior?.reply?.text,
      dependencyReplies: dependencies.map(item => ({
        name: shortName(this.svc.getBot(item.botId)), text: item.reply.text, messageId: item.reply.id
      })) };
  }

  async recover() {
    const goals = this.svc.state.messages.filter(row => row.memberAssignments?.length);
    for (const goal of goals) {
      if (this.closed(goal.roomId, goal.taskRef)) continue;
      let needsScheduling = false;
      for (const assignment of goal.memberAssignments) {
        const record = this.team.store.get(assignment.taskId);
        const dispatch = this.current(record);
        if (!dispatch && !record?.state.stop) needsScheduling = true;
        if (dispatch?.terminal?.status !== "succeeded" || !dispatch.terminal.outputRef) continue;
        const run = this.svc.state.runs.find(row => row.id === dispatch.runId);
        if (run?.status !== "running" || run.stop || this.svc.executor?.active.has(run.id)) continue;
        const output = JSON.parse((await this.team.store.readBlob(dispatch.terminal.outputRef)).toString());
        await this.svc.settleRun({ id: run.id, expectedRevision: run.controlRevision, status: "completed", reply: output.reply });
      }
      if (needsScheduling) await this.schedule(goal);
    }
  }

  absence(record, dispatch) {
    if (!dispatch || dispatch.receipt || dispatch.turn || dispatch.status !== "unknown") return undefined;
    const entry = record.events.findLast(event => event.type === "DELIVERY_UNKNOWN" &&
      event.payload.dispatchId === dispatch.dispatchId && event.payload.attemptId === dispatch.attemptId &&
      event.payload.proof?.phase === "before-native-submit");
    return entry?.payload.proof;
  }

  async recordPreSubmitFailure(runId) {
    const run = this.svc.state.runs.find(row => row.id === runId);
    if (!run?.teamTaskId) return;
    const team = this.team;
    await team.serial(run.teamTaskId, async () => {
      const record = team.recordForRun(run);
      const dispatch = this.current(record);
      if (record?.state.roles.kind !== "member-assignment" || record.state.stop ||
          !dispatch || dispatch.runId !== runId || dispatch.status !== "sending" || dispatch.sends !== 1 ||
          dispatch.receipt || dispatch.turn || team.sessionBridge.deliveries.has(runId)) return;
      const proof = { definitive: true, kind: "not-found", phase: "before-native-submit",
        runId, sessionId: run.sessionId, at: new Date().toISOString() };
      await team.commit(record.taskId, [team.events("DELIVERY_UNKNOWN", {
        ...team.runInput(run), reason: "原宿主在提交前拒绝，未接到", proof
      })], record.revision);
    });
  }

  feedback(room) {
    if (!this.team.opened) return [];
    return this.svc.state.messages.filter(message => message.roomId === room.id && message.memberAssignments?.length)
      .map(message => ({ messageId: message.id, members: message.memberAssignments.map(row => this.view(message, row)) }));
  }

  view(message, assignment) {
    const record = this.team.store.get(assignment.taskId);
    const dispatch = this.current(record);
    const run = dispatch && this.svc.state.runs.find(row => row.id === dispatch.runId);
    const reply = this.reply(record);
    const base = { botId: assignment.botId, ...dispatch ? { dispatchId: dispatch.dispatchId } : {} };
    const state = (status, label, detail, action) => ({ ...base, status, label, detail, action });
    if (reply) {
      if (assignment.singleFile) {
        const done = Object.values(this.team.reminders?.data?.events ?? {}).some(event =>
          event.kind === "done" && event.effective && event.roomId === message.roomId &&
          event.messageId === message.id && event.files.some(file => file.runId === dispatch.runId));
        if (!done) return {...state("waiting-file","已回复，文件待交付","可回复原消息并点名继续"),replyId:reply.id};
      }
      return { ...state("replied", "已回复"), replyId: reply.id };
    }
    if (!this.team.currentMembers(message.roomId).includes(assignment.botId)) return state("stopped", "成员不可用", "请核对当前群成员");
    if (record?.state.stop || this.closed(message.roomId, message.taskRef)) {
      return state("stopped", dispatch?.turn ? "已开工 · 已停止" : "已停止");
    }
    if (!dispatch) {
      const missing = this.dependencies(message, assignment).filter(item => !item.reply);
      return missing.length ? state("dependency", "等" + missing.map(item => shortName(this.svc.getBot(item.botId))).join("、") + "交稿") :
        state("preparing", "准备派单");
    }
    if (dispatch.terminal) {
      const detail = dispatch.terminal.status === "succeeded" ? "未收到群回复" : "回合已结束，可明确续接原任务";
      return state("interrupted", dispatch.turn ? "已开工 · " + detail : "已接单 · 回合未启动");
    }
    if (this.absence(record, dispatch) && run?.status === "failed" && !this.svc.executor?.active.has(run.id)) {
      return state("failed", "未接到", "原宿主在提交前拒绝", "retry-member-delivery");
    }
    const check = message.memberReceiptChecks?.findLast(item => item.dispatchId === dispatch.dispatchId);
    const uncertain = dispatch.status === "unknown" || check?.status === "unknown";
    if (dispatch.turn) return state("running", "在" + assignment.verb, uncertain ? "原回合待核对" : undefined, uncertain ? "check-member-receipt" : undefined);
    if (dispatch.receipt) return state("accepted", "已接单", uncertain ? "开工待核对" : undefined, uncertain ? "check-member-receipt" : undefined);
    if (uncertain) return state("unconfirmed", "接单未确认", undefined, "check-member-receipt");
    return state("queued", "等接单");
  }

  async action(room, input) {
    const message = this.svc.state.messages.find(row => row.id === input.messageId &&
      row.roomId === room.id && row.sender.kind === "user");
    const assignment = message?.memberAssignments?.find(row => row.botId === input.botId);
    if (!assignment || typeof input.dispatchId !== "string") throw Error("原消息的成员派单不存在。");
    if (input.mode === "retry-member-delivery") return this.retry(message, assignment, input.dispatchId);
    let record = this.team.store.get(assignment.taskId);
    const original = record?.state.dispatches[input.dispatchId];
    if (!original || original.targetId !== assignment.botId) throw Error("该回执不属于这位成员。");
    const run = this.svc.state.runs.find(row => row.id === original.runId && row.roomId === room.id &&
      row.botId === assignment.botId && row.originMessageId === message.id);
    if (!run) throw Error("原派单的运行记录暂不可用。");
    if (this.current(record)?.dispatchId === original.dispatchId && !this.reply(record) &&
        !this.absence(record, original) && !record.state.stop &&
        !this.closed(room.id, message.taskRef) && !this.svc.executor?.active.has(run.id) &&
        !["pending", "terminal", "revoked"].includes(original.status)) {
      await this.team.reconcile(run, original);
    }
    record = this.team.store.get(assignment.taskId);
    const dispatch = record.state.dispatches[input.dispatchId];
    const result = this.reply(record)?.runId === dispatch.runId ? "replied" :
      dispatch.turn ? "running" : dispatch.receipt ? "accepted" : this.absence(record, dispatch) ? "not-found" : "unknown";
    this.svc.state = { ...this.svc.state, messages: this.svc.state.messages.map(row =>
      row.roomId === room.id && row.id === message.id ? { ...row,
        memberReceiptChecks: [...(row.memberReceiptChecks ?? []), {
          botId: assignment.botId, dispatchId: dispatch.dispatchId, attemptId: dispatch.attemptId,
          runId: dispatch.runId, status: result, at: new Date().toISOString()
        }]
      } : row) };
    await this.svc.flushNow();
    return { ok: true, status: result };
  }

  async retry(message, assignment, dispatchId) {
    const team = this.team;
    return team.serial(assignment.taskId, async () => {
      const record = team.store.get(assignment.taskId);
      const dispatch = this.current(record);
      if (!dispatch || dispatch.targetId !== assignment.botId || !record.state.dispatches[dispatchId]) {
        throw Error("该派单不属于这位成员。");
      }
      const authorizationId = "member-retry:" + digest({ dispatchId });
      if (dispatch.dispatchId !== dispatchId) {
        const existing = Object.values(record.state.dispatches).find(row => row.authorizationId === authorizationId);
        if (existing) return { ok: true, alreadyRetried: true, runId: existing.runId };
        throw Error("原派单已更新，请刷新。");
      }
      if (this.closed(message.roomId, message.taskRef) || record.state.stop || this.svc.getRoom(message.roomId)?.paused ||
          !team.currentMembers(message.roomId).includes(assignment.botId)) throw Error("原任务已关闭或成员不可用。");
      const proof = this.absence(record, dispatch);
      const run = this.svc.state.runs.find(row => row.id === dispatch.runId);
      if (!proof || proof.runId !== run?.id || proof.sessionId !== run.sessionId || run.status !== "failed" ||
          run.upstream || run.stop || this.svc.executor?.active.has(run.id) || this.reply(record)) {
        throw Error("原派单仍有在途或缺少确定未收件证据，请先核对状态。");
      }
      const authorization = { messageId: authorizationId, members: [assignment.botId],
        at: new Date().toISOString(), sourceMessageId: message.id };
      const events = [
        team.events("DELIVERY_ABSENT", { ...team.runInput(run), proof }),
        team.events("USER_STOPPED", { reason: "确认未接到，按用户指令撤销旧派单" }),
        team.events("USER_AUTHORIZED", { authorization, messageRef: record.state.goalRef, resumeStopped: true })
      ];
      const prospective = events.reduce((state, event) => apply(state, { ...event, taskId: record.taskId }),
        { ...record.state, permissions: team.currentMembers(message.roomId) });
      const plan = await team.buildPlan(prospective, assignment.botId);
      await team.commit(record.taskId, [...events, ...plan.events], record.revision);
      await this.svc.flushNow();
      this.svc.executor?.nudge();
      return { ok: true, runId: plan.dispatchId, status: "queued" };
    });
  }

  async resume(record, message, authorization) {
    const team = this.team;
    return team.serial(record.taskId, async () => {
      const latest = team.store.get(record.taskId);
      const state = latest.state;
      const assignment = state.roles.assignment;
      if (this.closed(state.roomId, assignment.batchTaskId)) throw Error("这件事已结束。");
      if (state.authSnapshots[message.id]) return team.response(latest, message.id, { alreadySelected: true });
      if (!authorization.members.includes(assignment.botId) || !effectiveMembers(state).includes(assignment.botId)) {
        throw Error("请点名原成员继续他自己的分工。");
      }
      const previous = this.current(latest);
      if (this.reply(latest)) {
        if (!assignment.singleFile) throw Error("这位成员已回复。请直接发送新的要求。");
        const files = await team.reminders.assignmentFiles([latest]);
        if (!files) throw Error("本单已有文件记录，但原件未通过校验，请先核对原件。");
        if (files.length) throw Error("这位成员已交付文件，请从原消息打开。");
      }
      if (this.absence(latest, previous)) throw Error("宿主确认未接到，请使用原消息下的重发。");
      if (state.status === "stopping" || previous && previous.status !== "revoked" && !previous.terminal) {
        throw Error("原派单尚未确认结束，请先核对原回合。");
      }
      if (this.dependencies(this.origin(state), assignment).some(item => !item.reply)) throw Error("前置成员尚未交稿。");
      const event = team.events("USER_AUTHORIZED", {
        authorization: { ...authorization, members: [assignment.botId] },
        messageRef: await team.store.putBlob(message), resumeStopped: true
      });
      const prospective = apply(state, { ...event, taskId: latest.taskId });
      const plan = await team.buildPlan(prospective, assignment.botId, [], { previous: previous?.terminal?.outputRef });
      const next = await team.commit(latest.taskId, [event, ...plan.events], latest.revision);
      await this.svc.flushNow();
      this.svc.executor?.nudge();
      return team.response(next, message.id, { runId: plan.dispatchId });
    });
  }
}

