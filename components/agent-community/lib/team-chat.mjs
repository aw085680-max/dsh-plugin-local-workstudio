import {claimsReview} from "./team-review.mjs";
import {CHAT_REPLY_LIMIT, chatRunId, displayReply, isChatRun, orderedChatMembers} from "./team-chat-routing.mjs";

const statuses = {
  completed: "任务已完成，交付以原任务回执为准。",
  stopped: "任务已停止。",
  stopping: "正在等待原回合的停止回执。",
  "pending-review": "任务正在等待复核或用户操作。",
  pending: "任务已登记，等待获准成员启动。",
  queued: "任务正在排队。",
  running: "宿主显示任务正在运行。",
  verifying: "正在核对成果版本和签核。",
  failed: "任务未完成，详情中有当前状态。"
};

export class TeamChat {
  constructor(orchestrator) {
    this.team = orchestrator;
    this.svc = orchestrator.svc;
  }

  workStatus(run) {
    if (run.status !== "running" && run.status !== "queued") return;
    const room = this.svc.getRoom(run.roomId);
    if (!room || room.directBotId !== undefined) return;
    const name = this.svc.getBot(run.botId)?.name?.split(/--|——/u).at(-1) || "成员";
    const status = (phase, detail) => ({phase, text:name + "：" + detail});
    if (run.stop) return status("stopping", "正在核对停止回执");
    if (run.status === "queued") {
      if (room.paused) return status("paused", "群聊已暂停，尚未开工");
      const blocker = run.teamTaskId && this.team.blockingTask(run);
      if (blocker) {
        const other = this.svc.getRoom(blocker.roomId);
        const where = blocker.roomId === run.roomId ? "本群" : other?.name ? "「" + other.name + "」" : "另一群";
        return status("blocked", "排队中，等待" + where + "的上一棒结束或核实状态");
      }
      return status("queued", "已排队，尚未开工");
    }
    const step = run.teamTaskId && room.mentionSequences?.find(row => row.taskKey === run.teamTaskId)
      ?.steps?.find(row => row.runId === run.id && row.botId === run.botId);
    const active = this.svc.executor?.active.has(run.id);
    const check = run.upstreamVerification;
    const age = Date.now() - Date.parse(check?.at);
    const verified = !!run.upstream?.turnId && check?.turnId === run.upstream.turnId &&
      check.threadId === run.upstream.threadId && check.status === "running" && age >= 0 && age < 40_000;
    if (!active && !verified) return status("checking", "正在核对原回合，开工状态待确认");
    const clock = isChatRun(run) && run.chatStart;
    const turnStarted = clock?.source === "codex-app-server" ? !!clock.proof?.turnId && !!clock.proof?.threadId :
      clock?.source === "host-model-stream" || step?.status === "running";
    if (verified || turnStarted) return status("thinking", "正在思考回复中…");
    return step?.status === "delivered" ? status("accepted", "已接单，等待开工回执") :
      status("starting", "正在连接，等待开工回执");
  }

  activity(room, sequence = (room.mentionSequences ?? []).find(row =>
    row.mode === "orchestrated" && !row.orderedChat && row.taskKey === room.teamCurrentRequest?.taskId &&
    row.activeRequestId === room.teamCurrentRequest?.messageId)) {
    if (!sequence || sequence.orderedChat) return;
    const taskId = sequence.taskKey;
    const reply = (text, extra = {}) => ({taskId, status: sequence.status, text, ...extra});
    if (!this.team.opened || this.svc.writesBlocked) return reply("当前任务状态待核对。");
    if (this.team.store.busyRecords.has(taskId)) return reply("任务账本暂被占用，正在等待写入回执。");
    if (sequence.status === "completed") return reply("当前任务已完成。");
    if (sequence.status === "stopped") return reply("当前任务已停止。");
    if (sequence.status === "stopping") return reply("正在等待原回合停止回执。");
    if (sequence.status === "verifying") return reply("正在核对原回合状态。");
    if (sequence.status === "pending-review") return reply("当前任务待复核。", {detail: sequence.missing?.[0]});
    const step = sequence.steps?.[sequence.currentIndex];
    const run = step && this.svc.state.runs.find(row => row.roomId === room.id && row.teamTaskId === taskId &&
      row.id === step.runId && row.botId === step.botId);
    if (!run) return reply(sequence.status === "pending-delivery" ? "同一版本已签核，等待交稿回执。" : "正在核对当前派单。");
    if (run.stop && run.stop.state !== "confirmed") return reply("正在等待原回合停止回执。");
    const members = this.team.currentMembers(room.id);
    const allowed = (sequence.authorizedMemberIds ?? []).filter(id => members.includes(id));
    if (!allowed.includes(step.botId)) return reply("正在核对当前成员的任务授权。");
    const work = this.workStatus(run);
    if (work && ["blocked", "checking"].includes(work.phase)) return reply(work.text, {owner:step.botId, runId:run.id});
    const name = this.svc.getBot(step.botId)?.name ?? "当前成员";
    let text;
    if (step.status === "running" && run.status === "running") {
      text = name + (sequence.status === "pending-delivery" ? "正在交稿" : "正在处理");
    } else if (step.status === "delivered" && run.status === "running") {
      text = "宿主已接单，等待" + name + "启动";
    } else if (step.status === "pending" && ["queued", "running"].includes(run.status)) {
      text = "等待" + name + "接单";
    } else if (["succeeded", "failed", "cancelled"].includes(step.status)) {
      return reply(sequence.status === "pending-delivery" ? "同一版本已签核，等待交稿回执。" : name + "这一棒已结束，正在核对收尾状态。");
    } else return reply("正在核对原回合状态。");
    const reviewer = sequence.reviewerId;
    if (step.botId === sequence.firstBotId && reviewer && reviewer !== step.botId && allowed.includes(reviewer) &&
        !sequence.steps.some(row => row.botId === reviewer)) {
      text += "，" + (this.svc.getBot(reviewer)?.name ?? "复核成员") + "尚未接棒";
    }
    const progressAt = run.progressEvents > 0 && Number.isFinite(Date.parse(run.lastProgressAt)) ? run.lastProgressAt : undefined;
    return reply(text + "。", {owner: step.botId, runId: run.id, ...(progressAt ? {progressAt} : {})});
  }

  broadcastReceipt(room, message, reference) {
    const current = room.teamCurrentRequest;
    if (!current?.taskId) return;
    const anchor = reference ?? this.svc.state.messages.findLast(row => row.roomId === room.id && row.sender.kind === "user");
    if (!anchor || (anchor.taskRef ?? anchor.mentionTask) !== current.taskId) return;
    if (!reference && anchor.id !== current.messageId && anchor.routeDecision?.intent !== "progress") return;
    const activity = this.activity(room);
    if (!activity || (!reference && ["completed", "stopped"].includes(activity.status))) return;
    // A display projection can name the task, but a ping can never authorize execution.
    try {
      this.team.assert();
      const record = this.team.store.get(current.taskId);
      if (record?.state.roomId === room.id && record.state.activeAuthorizationId === current.messageId &&
          record.revision === current.revision) return {...activity, at: message.createdAt};
    } catch { /* Keep the ping read-only when the task store cannot be verified. */ }
    return {taskId: current.taskId, text: "当前无法核实这项任务的进度。", at: message.createdAt};
  }

  progress(room, reference, mentioned) {
    try {
      this.team.assert();
      let records = this.team.taskCandidates(room.id, reference ? {replyTo: reference.id} : {}, !reference);
      const current = records.find(record => record.taskId === room.teamCurrentRequest?.taskId &&
        record.state.activeAuthorizationId === room.teamCurrentRequest?.messageId);
      if (!reference && current && (!mentioned.length || mentioned.some(id =>
          current.state.authSnapshots[current.state.activeAuthorizationId]?.members.includes(id)))) records = [current];
      const relevant = mentioned.length ? records.filter(record =>
        record.state.authSnapshots[record.state.activeAuthorizationId]?.members.some(id => mentioned.includes(id))) : records;
      if (relevant.length !== 1) {
        return { text: relevant.length ? "请用户说明要查询哪一项任务。" : "当前没有查到能核实的任务进度，请用户给出原任务引用。" };
      }
      const state = relevant[0].state;
      const owner = state.steps[state.currentStepId]?.targetId ?? state.roles.first;
      const authorized = state.authSnapshots[state.activeAuthorizationId]?.members ?? [];
      if (!authorized.includes(owner) || !this.team.currentMembers(room.id).includes(owner)) return { text: "该任务的负责人当前不可用。" };
      const view = room.mentionSequences?.find(row => row.taskKey === state.taskId && row.revision === relevant[0].revision);
      const activity = view && this.activity(room, view);
      return { target: owner, taskId: state.taskId, text: activity?.text ?? statuses[state.status] ?? "当前任务状态待核对。" };
    } catch {
      return { text: "当前无法读取任务库，暂时查不到任务进度。" };
    }
  }

  currentContext(room, message, reference) {
    const current=room.teamCurrentRequest;
    if(!this.team.opened || this.svc.writesBlocked || !current?.taskId) return;
    try {
      this.team.assert();
      const record=this.team.store.get(current.taskId);
      const state=record?.state;
      if(!state || state.roomId!==room.id || state.activeAuthorizationId!==current.messageId ||
          !state.authSnapshots[current.messageId] || state.stop || ["stopped","completed","stopping"].includes(state.status) ||
          this.team.threadCloser.closure(room.id,record.taskId)) return;
      const anchor=reference??this.svc.state.messages.findLast(row=>row.roomId===room.id &&
        row.sender.kind==="user" && row.sequence<message.sequence);
      if(!anchor)return;
      const sourceRun=anchor.sender.kind==="bot" && anchor.runId && this.svc.state.runs.find(run=>
        run.id===anchor.runId && run.roomId===room.id && run.botId===anchor.sender.botId);
      const source=sourceRun && this.svc.state.messages.find(row=>row.roomId===room.id && row.id===sourceRun.originMessageId);
      if(![anchor.taskRef,anchor.mentionTask,anchor.chatPlan?.contextTaskId,sourceRun?.teamTaskId,
          source?.taskRef,source?.chatPlan?.contextTaskId].includes(record.taskId))return;
      const links=text=>new Set((text??"").split(/\r?\n/u).map(line=>line.trim()).filter(line=>
        /^codex:\/\/threads\/[a-f\d-]+$/iu.test(line)).map(line=>line.toLowerCase()));
      const provided=links(message.text);
      if(!reference && provided.size){
        const original=links(this.team.goalCache.get(record.taskId)?.text);
        if([...provided].some(link=>!original.has(link)))return;
      }
      return record.taskId;
    } catch { return; }
  }

  receiptText(roomId, taskId, member) {
    const unavailable="本条消息没有查到关联的任务派单或开工回执。";
    if(!taskId || !this.team.opened || this.svc.writesBlocked)return unavailable;
    try {
      this.team.assert();
      const state=this.team.store.get(taskId)?.state;
      if(!state || state.roomId!==roomId)return unavailable;
      const work=member?[member]:[...new Set([state.roles.first,state.roles.reviewer].filter(Boolean))];
      const rows=work.map(id=>{
        const name=member?"我":this.svc.getBot(id)?.name?.split(/--|——/u).at(-1)??"成员";
        const step=state.order.map(key=>state.steps[key]).findLast(row=>row.targetId===id);
        const d=step&&state.dispatches[step.attempts[step.currentAttemptId]?.dispatchId];
        if(!d)return name+"还没有任务派单";
        if(d.status==="revoked")return name+"的派单已撤销";
        if(d.terminal)return name+(d.terminal.status==="succeeded"?"已返回本棒结果":d.terminal.status==="cancelled"?"的回合已取消":"本棒未成功");
        if(d.status==="unknown")return name+"的投递状态待核实";
        if(d.turn?.turnId)return name+"已开工";
        if(d.receipt?.sessionId)return name+"的派单已由宿主接收，等待开工";
        return name+"的派单已登记，等待接收回执";
      });
      return (member?"":"原任务回执：")+rows.join("，")+"。"+(state.status==="completed"?"本轮任务已结束。":state.stop?"本轮已请求停止。":"");
    }catch{return unavailable;}
  }

  describesAssignments(text, room, speaker) {
    return room.memberIds.some(id=>{
      if(id===speaker)return false;
      const name=this.svc.getBot(id)?.name?.split(/--|——/u).at(-1)?.trim();
      return name && text.split(/[。！？\n]/u).some(line=>line.includes(name) &&
        /(?:派[单双给发]|分工|接单|开工|出稿|复测|复核|负责|交给|已开始|已安排|安排.{0,8}(?:做|处理))/u.test(line));
    });
  }

  prepare(room, message, authored, marked, reference, decision, unresolvedMention) {
    const bareMention = !authored.remainder?.trim() && !message.attachments?.length;
    if (bareMention && authored.who === "everyone" && !authored.ids.length && decision.intent === "chat" &&
        !room.paused && !unresolvedMention && marked.length) {
      const receipt = this.broadcastReceipt(room, message, reference);
      if (receipt) {
        message.presentation = "chat";
        message.runtime = "chat";
        message.taskRef = receipt.taskId;
        message.routeDecision = {...message.routeDecision, intent: "progress", basis: message.text};
        message.chatPlan = {targets: [], allowance: 0, ordered: false, statusReceipt: receipt};
        message.authorizationSnapshot = {...message.authorizationSnapshot, members: []};
        return;
      }
    }
    const eligible = this.team.currentMembers(room.id);
    const settings = this.svc.teamWorkflowFor(room);
    const defaultTarget = [this.svc.leaderOfRoom(room.id), settings?.firstBotId, ...eligible].find(id => eligible.includes(id));
    const visibleMention = authored.who === "everyone" || authored.ids.length > 0;
    const quoted = reference?.sender.kind === "bot" && eligible.includes(reference.sender.botId) ? reference.sender.botId : undefined;
    const contextTaskId=!unresolvedMention && !room.paused &&
      (bareMention || decision.roleStatement || decision.followOriginal || marked.some(id=>this.team.threadCloser.isAdmin(id,room.id)))
      ?this.currentContext(room,message,reference):undefined;
    const statusOnly=decision.roleStatement && !visibleMention && room.mentionOnly;
    const report=decision.followOriginal || decision.roleStatement;
    const statusText=report?this.receiptText(room.id,contextTaskId):undefined;
    const reviewTask=decision.reviewQuery&&!unresolvedMention?this.team.review.locate(room,{},reference):null;
    const reviewTarget=this.team.review.targetIn(decision.basis??"",reviewTask);
    const verifiedReview=decision.reviewQuery?this.team.review.feedback(reviewTask,reviewTarget):null;
    const progress = verifiedReview?{taskId:verifiedReview.taskId,text:verifiedReview.text}:decision.intent === "progress" && !decision.followOriginal ? this.progress(room, reference, marked) : undefined;
    const explicitlyOrdered = decision.intent === "ordered-chat" && visibleMention;
    let targets = [];
    let reason;
    if (room.paused) reason = "群聊已暂停。";
    else if (unresolvedMention || visibleMention && !marked.length) reason = "请点名一位当前可用的成员。";
    else if (explicitlyOrdered) {
      const roleOrder = [settings?.firstBotId, settings?.reviewerId, settings?.supervisorId, ...(settings?.memberIds ?? []), ...room.memberIds];
      targets = orderedChatMembers(authored.sequence ?? (authored.who ? [] : marked), roleOrder, marked, decision);
      if (!targets.length) reason = "请确认接话成员和接力范围。";
    } else if (authored.who === "everyone" && !decision.each) {
      const duty = marked.includes(defaultTarget) ? defaultTarget : marked[0];
      if (duty) targets = [duty];
    } else if (marked.length) targets = [...new Set(marked)];
    else if (statusOnly) targets = [];
    else if (room.mentionOnly) reason = "本群仅接受点名。请点名一位成员。";
    else if (reference?.sender.kind === "bot" && !quoted) reason = "被引用的成员当前不可用。请点名另一位成员。";
    else if (quoted || progress?.target || defaultTarget) targets = [quoted ?? progress?.target ?? defaultTarget];
    else reason = "当前没有可用的群成员。";

    message.presentation = "chat";
    message.runtime = "chat";
    if (progress?.taskId) message.taskRef = progress.taskId;
    message.chatPlan = {
      targets,
      allowance: explicitlyOrdered ? CHAT_REPLY_LIMIT : targets.length,
      ordered: explicitlyOrdered,
      ...(bareMention && !reference && visibleMention ? {pingOnly: true} : {}),
      ...(contextTaskId ? {contextTaskId} : {}),
      ...(report && !reason ? {workflowReport:true,statusReceipt:{taskId:contextTaskId??null,text:statusText,at:message.createdAt}} : {}),
      ...(reason ? { reason } : {}),
      ...(progress ? { statusContext: progress.text } : {}),
      ...(verifiedReview?{reviewQuery:true,statusReceipt:{...verifiedReview,at:message.createdAt}}:{}),
      ...(decision.countFrom !== undefined ? { countFrom: decision.countFrom } : {})
    };
    message.authorizationSnapshot = {...message.authorizationSnapshot, members: targets};
  }

  canClaim(run) {
    const message = this.messageFor(run);
    const plan = message?.chatPlan;
    const room = this.svc.getRoom(run.roomId);
    if (this.team.threadCloser.closure(run.roomId,run.taskRef) && !message?.closeRequest) return false;
    if (!room || !plan || plan.closedAt || room.paused || this.svc.writesBlocked ||
        (room.mentionOnly && !message.mentions?.includes(run.botId))) return false;
    const index = run.chatIndex;
    return run.id === chatRunId(message.id, index) &&
      plan.targets[index] === run.botId && index < plan.allowance &&
      message.authorizationSnapshot?.messageId === message.id &&
      message.authorizationSnapshot.members?.includes(run.botId) &&
      this.team.currentMembers(room.id).includes(run.botId) &&
      run.sessionId === this.svc.sessionIdFor(run.roomId, run.botId, "chat") &&
      (!plan.ordered || index === 0 || !!this.replyFor(message, index - 1));
  }

  messageFor(run) {
    return this.svc.state.messages.find(m =>
      m.id === run.originMessageId && m.roomId === run.roomId && m.sender.kind === "user");
  }

  replyFor(message, index) {
    const id = chatRunId(message.id, index);
    const run = this.svc.state.runs.find(r => r.id === id && r.roomId === message.roomId);
    if (run?.status !== "completed") return undefined;
    return this.svc.state.messages.find(m => m.runId === id && m.roomId === message.roomId &&
      m.sender.kind === "bot" && m.sender.botId === run.botId && m.text.trim());
  }

  async schedule(message) {
    const plan = message.chatPlan;
    const room = this.svc.getRoom(message.roomId);
    if (!plan || !room || this.svc.writesBlocked || plan.reason || plan.closedAt || room.paused) return;
    for (let index = 0; index < Math.min(plan.targets.length, plan.allowance); index++) {
      const id = chatRunId(message.id, index);
      if (this.replyFor(message, index)) continue;
      if (this.svc.state.runs.some(r => r.id === id)) {
        if (plan.ordered) return;
        continue;
      }
      const botId = plan.targets[index];
      const createdAt = new Date().toISOString();
      const run = {
        id, botId, roomId: room.id, runtime: "chat", sessionId: this.svc.sessionIdFor(room.id, botId, "chat"),
        origin: "user", originMessageId: message.id, chatIndex: index, prompt: message.text,
        ...(message.taskRef ? {taskRef: message.taskRef} : {}),
        status: "queued", controlRevision: 0, attempt: 0, maxAttempts: 1, createdAt, updatedAt: createdAt
      };
      if (!this.canClaim(run)) {
        if(plan.ordered) {
          await this.updatePlan(message, { reason: "下一位接话成员已不可用，接话已结束。" });
          return;
        }
        // A member revoked after the message was persisted gets an individual terminal receipt.
        run.status="cancelled";
        run.finishedAt=createdAt;
        run.error="该成员本轮接话资格已失效。";
      }
      this.svc.state = {...this.svc.state, runs: [...this.svc.state.runs, run]};
      await this.svc.flushNow();
      this.svc.executor?.nudge();
      if(plan.ordered) return run;
    }
  }

  async updatePlan(message, additions) {
    const current = this.svc.state.messages.find(m => m.id === message.id && m.roomId === message.roomId);
    if (!current?.chatPlan) throw Error("原群聊消息已更新");
    const next = {...current, chatPlan: {...current.chatPlan, ...additions}};
    this.svc.state = {...this.svc.state, messages: this.svc.state.messages.map(m => m === current ? next : m)};
    await this.svc.flushNow();
    this.svc.ctx.emit?.("agent-community:update", {kind: "message", roomId: next.roomId});
    return next;
  }

  async continue(room, input) {
    const message = this.svc.state.messages.find(m => m.roomId === room.id && m.id === input.messageId && m.sender.kind === "user");
    const plan = message?.chatPlan;
    if (!plan?.ordered || plan.reason || plan.closedAt || room.paused || plan.allowance >= plan.targets.length) {
      throw Error("本轮接话没有待继续成员");
    }
    if (Number(input.expectedAllowance) !== plan.allowance) throw Error("这次继续已经处理，请刷新");
    if (!this.replyFor(message, plan.allowance - 1)) throw Error("上一位成员尚未完成回复");
    const next = await this.updatePlan(message, {allowance: plan.allowance + CHAT_REPLY_LIMIT});
    await this.schedule(next);
    return {ok: true, requestId: next.id, status: "queued"};
  }

  attention(room) {
    const runs = new Map(this.svc.state.runs.filter(r => r.roomId === room.id && isChatRun(r)).map(r => [r.id,r]));
    const messages = this.svc.state.messages.filter(message=>message.roomId===room.id);
    const lastUser=messages.findLast(message=>message.sender.kind==="user");
    return messages.flatMap(message=>{
      const plan=message.chatPlan;
      if(!plan)return [];
      if (plan.statusReceipt && lastUser?.id === message.id) return [{messageId: message.id, receipt: plan.statusReceipt}];
      const ready=plan.ordered&&!plan.closedAt&&!plan.reason&&!room.paused&&plan.allowance<plan.targets.length&&
        runs.get(chatRunId(message.id,plan.allowance-1))?.status==="completed";
      if(ready)return [{messageId:message.id,action:"continue-chat",allowance:plan.allowance}];
      return lastUser?.id===message.id&&plan.reason?[{messageId:message.id,reason:plan.reason}]:[];
    });
  }

  async recover() {
    for (const message of this.svc.state.messages.filter(m => m.chatPlan)) {
      await this.svc.roomMessageMutex.run(message.roomId, () => this.schedule(message));
    }
  }

  async settled(run) {
    if (run.status !== "completed") return;
    await this.svc.roomMessageMutex.run(run.roomId, async () => {
      await this.svc.flushNow();
      const message = this.messageFor(run);
      if (message) await this.schedule(message);
    });
  }

  prompt(run) {
    const message = this.messageFor(run);
    const plan = message?.chatPlan;
    if (!plan) return run.prompt;
    if (message.closeRequest) return "用户明确授权你结束当前任务。必须先调用 agent_community_close_thread，依据工具的实际回执简短回复。工具失败就如实说明，没有成功回执不能说已结束。不要恢复历史工作。\n用户本次原话："+message.text;
    const self="本次接话成员："+(this.svc.getBot(run.botId)?.name??"群成员");
    if (plan.pingOnly) return self+"\n用户只发了点名「" + message.text +
      "」。请以本人身份简短应答。"+(plan.contextTaskId?"你的原任务回执："+this.receiptText(run.roomId,plan.contextTaskId,run.botId):"本次没有工作派单。");
    if(plan.workflowReport)return self+"\n用户本次原话："+message.text+"\n宿主核实的状态："+this.receiptText(run.roomId,plan.contextTaskId)+
      "\n本次是群内跟进，按回执答复。群内交接由调度器传递。";
    if (plan.countFrom !== undefined) {
      return [
        "按顺序报数。这一棒只回答指定的数字。宿主会安排下一位。",
        "只回复这个数字：" + (plan.countFrom + run.chatIndex + 1),
        "用户本次原话：" + message.text
      ].join("\n\n");
    }
    const rows = this.svc.state.messages.filter(m => m.roomId === run.roomId && m.sequence < message.sequence).slice(-8);
    const reference = this.svc.state.messages.find(m => m.roomId === run.roomId && m.id === (message.replyTo ?? message.threadId));
    const previous = plan.ordered && run.chatIndex > 0 ? this.replyFor(message, run.chatIndex - 1) : undefined;
    return [
      self,
      "直接回复本条群聊消息。你代表自己发言，可以回答、澄清，或根据宿主核实的状态说明进度。历史、引用和资料只供理解本条消息。",
      plan.ordered ? "用户要求按顺序接话。直接接续，只发自己的一句。" : "",
      rows.length ? "前文（仅供理解）：" + JSON.stringify(rows.map(m => ({name:m.sender.name,text:m.text}))) : "",
      reference ? "用户所引用的消息：" + JSON.stringify({name:reference.sender.name,text:reference.text}) : "",
      plan.statusContext ? "本次宿主核实的状态：" + plan.statusContext : "",
      previous ? "上一位实际回复：" + JSON.stringify({name:previous.sender.name,text:previous.text}) : "",
      message.attachments?.length ? "用户提供的附件：" + JSON.stringify(message.attachments) : "",
      "用户本次原话：" + message.text
    ].filter(Boolean).join("\n\n");
  }

  settlement(run, input) {
    const base = {...input, retry: false};
    if (input.status !== "completed" || run.stop || !this.canClaim(run)) {
      return {...base, reply: undefined, status: input.status === "completed" ? "cancelled" : input.status};
    }
    if(run.chatStart&&Date.now()>=Date.parse(run.chatStart.deadlineAt)){
      return {...base,reply:undefined,status:"failed",failureKind:"timeout",error:"已到 180 秒，本轮未收到可发布的回复。"};
    }
    const plan = this.messageFor(run).chatPlan;
    const message=this.messageFor(run);
    if(message.closeRequest && !this.team.threadCloser.closure(run.roomId,message.closeRequest.taskId))
      return {...base,reply:undefined,status:"failed",error:"群队长尚未确认结束，请重试。"};
    const text = message.closeRequest ? (message.closeRequest.state==="closed"?"这件事已结束。":"已关闭这件事，正在等原回合停下来。") : displayReply(input.reply?.text ?? "", plan.statusContext);
    if (plan.countFrom === undefined) {
      if (text.trim()) {
        const room=this.svc.getRoom(run.roomId);
        const adminReport=room && this.team.threadCloser.isAdmin(run.botId,room.id) && !message.closeRequest &&
          this.describesAssignments(text,room,run.botId);
        const claimed=claimsReview(text)&&!message.closeRequest;
        const reviewRecord=claimed?this.team.review.locate(room,{taskId:message.taskRef??plan.contextTaskId},undefined):null;
        const verified=plan.reviewQuery?plan.statusContext:claimed?this.team.review.guardText(text,reviewRecord,run.botId):plan.workflowReport || adminReport ? this.receiptText(run.roomId,plan.contextTaskId) :
          plan.pingOnly && plan.contextTaskId ? "在。"+this.receiptText(run.roomId,plan.contextTaskId,run.botId) : text;
        return {...base,reply:{...input.reply,text:verified}};
      }
      return {...base, reply: undefined, status:"failed", error:"本轮没有收到可发布的正文回复。"};
    }
    const expected = String(plan.countFrom + run.chatIndex + 1);
    const name = this.svc.getBot(run.botId)?.name ?? "";
    let firstLine = text.trim().split(/\r?\n/u, 1)[0].normalize("NFKC");
    const speaker = firstLine.match(/^([^:：]+)[:：]\s*(.+)$/u);
    if (speaker && [name, name.split("--").at(-1)].includes(speaker[1].trim())) firstLine = speaker[2].trim();
    firstLine = firstLine.replace(/[.!。！]$/u, "").replace(/^(\*\*|__|\x60)(.*?)\1$/u, "$2").trim();
    if (firstLine !== expected) {
      return {...base, reply: undefined, status:"failed", error:"本棒未收到所要求的数字 " + expected + "。"};
    }
    // The host decides who takes the next turn; a model's relay commentary stays in its session.
    return {...base, reply: {...input.reply, text:expected}};
  }
}
