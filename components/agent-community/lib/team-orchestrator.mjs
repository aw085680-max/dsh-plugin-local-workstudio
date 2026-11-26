import {recoveredCodexResult} from "./team-session-recovery.mjs";
import {beginJointReview,matchedReview} from "./joint-review.mjs";
import {documentPreflight,preflightPrefix} from "./document-preflight.mjs";
import {documentOperations,hasDocumentOrder} from "./document-work-order.mjs";
import {attachedDocumentSources} from "./attached-document-sources.mjs";
import {documentApproval,approvalBlockReason} from "./document-approval.mjs";
import {pinSingleDeliverables} from "./single-file.mjs";
import {managedGroup} from "./group-routing.mjs";

import {deliveryPair,reviewInstruction} from "./unattended.mjs";
import {TaskReminders, requestsFile} from "./task-reminders.mjs";
import {TeamFollowup} from "./team-followup.mjs";
import {TeamReview,claimsReview} from "./team-review.mjs";
import {TeamSessionBridge} from "./team-session-bridge.mjs";
import {TeamChat} from "./team-chat.mjs";
import {TeamMemberAssignments, parseMemberAssignments} from "./team-member-assignments.mjs";
import {ThreadCloser} from "./team-thread-close.mjs";
import {classifyGroupMessage, classifyUserRequest, maskGroupLinks, displayReply, isChatRun, requestMessageId} from "./team-chat-routing.mjs";
import {randomUUID,createHash} from "node:crypto";
import {appendFile,readFile,writeFile,mkdir,rename,unlink,readdir,realpath} from "node:fs/promises";
import {join,basename,resolve,relative} from "node:path";
import {TaskStore} from "./team-store.mjs";
import {bindingRefusal,failedBeforeCodexTurn,copy,canonical,digest,emptyState,effectiveMembers,manifestOf,completionReady,signatureVerified,TransitionError,apply} from "./team-machine.mjs";
import {fileSha256,finalFileRefs,requiresFinalDelivery,hasFinalSignatures,stageVersionFiles,isLegacyCap,recoverLegacyCap} from "./team-delivery.mjs";
const now=()=>new Date().toISOString();
const ended=s=>["succeeded","failed","cancelled"].includes(s);
const live=s=>!["completed","stopped"].includes(s.status);
const absent=x=>x===undefined||x===null;
const continuationTtlMs = 30 * 1000;
const maxDeliveryDurationMs = 4 * 60 * 60 * 1000;
// Local Agent emits this before it asks the Codex App Server to start a turn.
const codexResumeWriterError = /^(?:宿主受理或回合启动证据缺失：)?agent-community: 模型请求失败（provider=codex-cli model=[^）\r\n]+）：Codex native continuation was not accepted for persisted thread ([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}): thread \1 already has an active writer(?:[。.]|$)/iu;

function choiceExpired(request, at = Date.now()) {
  // Requests saved before the chooser had a deadline cannot confer fresh authorization.
  return !(Date.parse(request?.expiresAt) > at);
}
function summarizeTeamGoal(value) {
  if (typeof value !== "string") return "";
  const reference = /(?:file:\/+|https?:\/\/|[a-z]:[\\/]|\\\\|(?:^|\s)(?:\.{1,2}[\\/]|~[\\/]|\/(?=[\w\p{Script=Han}])))/iu;
  const clauses = value
    .replace(/\u0060{3}[\s\S]*?(?:\u0060{3}|$)/g, "\n")
    .replace(/!\[[^\]]*\]\([^)\r\n]*\)/g, "")
    .replace(/\[([^\]\r\n]+)\]\([^)\r\n]*\)/g, "$1")
    .replace(/["“'\u0060]([^"”'\u0060\r\n]+)["”'\u0060]/gu,
      (quoted, contents) => reference.test(contents) ? "" : quoted)
    .split(/[\r\n，。；！？!?]+/u)
    .map(clause => {
      const location = clause.search(reference);
      if (location >= 0) clause = clause.slice(0, location);
      return clause
        .replace(/@[^\s，。；、!！?？]+/gu, "")
        .replace(/^\s*(?:[#>*-]+\s*|\d+[.)、．]\s*)+/u, "")
        .replace(/^(?:现在(?:我)?|我(?:希望|需要|想(?:要)?))?(?:请|麻烦|你们|你)?\s*/u, "")
        .replace(/[*\u0060]/g, "")
        .trim();
    })
    .filter(clause => /\p{L}/u.test(clause) && !/^(?:文件|资料|路径|附件|参考资料)[：:\s]*$/u.test(clause));
  const text = clauses.join(" ");
  const explicit = clauses.find(clause => /^(?:任务标题|任务目标|交付目标|目标)[：:]\s*\S/u.test(clause));
  const topic = text.match(/(?:针对|关于)(?:本次|这次|此次|该)?\s*([\p{L}\p{N}·《》 -]{2,22}?)的(?:具体|主要|新)?要求/u)?.[1]?.trim();
  const asksForPlan = /(?:执行|实施|复测|测试|修复|整改)方案|(?:制定|编写|拟定|给出|出|制作)[^，。；]{0,12}方案/u.test(text);
  const action = clauses.find(clause =>
    /^(?:(?:请|先|按|根据|依据|按照|结合|对照|继续|用|从|把|将|对|为).{0,22}?)?(?:排查|修复|复核|检查|验证|测试|复测|制定|编写|撰写|拟定|整理|实现|完成|修改|更新|优化|升级|核对|迁移|部署|生成|分析|设计|总结|统计|确认|交付)\S/u.test(clause) ||
    /^(?:fix|review|draft|summarize|prepare|investigate|implement|test|update|verify)\b/i.test(clause));
  let goal = explicit?.replace(/^[^：:]+[：:]\s*/u, "");
  if (!goal && asksForPlan && topic) goal = (/(?:视频|录屏)/u.test(text) ? "按视频要求" : "") + "制定" + topic + "方案";
  goal ||= action || clauses.find(clause => clause.length >= 5 && !/^(?:文件|资料|附件|提示|注意)[：:]/u.test(clause)) || "";
  const characters = Array.from(goal.replace(/\s+/g, " "));
  return characters.length <= 38 ? characters.join("") : characters.slice(0, 37).join("") + "…";
}
export class TeamOrchestrator {
  constructor(svc,helpers){
    this.svc=svc;this.helpers=helpers;this.work=new Map();this.originals={};this.goalCache=new Map();this.handoffTextCache=new Map();this.opened=false;this.draining=false;
    this.legacyCapped=new Map();this.deliveryReceipts=new Map();this.nextDocumentCheck=new Map();
    this.store=new TaskStore({root:join(svc.home,"agent-community","team-tasks"),logger:svc.ctx.logger,
      onLockLost:error=>{svc.writesBlocked=true;svc.executor?.dispose();svc.ctx.logger.error("编排停止："+error.message);}});
    this.sessionBridge=new TeamSessionBridge(this);this.runtimeWork=new Map();this.stoppedCodexChecks=new Map();this.waitingTerminals=new Map();
    this.review=new TeamReview(this);this.followup=new TeamFollowup(this);this.chat=new TeamChat(this);this.assignments=new TeamMemberAssignments(this);this.threadCloser=new ThreadCloser(this);this.reminders=new TaskReminders(this);this.install();
  }
  isGroup(id){return this.svc.getRoom(id)?.directBotId===undefined&&!!this.svc.getRoom(id);}
  managed(run){return !!run?.teamTaskId;}
  roomReply(run){
    return isChatRun(run) || run?.origin==="user"&&typeof run.originMessageId==="string"&&run.mentionTask==="chat:"+run.originMessageId;
  }

  canClaimRoomReply(run){
    if(isChatRun(run))return this.chat.canClaim(run);
    const message=this.svc.state.messages.find(m=>m.id===run.originMessageId&&m.roomId===run.roomId&&m.sender.kind==="user");
    const snapshot=message?.authorizationSnapshot;
    return message?.mentionTask===run.mentionTask&&snapshot?.messageId===run.mentionAuthorizedBy&&
      snapshot?.members?.length===1&&snapshot.members[0]===run.botId&&this.currentMembers(run.roomId).includes(run.botId);
  }
  recordForRun(run){return run?.teamTaskId?this.store.get(run.teamTaskId):undefined;}
  currentMembers(roomId){const room=this.svc.getRoom(roomId);return (room?.memberIds??[]).filter(id=>{
    const b=this.svc.getBot(id);return b&&!b.disabled&&b.enabled!==false&&!(room.revokedMemberIds??[]).includes(id);
  });}
  assert(){this.store.assert();if(!this.opened)throw Error("任务编排尚未就绪");}
  async open(load){
    try {
      await this.store.open({keepWriterOnError:true});
      // Verify the opened snapshot before allowing task lookups.
      this.store.list();
    } catch(error) {
      if(!this.store.lock.held){
        this.svc.writesBlocked=true;
        throw error;
      }
      this.svc.ctx.logger.warn("任务库暂不可用，群聊仍可运行："+error.message);
      this.store.failed=error;
    }
    this.loadingState=true;
    try { if(load)await load(); }
    finally { this.loadingState=false; }
    if(this.svc.writesBlocked)throw Error("群聊记录不可写");
    if(!this.store.failed){
      await this.reminders.open();
      this.opened=true;
      try {
        await this.migrate();
        await this.rebuildProjection();
        await this.recoverDocumentBlocks();
      }catch(error){
        this.opened=false;
        this.store.failed=error;
        this.svc.ctx.logger.warn("任务资料待核对，群聊仍可运行："+error.message);
      }
    }
    if(this.opened){
      const directory=join(this.store.root,"message-outbox");
      await mkdir(directory,{recursive:true});
      for(const file of await readdir(directory)){
        if(!/^[a-f0-9]{64}\.json$/u.test(file))continue;
        const packet=JSON.parse(await readFile(join(directory,file),"utf8"));this.store.checkSeal(packet);
        const msg=packet.message;
        if(!this.svc.getRoom(msg.roomId)||msg.sender.kind!=="user"||digest([msg.roomId,msg.id])+".json"!==file)continue;
        await this.persistMessage(msg,{recover:true});
        await unlink(join(directory,file)).catch(e=>{if(e.code!=="ENOENT")throw e;});
      }
    }
    await this.expireChoices();
    if(this.opened)await this.threadCloser.recover();
    await this.chat.recover();
    this.timer=setInterval(async()=>{
      try{await this.expireChoices();if(this.opened)await this.drain();}
      catch(error){this.svc.ctx.logger.warn("编排恢复等待："+error.message);}
    },1500);this.timer.unref?.();
  }
  async close(){clearInterval(this.timer);await this.reminders.close();this.opened=false;await this.store.close();}
  async serial(id,fn){const old=this.work.get(id)??Promise.resolve(),p=old.catch(()=>{}).then(fn);this.work.set(id,p);try{return await p;}finally{if(this.work.get(id)===p)this.work.delete(id);}}
  events(type,payload,id){return this.store.event(type,payload,id);}
  async commit(id,events,revision){
    for(let attempt=0;;attempt++){
      const r=this.store.get(id),members=this.currentMembers(r.state.roomId);
      const list=canonical(members)===canonical(r.state.permissions)?events:[this.events("PERMISSIONS_OBSERVED",{members}),...events];
      try {const next=await this.store.commit(id,list,{expectedRevision:revision??r.revision});await this.project(next);return next;}catch(error){
        if(revision!==undefined||error.code!=="STALE_REVISION"||attempt>=3)throw error;
      }
    }
  }
  runInput(run){return {taskId:run.teamTaskId,stepId:run.teamStepId,dispatchId:run.dispatchId,attemptId:run.attemptId,ticketId:run.ticketId,targetId:run.botId};}
  async waitRuntime(roomId,botId){const run=this.svc.activeHandoffRun(roomId,botId);if(run){await this.sessionBridge.pending(run.id);await this.runtimeWork.get(run.id);}}
  actorRun(roomId,botId){
    const run=this.svc.activeHandoffRun(roomId,botId);
    if(!this.managed(run))throw new TransitionError("UNTRUSTED_ACTOR","没有该成员的宿主可信运行身份");
    const r=this.recordForRun(run),d=r?.state.dispatches[run.dispatchId];
    if(!d||d.runId!==run.id||d.targetId!==botId||!this.canClaim(run))throw new TransitionError("STALE_ACTOR","运行身份或授权已失效");
    if(r.state.roles.kind==="member-assignment")throw new TransitionError("MEMBER_REPLY_ONLY","请完成分给你的工作并在原群回复。其他成员由系统派单。");
    if(r.state.roles.kind==="ordered-chat")throw new TransitionError("CHAT_REPLY_ONLY","顺序接话已由系统安排，请直接回复用户");
    return {run,r,p:{...this.runInput(run),actor:{kind:"host-run",botId,runId:run.id}}};
  }
  canClaim(run){
    if(!this.opened)return this.loadingState===true&&this.managed(run);
    if(!this.managed(run))return false;
    if(this.threadCloser.closure(run.roomId,run.teamTaskId))return false;
    if(!this.store.lock.held||this.store.failed)return false;
    const s=this.recordForRun(run)?.state,d=s?.dispatches[run.dispatchId],step=d&&s.steps[d.stepId];
    return !!d&&live(s)&&s.status!=="stopping"&&step.currentAttemptId===d.attemptId&&
      (s.authSnapshots[d.authorizationId]?.members??[]).includes(run.botId)&&this.currentMembers(run.roomId).includes(run.botId)&&
      !["revoked","terminal"].includes(d.status);
  }
  blockingTask(run) {
    return this.svc.state.runs.find(other => !isChatRun(other) && other.id !== run.id &&
      other.botId === run.botId && other.status === "running");
  }
  canStart(run){
    return this.canClaim(run)&&!this.svc.getRoom(run.roomId)?.paused&&
      !this.blockingTask(run)&&
      !this.svc.executor?.isBotStopBlocked(run.botId);
  }
  wrap(name,fn){const original=this.svc[name]?.bind(this.svc);if(!original)throw Error("集成入口缺失："+name);this.originals[name]=original;this.svc[name]=(...args)=>fn(original,...args);}
  install(){
    this.wrap("sendMessageInRoom",(old,input)=>this.isGroup(input.roomId)?this.serial("ingress:"+input.roomId,()=>this.send(input)):old(input));
    this.wrap("submitMentionHandoff",(old,input)=>this.isGroup(input.roomId)?this.submit(input):old(input));
    this.wrap("acceptMentionHandoff",(old,input)=>this.isGroup(input.roomId)?this.accept(input):old(input));
    this.wrap("mentionHandoffStatus",(old,input)=>this.isGroup(input.roomId)?this.handoffStatus(input):old(input));
    this.wrap("gateFinishTask",(old,input)=>this.isGroup(input.roomId)?this.confirm(input):old(input));
    this.wrap("approveTeamReview",(old,input)=>this.isGroup(input.roomId)?this.confirm(input):old(input));
    this.wrap("mayClaimMentionRun",(old,run)=>this.managed(run)?this.canClaim(run):this.roomReply(run)?this.canClaimRoomReply(run):this.isGroup(run.roomId)?false:old(run));
    this.wrap("mayStartMentionRelay",(old,run)=>this.managed(run)?this.canStart(run):isChatRun(run)?this.chat.canClaim(run):old(run));
    this.wrap("recordRunUpstream",(old,runId,upstream)=>{
      old(runId,upstream);const run=this.svc.state.runs.find(r=>r.id===runId);if(!this.managed(run)||!upstream.turnId)return;
      const prior=this.runtimeWork.get(runId)??Promise.resolve();
      const job=prior.then(async()=>{await this.sessionBridge.pending(runId);await this.runtimeStarted(runId,{sessionId:run.sessionId,threadId:upstream.threadId,turnId:upstream.turnId,source:"codex-app-server"});});
      this.runtimeWork.set(runId,job);job.catch(e=>this.svc.ctx.logger.warn("回合绑定待核对："+e.message));
    });
    this.wrap("persistRunStop",async(old,runId,stop)=>{
      const run=this.svc.state.runs.find(r=>r.id===runId);
      if(this.managed(run))await this.commit(run.teamTaskId,[this.events("TARGET_STOP_REQUESTED",{...this.runInput(run),stop})]);
      return old(runId,stop);
    });
    this.wrap("canRetryToolRelay",(old,run)=>{
      if(!this.managed(run))return old(run);
      const s=this.recordForRun(run)?.state,d=s?.dispatches[run.dispatchId],a=d&&s.steps[d.stepId]?.attempts[d.attemptId];
      return !!s&&s.roles.kind!=="member-assignment"&&!s.stop&&live(s)&&run.status==="failed"&&a?.stopVerified===true&&(d.terminal?.receipt?.kind==="codex-resume-active-writer"||["failed","interrupted","aborted","error"].includes(d.terminal?.receipt?.status));
    });
    this.wrap("retryRun",(old,input)=>{const run=this.svc.state.runs.find(r=>r.id===input.id);if(isChatRun(run))return this.svc.continueTeamTask({roomId:run.roomId,messageId:run.originMessageId,runId:run.id,expectedRevision:input.expectedRevision,mode:"retry-message"});return this.managed(run)?this.retry(run,false,input):old(input);});
    this.wrap("controlRun",async(old,input)=>{const run=this.svc.state.runs.find(r=>r.id===input.id);
      if(this.managed(run)&&["cancel","interrupt"].includes(input.action)){
        if(run.controlRevision!==input.expectedRevision)throw Error("原记录已更新，请刷新");
        await this.stop(run.teamTaskId,"用户主动停止");return this.svc.state.runs.find(r=>r.id===run.id);
      }
      return old(input);
    });
    this.wrap("claimRun",async(old,input)=>{
      const run=this.svc.state.runs.find(r=>r.id===input.id);if(!this.managed(run))return old(input);
      this.assert();if(!this.canStart(run))throw Error("当前棒没有有效授权，或目标尚忙");
      const r=this.recordForRun(run),d=r.state.dispatches[run.dispatchId];
      if(d.status!=="pending")throw Error("原投递尚未核对，禁止创建重复回合");
      await this.commit(run.teamTaskId,[this.events("DELIVERY_STARTED",{...this.runInput(run),verifiedAbsent:!!d.absenceProof})]);
      return old(input);
    });
    this.wrap("settleRun",async(old,input)=>{
      const run=this.svc.state.runs.find(r=>r.id===input.id);
      if(isChatRun(run)){
        const resolved=await this.chat.resolveConditional(run,input);
        const result=await old(this.chat.settlement(run,resolved));
        await this.chat.settled(result);
        return result;
      }
      if(!this.managed(run))return old(this.roomReply(run)?{...input,retry:false}:input);
      const assignment=this.recordForRun(run)?.state.roles.assignment;
      if(assignment&&this.recordForRun(run).state.dispatches[run.dispatchId]?.status==="revoked")return run;
      let status;
      try {
        status=await this.settle(run,input);
        this.waitingTerminals.delete(run.id);
      } catch (error) {
        if (!this.store.isRecordSharingError(run.teamTaskId,error)) throw error;
        // The host has already returned. Keep its original result for the same dispatch.
        // Returning the unmodified run releases the executor without reporting completion.
        this.waitingTerminals.set(run.id,{input,after:Date.now()+1500});
        return run;
      }
      const rejected=this.startWasRejected(run);
      const latest=this.svc.state.runs.find(row=>row.id===run.id);
      const reply=status==="completed"&&!latest?.stop&&!this.threadCloser.closure(run.roomId,run.teamTaskId)&&input.reply?{
        ...input.reply,text:claimsReview(input.reply.text??"")&&this.recordForRun(run)?.state.roles.confirmers?.length===2?
          this.review.guardText(input.reply.text,this.recordForRun(run),run.botId):displayReply(input.reply.text,assignment?"":completionReady(this.store.get(run.teamTaskId).state)?
          "成果已核对，交付状态可在任务详情中查看。":"本棒回合已结束。")
      }:undefined;
      const result=await old({...input,reply,status,retry:false,...rejected&&status==="failed"?{error:input.error??"Codex 会话占用，原回合未启动"}:{}});
      if(rejected){
        this.svc.executor?.clearRejectedStart(run.id);
        await this.svc.flushNow();
      }
      if(assignment){
        await this.svc.flushNow();
        // Member replies become observable only after the host has persisted the settled run.
        const record=this.recordForRun(run);
        if(record)await this.reminders.observe(record,{force:true});
      }
      await this.advance(run.teamTaskId);return result;
    });
    this.wrap("offerHandoffsForRun",(old,run)=>this.managed(run)?this.promptForRun(run):old(run));
    this.wrap("taskContextFor",(old,run)=>this.roomReply(run)?
      "这是用户点名的一次群聊。直接、简短回应当前消息；追问任务进度时根据群里已有记录回答。":
      old(run));
    for(const name of ["advanceMentionSequence","settleMentionHandoffs","afterRunSettled","noteRoundRunStarted","decideRoundForRun","recordTaskSegmentReport"]){
      this.wrap(name,(old,run,...args)=>(this.managed(run)||this.roomReply(run))?(["settleMentionHandoffs","advanceMentionSequence"].includes(name)?Promise.resolve():undefined):old(run,...args));
    }
    this.wrap("restoreMentionSequences",()=>undefined);
    this.wrap("enqueueGroupRun",(old,roomId,...args)=>this.isGroup(roomId)?false:old(roomId,...args));
    this.wrap("dispatchToMembers",(old,input)=>{
      if(!this.isGroup(input.roomId))return old(input);
      return {ok:false,queued:[],refused:[],reason:"群派单必须由当前可信回合提交到任务编排服务。"};
    });
    this.wrap("queueMentionSequenceRun",(old,input)=>this.isGroup(input.room.id)?undefined:old(input));
    this.wrap("commitToolRelay",(old,roomId,...args)=>{
      if(this.isGroup(roomId))throw new TransitionError("LEGACY_WRITE_BLOCKED","受管群禁止旧 groupTask/relay 提交");return old(roomId,...args);
    });
    this.wrap("taskContinuationCandidates",(old,roomId)=>this.isGroup(roomId)?this.opened?this.taskCandidates(roomId).map(r=>this.choiceView(r)):[]:old(roomId));
    this.wrap("continueTeamTask", (old, input) => this.isGroup(input.roomId)
      ? this.svc.roomMessageMutex.run(input.roomId, () => this.continueChoice(input))
      : old(input));
    this.wrap("postBotMessage",(old,input)=>this.isGroup(input.roomId)?this.botMessage(input):old(input));
  }
  async migrate({dryRun=false}={}){
    const source=this.svc.state,report=[];
    for(const room of source.rooms.filter(r=>r.directBotId===undefined)){
      const relays=(room.mentionSequences??[]).filter(r=>typeof r.taskKey==="string"&&r.taskKey),byTask=new Map(relays.map(r=>[r.taskKey,r]));
      for(const message of source.messages.filter(m=>m.roomId===room.id&&m.sender.kind==="user"&&m.runtime!=="chat"&&!m.memberAssignments?.length&&!m.mentionTask?.startsWith("chat:"))){
        const roles=this.helpers.parseRoles(message.text,source.bots.filter(b=>room.memberIds.includes(b.id)));
        const rootKey=message.mentionTask??"thread:"+message.id;
        const text=this.helpers.parseMentions(message.text,source.bots).remainder??message.text;
        const explicitTask=classifyGroupMessage(text,{hasReference:!!message.attachments?.length}).intent==="create";
        if(!byTask.has(rootKey)&&explicitTask){
          const saved=this.svc.teamWorkflowFor(room),sequence=roles?.sequence??saved?.memberIds??room.memberIds.slice(0,2);
          byTask.set(rootKey,{taskKey:rootKey,authorizedMessageId:message.id,status:"waiting",steps:[],members:sequence,firstBotId:sequence[0],reviewerId:roles?.reviewerId??saved?.reviewerId??sequence[1],supervisorId:roles?.supervisorId??saved?.supervisorId});
        }
      }
      for(const handoff of room.mentionHandoffs??[]){
        const taskId=handoff.taskKey??"legacy-handoff:"+handoff.id;if(byTask.has(taskId))continue;
        const offered=source.runs.find(r=>r.id===handoff.offeredRunId),members=[handoff.fromBotId,handoff.toBotId].filter(Boolean);
        byTask.set(taskId,{id:handoff.relayId,taskKey:taskId,authorizedMessageId:taskId.startsWith("thread:")?taskId.slice(7):offered?.originMessageId,status:"waiting",members,steps:[],firstBotId:members[0],reviewerId:members[1]});
      }
      for(const [taskId,relay] of byTask){
        if(this.store.get(taskId)?.revision>0){report.push({taskId,state:"already-migrated"});continue;}
        const authorizing=source.messages.find(m=>m.id===relay.authorizedMessageId&&m.roomId===room.id&&m.sender.kind==="user");
        const rootId=taskId.startsWith("thread:")?taskId.slice(7):null;
        const original=source.messages.find(m=>m.id===rootId&&m.roomId===room.id&&m.sender.kind==="user")??authorizing;
        const runRows=source.runs.filter(r=>r.roomId===room.id&&(r.mentionTask===taskId||!!relay.id&&r.mentionRelayId===relay.id));
        const legacyHandoffs=(room.mentionHandoffs??[]).filter(h=>h.taskKey===taskId||(relay.id&&h.relayId===relay.id)||(!h.taskKey&&taskId==="legacy-handoff:"+h.id));
        const roster=source.bots.filter(b=>room.memberIds.includes(b.id));
        const authored=this.helpers.parseMentions(authorizing?.text??original?.text??"",roster);
        const marked=authored.who==="everyone"?room.memberIds:authored.ids;
        const explicitAuth=authorizing?.authorizationSnapshot?.members??authorizing?.mentions??original?.mentions??marked;
        const verified=authorizing?.authorizationSnapshot?.messageId===authorizing?.id&&!!authorizing;
        const auth=[...new Set(explicitAuth)].filter(id=>this.currentMembers(room.id).includes(id)&&
          (verified||marked.includes(id))&&(!relay.authorizedMemberIds||relay.authorizedMemberIds.includes(id)));
        const originalBody=this.helpers.parseMentions(original?.text??"",roster).remainder??"";
        const intent=classifyGroupMessage(originalBody,{hasReference:!!original?.attachments?.length}).intent;
        const legacyProof=legacyHandoffs.some(h=>auth.includes(h.fromBotId)&&auth.includes(h.toBotId))&&
          runRows.some(r=>r.originMessageId===original?.id&&r.origin==="user"&&auth.includes(r.botId));
        if(!original||original.sender.kind!=="user"||!originalBody.trim()||!auth.length||original.runtime==="chat"||
          ["ordered-chat","progress"].includes(intent)||!(intent==="create"||legacyProof)){
          report.push({taskId,state:"skipped",reason:"未核实原任务意图、原文或授权"});
          continue;
        }
        if(dryRun){report.push({taskId,state:"eligible",runIds:runRows.map(r=>r.id),authorized:auth});continue;}
        const blob=await this.store.putBlob({roomId:room.id,relay,relays:(room.mentionSequences??[]).filter(r=>r.taskKey===taskId),message:original,authorizingMessage:authorizing??null,runs:runRows,handoffs:legacyHandoffs},"json");
        const s=emptyState(taskId),authorizationId=authorizing?.id??original.id;
        s.roomId=room.id;s.goalRef=original?await this.store.putBlob(original,"json"):null;
        s.authSnapshots[authorizationId]={messageId:authorizationId,members:auth,source:"migration",at:authorizing?.createdAt??original?.createdAt??relay.createdAt??now()};
        s.activeAuthorizationId=authorizationId;s.permissions=this.currentMembers(room.id);
        const savedRoles=this.svc.teamWorkflowFor(room),originalRoles=original?this.helpers.parseRoles(original.text,source.bots.filter(b=>room.memberIds.includes(b.id))):null;
        const first=relay.firstBotId??originalRoles?.sequence?.[0]??savedRoles?.firstBotId??relay.members?.[0];
        const reviewer=relay.reviewerId??originalRoles?.reviewerId??savedRoles?.reviewerId??(relay.members?.length===2?relay.members.find(id=>id!==first):null);
        s.roles={first,reviewer,supervisor:relay.supervisorId??originalRoles?.supervisorId??savedRoles?.supervisorId,
          confirmers:first&&reviewer&&first!==reviewer?[first,reviewer]:[]};
        s.status=relay.status==="completed"?"completed":["cancelled","stopped"].includes(relay.status)?"stopped":"pending-review";
        s.messages=original?[s.goalRef]:[];s.history={sourceRef:blob,legacyRelayId:relay.id??null,runIds:runRows.map(r=>r.id),originalStatus:relay.status,canResume:!!original};
        s.missing=s.status==="pending-review"?[!original?"缺少原用户任务消息":!auth.length?"缺少可验证的原授权快照":"历史任务等待用户明确续做"]:[];s.stop=s.status==="stopped"?{reason:"历史任务已停止",at:relay.updatedAt??now()}:null;
        for(const h of legacyHandoffs)s.handoffs[h.id]={id:h.id,targetId:h.toBotId,fromBotId:h.fromBotId,fromStepId:"legacy:"+String(h.fromRelayStep??0),
          fromDispatchId:h.offeredRunId??"legacy",contentHash:digest({texts:h.texts,files:h.files}),textRef:await this.store.putBlob(h.texts??[],"json"),
          evidenceRefs:await Promise.all((h.files??[]).map(async f=>{try{return {...await this.store.putBlob(await readFile(f.targetPath??f.sourcePath),"file"),name:f.name};}catch{return {id:f.sha256??digest(f),sha256:f.sha256??"",kind:"missing",name:f.name,missing:true};}})),
          status:h.state==="completed"?"resolved":"pending",legacy:copy(h),acceptedRunId:h.acceptedRunId??null};
        await this.store.create(taskId,[this.events("HISTORY_IMPORTED",{state:s,sourceSha256:digest({relay,original,runRows,legacyHandoffs})},"migrate:"+digest(taskId))]);
        report.push({taskId,state:s.status,runIds:runRows.map(r=>r.id),missing:s.missing,sourceRef:blob});
        this.fault?.("migration-after-task",{taskId});
      }
    }
    if(dryRun)return report;
    await writeFile(join(this.store.root,"migration-receipt.json"),JSON.stringify({schemaVersion:1,at:now(),report,legacyStateHash:digest(source)},null,2));
    this.migration=report;return report;
  }
  async rebuildProjection(){
    for(const r of this.store.list()){
      const s=r.state;
      if(s.status==="completed"&&s.history?.sourceRef&&!s.versionId){
        const snapshot=JSON.parse((await this.store.readBlob(s.history.sourceRef)).toString());
        if(isLegacyCap(snapshot,s))this.legacyCapped.set(s.taskId,snapshot);
      }
      await this.project(r);
    }
    await this.svc.flushNow();
  }
  async onLedgerRecovered(){
    if(!this.opened)return;
    for(const r of this.store.list()){
      const goal=this.goalCache.get(r.taskId);
      if(goal?.sender?.kind==="user"&&goal.taskRef===r.taskId&&goal.roomId===r.state.roomId&&this.svc.getRoom(goal.roomId)){
        const seen=this.svc.ledger.listLedger(goal.roomId,{force:true,limit:Number.MAX_SAFE_INTEGER}).some(row=>row.type==="user"&&row.messageId===goal.id);
        if(!seen||!this.svc.state.messages.some(m=>m.roomId===goal.roomId&&m.id===goal.id))await this.persistMessage(goal,{recover:true});
      }
      if(r.state.status!=="completed"||!hasFinalSignatures(r.state)||!requiresFinalDelivery(r.state))continue;
      await this.readFinalReceipt(r.state);
      await this.project(r);
    }
    await this.svc.flushNow();
    await this.reminders.recover();
  }
  signatureDeliveryNeeded(s) {
    return hasFinalSignatures(s)&&requiresFinalDelivery(s)&&
      this.deliveryReceipts.get(s.taskId)?.versionId!==s.versionId&&!s.stop;
  }
  resumeKind(s) {
    if(s.stop)return null;
    if(s.status==="pending-review"&&s.missing?.some(text=>text.startsWith(preflightPrefix)||text.startsWith("宿主审批阻塞（")))return "handoff";
    if(s.status==="completed"&&this.legacyCapped.has(s.taskId))return "legacy-cap";
    if(this.signatureDeliveryNeeded(s)&&s.status==="completed")return "final-delivery";
    const current=s.steps[s.currentStepId];
    if(s.status==="pending-review"&&current&&ended(current.status)){
      const last=s.dispatches[current.attempts[current.currentAttemptId]?.dispatchId];
      if(failedBeforeCodexTurn(last?.terminal?.receipt?.kind)&&effectiveMembers(s).includes(current.targetId))return "start-rejected";
      if(this.signatureDeliveryNeeded(s))return "final-delivery";
      if(last&&this.review.missingDecision(this.store.get(s.taskId),last))return "handoff";
      if(Object.values(s.handoffs).some(h=>
        ["pending","scheduled","accepted"].includes(h.status)&&effectiveMembers(s).includes(h.targetId)))return "handoff";
    }
    return null;
  }
  async observeMembership(roomId) {
    const members=this.currentMembers(roomId);
    for(const record of this.store.list().filter(r=>r.state.roomId===roomId))
      if(canonical(members)!==canonical(record.state.permissions))
        await this.commit(record.taskId,[this.events("PERMISSIONS_OBSERVED",{members})]);
    await this.svc.flushNow();
  }
  statusView(s) {
    if(s.status==="stopped")return {status:s.status,resume:null,missing:[]};
    const resume=this.resumeKind(s);
    if(resume==="legacy-cap")return {status:"pending-review",resume,
      missing:["原待办仍在，选择「继续原任务」将沿原授权接棒"]};
    if(this.signatureDeliveryNeeded(s)&&s.status!=="verifying"&&s.status!=="stopping"){
      const detail=s.missing[0]??{pending:"下一棒等待投递",delivered:"交付成员已收件",running:"交付成员正在核对并交稿"}[s.status];
      return {status:"pending-delivery",resume,missing:[detail??"同版本已签核，等待交付成员发出文件"]};
    }
    return {status:s.status,resume,missing:s.missing};
  }
  documentAccess(sessionId) {
    const runs=this.svc.state.runs.filter(r=>r.status==="running"&&r.sessionId===sessionId&&this.managed(r));
    if(runs.length!==1)return null;
    const run=runs[0], state=this.recordForRun(run)?.state, room=this.svc.getRoom(run.roomId);
    if(!hasDocumentOrder(state))return null;
    return {taskId:run.teamTaskId,dispatchId:run.dispatchId,singleFile:!!state.roles.assignment?.singleFile,operations:this.canClaim(run)?
      documentOperations(state,run,room,this.currentMembers(run.roomId)):[]};
  }
  async documentDraftWorkspace(sessionId) {
    const access=this.documentAccess(sessionId);
    if (!access?.operations.length) return undefined;
    const run=this.svc.state.runs.find(r=>r.sessionId===sessionId && r.dispatchId===access.dispatchId);
    if (!run || this.svc.getRoom(run.roomId)?.paused) return undefined;
    const workspace=this.svc.runWorkspaceDir(run.botId);
    await mkdir(workspace,{recursive:true});
    const canonicalWorkspace=await realpath(workspace);
    const drafts=join(canonicalWorkspace,"document-drafts");
    const taskDir=join(drafts,digest(access.taskId));
    await mkdir(drafts,{recursive:true});
    if (await realpath(drafts)!==drafts) throw Error("本单草稿目录不在当前成员工作区");
    await mkdir(taskDir,{recursive:true});
    if (await realpath(taskDir)!==taskDir) throw Error("本单草稿目录不在当前成员工作区");
    return taskDir;
  }
  async documentBlock(record, dispatch, includeEarlierRecoveries=false) {
    const audit = this.svc.ctx.get?.('sessionPersistence');
    const state = record.state;
    if (!audit || !(hasDocumentOrder(state)) || !state.roles.unattended || !dispatch?.terminal) return null;
    const run = this.svc.state.runs.find(row => row.id === dispatch.runId && row.teamTaskId === state.taskId && row.botId === dispatch.targetId);
    if (!run) return null;
    let stored;
    try {
      stored = await audit.open(run.sessionId, 'read');
      if (String(stored.header.id) !== run.sessionId || String(stored.id) !== run.sessionId) return null;
      const {events} = await stored.read();
      let current = dispatch;
      while (current) {
        const decision = documentApproval(events,current.dispatchId,true);
        if (decision) return approvalBlockReason(decision);
        if (!includeEarlierRecoveries) break;
        const requeue = record.events.findLast(e => e.type === 'REVIEW_REQUEUED' &&
          e.payload.targetId === current.targetId && e.payload.authorizationId === current.authorizationId &&
          e.payload.versionId === state.versionId && e.seq < record.events.find(e =>
            e.type === 'STEP_PLANNED' && e.payload.stepId === current.stepId)?.seq);
        const previous = requeue && state.dispatches[requeue.payload.dispatchId];
        if (!previous || state.steps[previous.stepId]?.order !== state.steps[current.stepId]?.order - 1 ||
            this.svc.state.runs.find(r => r.id===previous.runId)?.sessionId !== run.sessionId) break;
        current = previous;
      }
      return null;
    } catch (error) {
      this.svc.ctx.logger?.warn?.('无法读取派单的宿主审批记录：'+(error.code??error.name));
      return null;
    } finally { await stored?.close(); }
  }
  async recoverDocumentBlocks() {
    for (const record of this.store.list()) {
      const s=record.state, step=s.steps[s.currentStepId];
      if (!(hasDocumentOrder(s)) || s.status!=='pending-review' || !s.roles.unattended || !step ||
          !s.missing.some(text=>text.includes('两次补做后仍未交回'))) continue;
      const dispatch=s.dispatches[step.attempts[step.currentAttemptId]?.dispatchId];
      const reason=await this.documentBlock(record,dispatch,true);
      if (reason) await this.waitForAction(record.taskId,[reason]);
    }
  }
  async waitForAction(taskId,reasons) {
    const s=this.store.get(taskId).state;
    if(s.status==="pending-review"&&canonical(s.missing)===canonical(reasons))return;
    await this.commit(taskId,[this.events("WAITING",{reasons})]);
  }
  async readFinalReceipt(s) {
    const refs=finalFileRefs(s),reviewer=s.roles.reviewer,sender=s.roles.delivererId??reviewer;
    if(!refs.length||!reviewer)return null;
    const dispatches=Object.values(s.dispatches).filter(d=>d.targetId===sender&&(!s.authSnapshots[s.activeAuthorizationId]?.jointReview||s.steps[d.stepId]?.authorizationId===s.activeAuthorizationId)&&d.terminal?.status==="succeeded"&&(!s.roles.delivererId||s.steps[d.stepId]?.purpose==="final-delivery"));
    const runIds=new Set(dispatches.map(d=>d.runId));
    const rows=this.svc.ledger.listLedger(s.roomId,{force:true,limit:Number.MAX_SAFE_INTEGER});
    const files=new Map();
    const expected=new Set((s.manifests[s.versionId]?.evidence??[]).filter(ref=>ref.kind==="file").map(ref=>ref.sha256));
    for(const row of rows){
      if(row.type!=="deliverable"||row.botId!==sender||!runIds.has(row.runId))continue;
      const writing=this.svc.finalDeliveryJournalWrites?.get(row.id);
      if(writing&&!(await writing).ok)continue;
      for(const file of row.files){
        if(file.teamVersion!==s.versionId&&(s.status!=="completed"||file.teamVersion||
          row.runId!==s.dispatches[s.confirmations[reviewer]?.dispatchId]?.runId||row.at<s.confirmations[reviewer]?.at))continue;
        // Older cards had no digest. Verify their bytes before taking them as delivery evidence.
        let hash;
        try { hash=fileSha256(await readFile(file.path)); } catch { continue; }
        if(file.sha256&&file.sha256!==hash||!refs.some(ref=>ref.sha256===hash))continue;
        files.set(hash,{sha256:hash,name:file.name,runId:row.runId,cardId:row.id});
      }
    }
    if(![...expected].every(hash=>files.has(hash)))return null;
    const receipt={versionId:s.versionId,reviewerId:reviewer,...s.roles.delivererId?{delivererId:sender}:{},files:[...files.values()]};
    this.deliveryReceipts.set(s.taskId,receipt);
    return receipt;
  }
  async restoreDeliveredFile(s,file){
    const ref=finalFileRefs(s).find(ref=>ref.sha256===file.sha256&&basename(ref.name)===file.name);
    const root=join(this.store.root,"deliveries",digest(s.taskId));
    if(!ref||file.path!==join(root,s.versionId,ref.sha256,basename(ref.name)))throw Error("文件位置与签核清单不同");
    const bytes=await this.store.readBlob(ref),temporary=file.path+"."+randomUUID()+".tmp";
    await mkdir(resolve(file.path,".."),{recursive:true});
    try{await writeFile(temporary,bytes,{flag:"wx",flush:true});await rename(temporary,file.path);}
    finally{await unlink(temporary).catch(error=>{if(error.code!=="ENOENT")throw error;});}
    if(fileSha256(await readFile(file.path))!==file.sha256)throw Error("签核文件回读失败");
  }
  async prepareDeliverables(input,runId,files) {
    const run=this.svc.state.runs.find(row=>row.id===runId);
    if(!this.managed(run))return files;
    const s=this.recordForRun(run).state,refs=finalFileRefs(s);
    if(s.roles.assignment?.singleFile){
      const valid=()=>{const a=this.documentAccess(run.sessionId);return a?.singleFile && a.dispatchId===run.dispatchId && a.operations.includes("deliver");};
      if(!valid())throw Error("本单文件交付授权已失效");
      const workspace=await this.documentDraftWorkspace(run.sessionId);
      if(!workspace)throw Error("本单工作目录不可用");
      const result=await pinSingleDeliverables(files,workspace,join(this.store.root,"deliveries",digest(s.taskId)),run.originMessageId);
      if(!valid())throw Error("交付期间本单成员或派单已变化");
      return result;
    }
    if(hasDocumentOrder(s)){const access=this.documentAccess(run.sessionId);if(!access||access.dispatchId!==run.dispatchId||!access.operations.includes("deliver")||!hasFinalSignatures(s))throw Error("本单当前成员尚未获准交付该版本");}
    if(s.roles.delivererId && (!hasFinalSignatures(s)||s.steps[run.teamStepId]?.purpose!=="final-delivery"||run.botId!==s.roles.delivererId))throw Error("须由已登记的最终交付人在双签通过后的交付回合提交。");
    if(run.botId!==(s.roles.delivererId??s.roles.reviewer)||!refs.length||!this.canClaim(run))return files;
    const completed=await this.readFinalReceipt(s);
    const hashByFile=await Promise.all(files.map(async file=>({file,sha256:fileSha256(await readFile(file.path))})));
    const matching=hashByFile.filter(row=>refs.some(ref=>ref.sha256===row.sha256));
    if(s.roles.delivererId && (hashByFile.length!==refs.length || refs.some(ref=>!matching.some(row=>row.sha256===ref.sha256))))throw Error("交付文件与通过复核的完整版本不一致。");
    if(!matching.length)return files;
    const staged=await stageVersionFiles(this.store,s,join(this.store.root,"deliveries",...(s.roles.delivererId?[digest(s.taskId)]:[])));
    if(!this.canClaim(run)||this.recordForRun(run).state.versionId!==s.versionId)
      throw Error("交稿期间成果版本或运行授权已更新，请核对当前版本");
    return hashByFile.flatMap(({file,sha256})=>{
      const pinned=staged.find(row=>row.sha256===sha256);
      if(!pinned)return [file];
      if(completed?.files.some(row=>row.sha256===sha256))return [];
      return [{...file,...pinned,deliveryOriginalPath:file.path}];
    });
  }
  async project(record){
    const s=record.state,room=this.svc.getRoom(s.roomId);if(!room)return;
    if(s.goalRef&&!this.goalCache.has(s.taskId))this.goalCache.set(s.taskId,JSON.parse((await this.store.readBlob(s.goalRef)).toString()));
    const visible=this.statusView(s);
    const view={id:s.taskId,taskKey:s.taskId,mode:"orchestrated",schemaVersion:record.schemaVersion,revision:record.revision,
      status:visible.status,resumeKind:visible.resume,orderedChat:s.roles.kind==="ordered-chat",canStop:live(s)&&!s.stop&&s.status!=="stopping",title:(this.goalCache.get(s.taskId)?.text??"原任务").slice(0,100),goalSummary:summarizeTeamGoal(this.goalCache.get(s.taskId)?.text),activeRequestId:s.activeAuthorizationId,authorizedMemberIds:s.authSnapshots[s.activeAuthorizationId]?.members??[],members:s.roles.confirmers??[],
      firstBotId:s.roles.first,reviewerId:s.roles.reviewer,supervisorId:s.roles.supervisor,currentIndex:Math.max(0,s.order.length-1),
      steps:s.order.map(id=>{const p=s.steps[id],d=Object.values(s.dispatches).find(x=>x.attemptId===p.currentAttemptId);return {id,order:p.order,botId:p.targetId,status:p.status,runId:d?.runId,automaticRecoveryUsed:p.automaticRecoveries>0};}),
      missing:visible.missing,reviewReceipt:s.roles.confirmers?.length===2?this.review.feedback(record):null,consensus:s.versionId?{version:s.versionId,...s.manifests[s.versionId],required:s.roles.confirmers,confirmations:Object.values(s.confirmations)}:null};
    for(const h of Object.values(s.handoffs))if(h.textRef)this.handoffTextCache.set(h.id,JSON.parse((await this.store.readBlob(h.textRef)).toString()));
    if(s.roles.unattended){
      const goal=this.goalCache.get(s.taskId);
      const revisions=record.events.filter(e=>(e.type==="ARTIFACT_CONFIRMED"&&e.payload.reviewDecision?.action==="revise")||["REVIEW_HANDOFF_RECOVERED","USER_DRAFT_SUBMITTED"].includes(e.type));
      const decisions=record.events.filter(e=>e.payload.reviewDecision).map(e=>({actor:e.payload.targetId,...e.payload.reviewDecision}));
      const requirements=await Promise.all(s.messages.map(async ref=>JSON.parse((await this.store.readBlob(ref)).toString()).text));
      view.taskCard={origin:goal.id,owner:s.steps[s.currentStepId]?.targetId,drafts:revisions.length,requirements,decisions,
        draftsText:await Promise.all(revisions.map(async e=>({version:e.payload.manifest.versionId,body:(await this.store.readBlob(e.payload.manifest.bodyRef)).toString()})))};
    }
    const handoffs=Object.values(s.handoffs).map(h=>this.handoffView(s,h));
    this.svc.patchRoom(s.roomId,r=>({...r,teamTaskSchemaVersion:1,
      ...(r.teamCurrentRequest?.taskId===s.taskId&&[s.activeAuthorizationId,s.authSnapshots[s.activeAuthorizationId]?.originalMessageId].includes(r.teamCurrentRequest?.messageId)?{teamCurrentRequest:{...r.teamCurrentRequest,status:visible.status,revision:record.revision,reason:visible.missing[0]}}:{}),
      mentionSequences:[...(r.mentionSequences??[]).filter(v=>v.taskKey!==s.taskId),view],
      mentionHandoffs:[...(r.mentionHandoffs??[]).filter(h=>h.taskKey!==s.taskId),...handoffs]}));
    // state.json is a rebuildable UI/run projection, never a dispatch authority.
    for(const d of Object.values(s.dispatches)){
      const matches=this.svc.state.runs.filter(run=>run.id===d.runId);
      let old=matches[0];
      if(matches.length>1 && matches.every(run=>run.teamTaskId===s.taskId && run.dispatchId===d.dispatchId && run.attemptId===d.attemptId)){
        const expected=d.terminal?.status==="succeeded"?"completed":d.terminal?.status;
        old=matches.reduce((best,run)=>{
          if((run.status===expected)!==(best.status===expected))return run.status===expected?run:best;
          return run.controlRevision>best.controlRevision?run:best;
        });
        const rows=this.svc.state.runs;
        this.svc.state={...this.svc.state,runs:rows.flatMap(run=>run===matches[0]?[old]:run.id===d.runId?[]:[run])};
      }
      if(d.status==="revoked"){if(old&&["queued","running"].includes(old.status)){old.status="cancelled";old.controlRevision++;old.error="旧票据已撤销";old.finishedAt=now();}continue;}
      if(d.status==="terminal")continue;
      if(old){if(d.turn?.threadId&&!old.upstream)old.upstream={threadId:d.turn.threadId,turnId:d.turn.turnId,at:d.issuedAt};continue;}
      const payload=JSON.parse((await this.store.readBlob(d.payloadRef)).toString());
      const sessionId = s.bindings[d.targetId]?.sessionId ?? this.svc.ensureStableSession(
        s.roomId, d.targetId, s.roles.sessionScope === "task" ? s.taskId : undefined
      );
      const run={id:d.runId,botId:d.targetId,roomId:s.roomId,sessionId,origin:"user",publish:"visible",
        originMessageId:(s.roles.writerFinalReview?Object.values(s.authSnapshots).find(auth=>auth.documentWorkOrder?.taskId===s.taskId)?.documentWorkOrder.origin:undefined)??s.roles.assignment?.sourceMessageId??s.authSnapshots[d.authorizationId]?.originalMessageId??d.authorizationId,mentionAuthorizedBy:d.authorizationId,authorizedMemberIds:s.authSnapshots[d.authorizationId]?.members??[],
        mentionTask:s.taskId,teamTaskId:s.taskId,teamStepId:d.stepId,dispatchId:d.dispatchId,ticketId:d.ticketId,attemptId:d.attemptId,
        ...(d.turn?.threadId?{upstream:{threadId:d.turn.threadId,turnId:d.turn.turnId,at:d.issuedAt}}:{}),
        mentionStepOrder:s.steps[d.stepId].order,prompt:this.renderPayload(payload),status:d.status==="pending"?"queued":"running",
        controlRevision:0,attempt:Object.keys(s.steps[d.stepId].attempts).length-1,maxAttempts:1,createdAt:d.issuedAt,updatedAt:now()};
      // Other projections or a stop may have completed while the immutable payload was being read.
      const current=this.store.get(s.taskId)?.state.dispatches[d.dispatchId];
      if(!current||["terminal","revoked"].includes(current.status)||this.svc.state.runs.some(row=>row.id===d.runId))continue;
      this.svc.state={...this.svc.state,runs:[...this.svc.state.runs,{...run,runtime:"task",taskRef:s.taskId}]};
    }
    this.svc.enqueueWrite();
    await this.reminders.observe(record);
  }
  recipientFilePath(state, targetId, ref) {
    const directory = join(this.svc.runWorkspaceDir(targetId), "handoffs", "task-" + digest(state.taskId).slice(0,12));
    const name = basename(ref.name ?? "evidence");
    return state.roles.handoffFiles === "named"
      ? join(directory, ref.id, name)
      : join(directory, ref.id + "-" + name);
  }
  handoffView(s,h){
    const d=Object.values(s.dispatches).find(d=>d.stepId===h.stepId&&s.steps[d.stepId].currentAttemptId===d.attemptId);
    const assigned = ["scheduled","accepted","resolved"].includes(h.status);
    return {id:h.id,taskKey:s.taskId,relayId:s.taskId,step:h.step??h.fromStepId,fromBotId:h.fromBotId,toBotId:h.targetId,
      state:h.status==="scheduled"?"offered":h.status==="resolved"?"completed":h.status,texts:this.handoffTextCache.get(h.id)??h.legacy?.texts??[],
      files:(h.evidenceRefs??[]).map(ref=>({
        name:ref.name??ref.id,sha256:ref.sha256,size:ref.bytes??0,
        ...(ref.sourcePath ? {sourcePath:ref.sourcePath} : {}),
        ...(assigned && !ref.missing ? {targetPath:ref.targetPath ?? this.recipientFilePath(s,h.targetId,ref)} : {})
      })),
      fileCount:h.evidenceRefs?.length??0,...d?{offeredRunId:d.runId}:{},
      ...(h.acceptedDispatchId?{acceptedRunId:s.dispatches[h.acceptedDispatchId]?.runId??h.acceptedDispatchId,acceptedAt:h.acceptedAt}:{}),
      ...(h.acceptedRunId?{acceptedRunId:h.acceptedRunId}:{}),createdAt:h.at??h.legacy?.createdAt??"1970-01-01T00:00:00.000Z"};
  }
  pendingChoiceId(room) {
    return room?.teamCurrentRequest?.status === "pending-selection" ? room.teamCurrentRequest.messageId : undefined;
  }
  closeChoice(roomId, messageId, reason) {
    if (this.pendingChoiceId(this.svc.getRoom(roomId)) !== messageId) return false;
    this.svc.patchRoom(roomId, room => ({
      ...room,
      teamCurrentRequest: undefined,
      continuationRequests: (room.continuationRequests ?? []).map(request =>
        request.messageId === messageId && !request.selectedTaskKey && !request.closedAt
          ? { ...request, closedAt: now(), closedReason: reason } : request)
    }));
    return true;
  }
  async expireChoices() {
    for (const room of this.svc.state.rooms) {
      const messageId = this.pendingChoiceId(room);
      if (!messageId || !choiceExpired(room.continuationRequests?.find(request => request.messageId === messageId))) continue;
      await this.svc.roomMessageMutex.run(room.id, async () => {
        const latest = this.svc.getRoom(room.id);
        if (choiceExpired(latest?.continuationRequests?.find(request => request.messageId === messageId)) &&
            this.closeChoice(room.id, messageId, "expired")) {
          await this.svc.flushNow();
        }
      });
    }
  }
  async persistMessage(message,{recover=false}={}){
    const old=this.svc.state.messages.find(m=>m.id===message.id&&m.roomId===message.roomId);
    let pendingFile;
    if(!recover&&message.sender.kind==="user"&&this.opened&&!this.store.failed){
      const dir=join(this.store.root,"message-outbox");
      await mkdir(dir,{recursive:true});
      pendingFile=join(dir,digest([message.roomId,message.id])+".json");
      const temporary=pendingFile+"."+randomUUID()+".tmp";
      try{
        await writeFile(temporary,JSON.stringify(this.store.seal({message:old??message})),{flag:"wx",flush:true});
        await rename(temporary,pendingFile);
      }finally{await unlink(temporary).catch(error=>{if(error.code!=="ENOENT")throw error;});}
    }
    if(!old){
      if(!recover&&message.sender.kind==="user"){
        const previous=this.pendingChoiceId(this.svc.getRoom(message.roomId));
        if(previous&&previous!==message.id)this.closeChoice(message.roomId,previous,"superseded");
      }
      this.svc.state={...this.svc.state,messages:[...this.svc.state.messages,message]};
    }
    // An earlier flush can have failed after the in-memory insert. Retry the same projection.
    await this.svc.flushNow();
    const row=old??message, user=row.sender.kind==="user";
    const visible=this.svc.ledger.listLedger(row.roomId,{force:true,limit:Number.MAX_SAFE_INTEGER});
    if(!visible.some(e=>e.messageId===row.id&&e.type===(user?"user":"bot-text"))){
      this.svc.ledger.push({type:user?"user":"bot-text",roomId:row.roomId,text:row.text,senderName:row.sender.name,
        at:row.createdAt,messageId:row.id,presentation:row.presentation,runtime:row.runtime,replyTo:row.replyTo,
        threadId:row.threadId,attachments:row.attachments,runId:row.runId,botId:row.sender.botId});
    }
    if(pendingFile)await unlink(pendingFile).catch(error=>{if(error.code!=="ENOENT")throw error;});
    return row;
  }
  async send(input, original) {
    if(this.svc.writesBlocked)throw Error("群聊记录不可写");
    const room=this.svc.getRoom(input.roomId);
    if(!room||typeof input.text!=="string")throw Error("群聊或消息无效");
    const id=requestMessageId(room.id,input.requestId)??randomUUID();
    const requestHash=input.requestId && digest({text:input.text,mentions:input.mentions??[],replyTo:input.replyTo,threadId:input.threadId,taskId:input.taskId,continueTaskId:input.continueTaskId,action:input.submissionAction??"chat",attachments:input.attachments??[]});
    const duplicate=this.svc.state.messages.find(m=>m.id===id&&m.roomId===room.id&&m.sender.kind==="user");
    if(duplicate){
      if(duplicate.requestHash && duplicate.requestHash!==requestHash)throw Error("同一请求标识不能更改附件、点名、引用或操作");
      if(managedGroup(room) && (input.submissionAction??"chat")!==(duplicate.submissionAction??"chat"))throw Error("同一消息请求标识不能用于两类操作");
      if(duplicate.text!==input.text)throw Error("同一个消息请求标识不能用于不同正文");
      await this.persistMessage(duplicate,{recover:true});
      if(duplicate.runtime==="chat")await this.chat.schedule(duplicate);
      if(duplicate.memberAssignments?.length)await this.assignments.schedule(duplicate);
      if(duplicate.reviewReturn&&!duplicate.reviewAlias&&!duplicate.taskActionError&&!duplicate.requestError)await this.review.process(duplicate);
      return duplicate;
    }
    const {roster,authored,ids:explicit,mentioned:members,unknown:unresolvedMention,reference,invalid:invalidReference,body,decision:classified}=this.followup.classify(room,input,undefined,!original);
    let decision=original?{intent:"create",basis:"转为任务"}:classified;
    const explicitRoom=managedGroup(room) && !original;
    const action=input.submissionAction??"chat";
    if (explicitRoom && !["chat","delegate-document","append-document","review-document"].includes(action)) throw Error("未知群消息操作");
    if (explicitRoom) {
      if (action==="append-document" || action==="review-document") {
        if(!input.taskId || !reference || reference.taskRef!==input.taskId || reference.sender?.kind!=="user") throw Error("从原任务卡操作才能关联该任务");
        decision={intent:action==="append-document"?"append":"review",basis:body};
      }
    }
    const everyone=authored.who==="everyone";
    const assignments=explicitRoom?null:decision.sequentialAssignments?{assignments:decision.sequentialAssignments}:!original&&!decision.delivery&&(everyone||explicit.length>1)&&["chat","ordered-chat","create"].includes(decision.intent)&&
      parseMemberAssignments(everyone?body:(authored.authoredText??input.text),roster);
    if(assignments&&!decision.sequentialMembers)decision={intent:"create",basis:"成员明确分工"};
    const at=now();
    const message={
      ...(explicitRoom?{submissionAction:action,routingVersion:3}:{}),...(requestHash?{requestHash}:{}),id,roomId:room.id,sender:{kind:"user",name:input.senderName??"user"},text:input.text,mentions:explicitRoom&&!everyone?explicit:members,
      authorizationSnapshot:{messageId:id,members,at},createdAt:at,sequence:this.svc.state.messages.filter(m=>m.roomId===room.id).length,
      ...reference&&input.replyTo?{replyTo:reference.id}:{},
      ...!invalidReference&&input.threadId?{threadId:input.threadId}:{},
      routeDecision:{...decision,referenceId:reference?.id??null}
    };
    const attachments=original?.attachments??(await this.svc.storeMessageAttachments(input.attachments,decision.intent==="single-file"?{...room,memberIds:[decision.recipientId]}:room))?.stored
      .map(f=>({name:f.name,size:f.bytes,mime:f.mime,path:f.path}));
    if(attachments?.length)message.attachments=attachments;
    if(["chat","ordered-chat","progress"].includes(decision.intent)){
      this.chat.prepare(room,message,{...authored,ids:explicit},members,reference,decision,unresolvedMention||invalidReference);
      if(decision.semanticScope&&!message.chatPlan.reason){
        const scope=decision.semanticScope;
        message.chatPlan={...message.chatPlan,targets:[scope.first],allowance:1,ordered:false,recipientSource:"user-conditional",semanticScope:scope};
        message.authorizationSnapshot={...message.authorizationSnapshot,members:[scope.first]};
      }
      await this.persistMessage(message);
      await this.chat.schedule(message);
      return message;
    }

    message.presentation="chat";message.runtime="task";
    try {
      if(invalidReference)throw Error("所引用的消息在本群不可用，请重新选取");
      if(unresolvedMention)throw Error("点名无法核实，请重新点名当前成员");
      if(room.paused&&!["stop"].includes(decision.intent))throw Error("群聊已暂停，请在启用后重新授权");
      this.assert();
      if(explicitRoom && (action==="append-document"||action==="review-document" || reference?.taskRef && ["append","review"].includes(decision.intent))){
        const anchored=this.store.get(input.taskId??reference.taskRef);
        if(!anchored||anchored.state.roomId!==room.id||this.goalCache.get(anchored.taskId)?.id!==reference?.id)throw Error("任务与当前原消息不一致");
        if(action==="review-document" && input.attachments?.length)return await this.registerUserDraft(room,message,input);
        if(decision.intent==="review" && anchored.state.status==="completed"){
          message.routeDecision.jointMembers=anchored.state.roles.confirmers;
          return await beginJointReview(this,room,message,anchored);
        }
        this.authorizeAction(message,anchored);message.taskRef=message.mentionTask=anchored.taskId;
        await this.persistMessage(message);await this.applyRequestAction(message,anchored);return message;
      }
      if(decision.intent==="single-file"){
        const botId=decision.recipientId;
        if(explicit.length!==1 || explicit[0]!==botId)throw Error("单人文件委托需要一位有效的被点名成员");
        message.fileSources=attachedDocumentSources(input.attachments,message.attachments);
        return await this.assignments.create(room,message,{assignments:[{botId,work:message.text,verb:"制作文件",dependsOn:[],singleFile:true}]});
      }
      if(decision.jointMembers){
        const reviewed=await matchedReview(this,message,reference);
        if(reviewed)return await beginJointReview(this,room,message,reviewed);
        if(decision.documentReview)throw Error("未能唯一核对待审方案，请引用对应的已交付原件。");
      }
      if(decision.intent==="return-review")return await this.followup.apply(room,message,input,reference);
      if(decision.intent==="close-thread")return await this.threadCloser.prepare(room,message,input);
      if(decision.intent==="create")return await this.createFromMessage(room,message,roster,authored,original,assignments,input.attachments);
      const candidates=this.taskCandidates(room.id,{...input,text:decision.basis,memberTargets:explicit,actionIntent:decision.intent},decision.intent!=="resume");
      if(!candidates.length)throw Error("未找到可核验的原任务，请引用任务原消息");
      if(candidates.length===1){
        const record=candidates[0];
        this.authorizeAction(message,record);
        message.taskRef=record.taskId;message.mentionTask=record.taskId;
        await this.persistMessage(message);
        await this.applyRequestAction(message,record);
      }else {
        if(!["resume","append"].includes(decision.intent))throw Error("请回复要操作的那条原任务消息。");
        const previous=this.pendingChoiceId(this.svc.getRoom(room.id));
        if(previous)this.closeChoice(room.id,previous,"superseded");
        message.continuationCandidates=candidates.map(record=>this.choiceView(record));
        this.svc.patchRoom(room.id,r=>({...r,
          teamCurrentRequest:{messageId:id,taskId:null,status:"pending-selection",reason:"请选择要操作的原任务"},
          continuationRequests:[...(r.continuationRequests??[]),{
            messageId:id,intent:decision.intent,authorizedMemberIds:members,choices:message.continuationCandidates,
            expiresAt:new Date(Date.now()+continuationTtlMs).toISOString()
          }]
        }));
        await this.persistMessage(message);
      }
    } catch(error) {
      if(["EPERM","EBUSY","EACCES"].includes(error.code))throw error;
      message.requestError=String(error?.message??error);
      await this.persistMessage(message);
      await this.markRequestFailed(message,error);
      this.recordContinuationFailure(room.id,message,message.taskRef??null,error);
      await this.svc.flushNow();
    }
    return message;
  }

  async createFromMessage(room,message,roster,authored,original,assignments,uploaded){
    if(assignments)return this.assignments.create(room,message,assignments);
    const rolePlan=this.helpers.parseRoles(maskGroupLinks(message.text),roster),saved=this.svc.teamWorkflowFor(room);
    const eligible=this.currentMembers(room.id);
    const plan=message.routeDecision.documentPlan;
    const configured=!plan && message.routeDecision.explicitWorkOrder && saved && [saved.firstBotId??saved.memberIds[0],saved.reviewerId];
    if(configured && (new Set(configured).size!==2||!configured.every(id=>eligible.includes(id))))throw Error("群内主笔和复核分工已失效，请检查群设置");
    const pair=plan?[plan.writer,plan.reviewer]:message.routeDecision.sequentialMembers??message.routeDecision.jointMembers??(message.routeDecision.delivery?deliveryPair(room,roster,eligible,saved,message,rolePlan):null)??(configured||null);
    if(message.routeDecision.explicitWorkOrder&&!pair)throw Error("请先在群设置登记主笔和复核成员");
    const members=plan?[...new Set([plan.writer,plan.reviewer,plan.deliverer])]:pair??(message.mentions.length?message.mentions:!room.mentionOnly?[
      ...new Set([...(saved?.memberIds??[]),this.svc.leaderOfRoom(room.id)])
    ].filter(id=>eligible.includes(id)):[]);
    if(!members.length)throw Error("请点名可执行这项任务的成员");
    const explicit=(rolePlan?.sequence??authored.sequence)?.filter(id=>members.includes(id));
    const savedPair=saved && members.includes(saved.firstBotId ?? saved.memberIds[0]) && members.includes(saved.reviewerId);
    if(!pair && authored.who!=="everyone" && members.length>1 && !explicit?.length && !savedPair){
      const work=message.routeDecision.basis;
      return this.assignments.create(room,message,{assignments:members.map(botId=>({botId,work,dependsOn:[]}))});
    }
    const order=pair??(members.length===1?members:explicit?.length?explicit:
      [...new Set([saved?.firstBotId,...(saved?.memberIds??[]),...members])].filter(id=>members.includes(id)&&id!==saved?.supervisorId));
    if(!order.length)order.push(...members);
    const reviewer=pair?.[1]??[rolePlan?.reviewerId,saved?.reviewerId,order[1]].find(id=>id!==order[0]&&members.includes(id))??null;
    const supervisor=[rolePlan?.supervisorId,saved?.supervisorId].find(id=>members.includes(id))??null;
    if(!pair&&rolePlan?.sequence?.length>1&&reviewer&&rolePlan.reviewerId===reviewer)await this.svc.updateRoom({id:room.id,
      ...(members.includes(rolePlan.leaderId)?{leaderBotId:rolePlan.leaderId}:{}),
      teamWorkflow:{mode:"until-final-review",firstBotId:order[0],reviewerId:reviewer,memberIds:order,...supervisor?{supervisorId:supervisor}:{}}
    });
    const reviewFirstResult=members.length>1 && !!saved && !!reviewer &&
      order[0]===(saved.firstBotId??saved.memberIds[0]) && reviewer===saved.reviewerId;
    const roles={...(plan?{writerFinalReview:true,delivererId:plan.deliverer}:reviewer&&[order[0],reviewer].includes(saved?.delivererId)?{delivererId:saved.delivererId}:{}),...(pair?{unattended:true}:{}),...(reviewer?{reviewProtocol:2}:{}),sessionScope:"task",handoffFiles:"named",first:order[0],reviewer,supervisor,order,confirmers:reviewer?[order[0],reviewer]:[],
      ...(reviewFirstResult?{reviewFirstResult:true}:{})};
    const taskId="thread:"+(original?.id??message.id);
    message.taskRef=taskId;message.mentionTask=taskId;
    message.authorizationSnapshot={...message.authorizationSnapshot,members};
    if(message.routeDecision.explicitWorkOrder) message.authorizationSnapshot.documentWorkOrder={taskId,roomId:room.id,origin:message.id,writer:roles.first,reviewer:roles.reviewer,deliverer:roles.delivererId??roles.reviewer};
    const existing=this.store.get(taskId);
    if(existing?.revision){
      if(existing.state.roomId!==room.id)throw Error("任务所属群聊不符");
      const savedGoal=JSON.parse((await this.store.readBlob(existing.state.goalRef)).toString());
      if(savedGoal.text!==message.text)throw Error("原消息任务已经存在，请确认请求标识");
      await this.persistMessage(message);
      this.setCurrentRequest(room.id,message.id,existing);
      await this.svc.flushNow();return message;
    }
    const inputs=plan&&roles.unattended&&message.attachments?.length ? attachedDocumentSources(uploaded,message.attachments) : [];
    const ref=await this.store.putBlob(inputs.length ? {...message,attachedDocumentSources:inputs} : message,"json");
    const created=this.events("TASK_CREATED",{roomId:room.id,authorization:message.authorizationSnapshot,permissions:eligible,roles,goalRef:ref,messageRef:ref});
    const initial=apply(emptyState(taskId),{...created,taskId});
    const missing=plan&&roles.unattended&&message.routeDecision.delivery
      ? await documentPreflight(this.svc,initial) : [];
    const events=missing.length?[this.events("WAITING",{reasons:missing})]:(await this.buildPlan(initial,order[0])).events;
    const record=await this.store.create(taskId,[created,...events]);
    await this.persistMessage(message);
    await this.project(record);
    this.setCurrentRequest(room.id,message.id,record);
    await this.svc.flushNow();this.svc.executor?.nudge();return message;
  }

  authorizeAction(message,record){
    const state=record.state;
    const intent=message.routeDecision?.intent??"resume";
    const explicit=message.mentions??[];
    const current=this.currentMembers(message.roomId);
    const prior=effectiveMembers({...state,permissions:current});
    const allowed=state.roles.assignment&&intent!=="stop"?[state.roles.assignment.botId]:null;
    const members=(state.roles.unattended&&intent==="append"?prior:explicit.length?explicit:prior).filter(id=>current.includes(id)&&(intent==="resume"||prior.includes(id))&&(!allowed||allowed.includes(id)));
    if(!members.length)throw Error("操作缺少有效的用户授权，请重新点名");
    if(intent==="review"&&!members.includes(state.roles.reviewer))throw Error("请明确授权原任务的复核成员");
    message.authorizationSnapshot={...message.authorizationSnapshot,members};
    return members;
  }

  async applyRequestAction(message,record){
    const intent=message.routeDecision?.intent??"resume";
    if(intent==="stop"){
      const stopped=await this.stop(record.taskId,"用户请求停止原任务："+message.id);
      this.setCurrentRequest(message.roomId,message.id,stopped);
      await this.svc.flushNow();return this.response(stopped,message.id);
    }
    const state=record.state;
    if(state.roles.assignment){
      if(intent!=="resume")throw Error("请明确点名这位成员继续原分工，或发一条新的要求。");
      const result=await this.assignments.resume(record,message,message.authorizationSnapshot);
      this.setCurrentRequest(message.roomId,message.id,this.store.get(record.taskId));
      await this.svc.flushNow();return result;
    }
    if(["append","review"].includes(intent)&&["completed","stopped","stopping"].includes(state.status)){
      throw Error("原任务已进入收尾，请明确续做后再提交追加或返审");
    }
    if(["append","review"].includes(intent)&&state.currentStepId&&!ended(state.steps[state.currentStepId]?.status)){
      const result=this.response(record,message.id,{pendingBoundary:true});
      this.setCurrentRequest(message.roomId,message.id,record);
      await this.svc.flushNow();return result;
    }
    const result=await this.resumeRequest(record.taskId,message,message.authorizationSnapshot,{
      resumeStopped:intent==="resume",fallback:intent==="review"?state.roles.reviewer:undefined,preferTarget:intent==="review"});
    this.setCurrentRequest(message.roomId,message.id,this.store.get(record.taskId));
    await this.svc.flushNow();this.svc.executor?.nudge();return result;
  }
  choiceView(record) {
    const goal = this.goalCache.get(record.taskId);
    const text = goal?.text ?? "";
    const assignment=record.state.roles.assignment;
    const label=assignment?((this.svc.getBot(assignment.botId)?.name??"成员")+" "+assignment.work).slice(0,100):
      this.helpers.parseMentions(text,this.svc.state.bots).remainder?.trim().slice(0,100)||"原任务";
    return { taskKey: record.taskId, messageId: goal?.id ?? record.state.activeAuthorizationId,
      text, label, createdAt: goal?.createdAt, status: this.statusView(record.state).status, revision: record.revision };
  }
  taskCandidates(roomId,input={},activeOnly=false){
    const explicit=input.continueTaskId??input.taskId;
    const refersFirst=/第一条/.test(input.text??"");
    const reference = input.replyTo ?? input.threadId;
    const selected = reference ? this.svc.state.messages.find(m => m.id === reference && m.roomId === roomId) : undefined;
    const rows=this.store.list().filter(r=>{
      const state=r.state;
      if(state.roomId!==roomId||!r.revision||this.threadCloser.closure(roomId,r.taskId)||activeOnly&&!live(state)||state.roles.kind==="ordered-chat")return false;
      const goal=this.goalCache.get(r.taskId);
      if(!goal||goal.sender?.kind!=="user"||goal.roomId!==roomId||!goal.text?.trim()||state.history?.canResume===false)return false;
      if(!state.authSnapshots[state.activeAuthorizationId]?.members?.length)return false;
      const roster=this.svc.state.bots.filter(bot=>this.svc.getRoom(roomId)?.memberIds.includes(bot.id));
      const body=this.helpers.parseMentions(goal.text,roster).remainder??goal.text;
      if(!goal.routeDecision&&!state.versionId&&!Object.keys(state.handoffs).length&&
        classifyGroupMessage(body,{hasReference:!!goal.attachments?.length}).intent!=="create")return false;
      const assignment=state.roles.assignment;
      if(input.actionIntent==="resume"&&assignment){
        if(input.memberTargets?.length&&!input.memberTargets.includes(assignment.botId))return false;
        if(this.assignments.reply(r))return false;
      }
      if(explicit&&r.taskId!==explicit&&r.taskId!=="task:"+explicit&&assignment?.batchTaskId!==explicit)return false;
      if(reference&&(!selected||(r.taskId!==selected.taskRef&&r.taskId!==selected.mentionTask&&r.taskId!==this.svc.state.runs.find(run=>run.roomId===roomId&&run.id===selected.runId)?.teamTaskId&&
        (!assignment||assignment.batchTaskId!==selected.taskRef)&&!state.authSnapshots[selected.id])))return false;
      if(explicit||reference||activeOnly)return true;
      return state.status!=="completed"||!!this.resumeKind(state)||refersFirst;
    });
    rows.sort((a,b)=>String(this.goalCache.get(a.taskId)?.createdAt??a.events[0]?.at).localeCompare(String(this.goalCache.get(b.taskId)?.createdAt??b.events[0]?.at)));
    const unique=new Map();for(const r of rows){const goal=this.goalCache.get(r.taskId),key=input.actionIntent==="resume"&&r.state.roles.assignment?r.taskId:goal?.id??r.state.goalRef?.id??r.taskId;if(!unique.has(key))unique.set(key,r);}
    const choices=[...unique.values()];
    if(refersFirst&&choices.length>1){
      const messages=this.svc.state.messages.filter(m=>m.roomId===roomId&&m.sender.kind==="user").sort((a,b)=>String(a.createdAt).localeCompare(String(b.createdAt)));
      const rootMessages=messages.filter(m=>choices.some(r=>this.goalCache.get(r.taskId)?.id===m.id));
      const first=rootMessages[0];
      if(first){const exact=choices.filter(r=>r.taskId==="thread:"+first.id&&this.goalCache.get(r.taskId)?.id===first.id);if(exact.length===1)return exact;}
    }
    return choices;
  }
  setCurrentRequest(roomId,messageId,record) {
    const visible=this.statusView(record.state);
    this.svc.patchRoom(roomId,r=>({...r,
      teamCurrentRequest:{messageId,taskId:record.taskId,status:visible.status,revision:record.revision,reason:visible.missing[0]},
      continuationRequests: (r.continuationRequests ?? []).map(q => q.messageId === messageId
        ? { ...q, selectedTaskKey: record.taskId, closedAt: now(), closedReason: "selected" } : q)}));
  }
  async markRequestFailed(message,error) {
    if(!["append","review"].includes(message.routeDecision?.intent)||!message.taskRef)return;
    this.svc.state={...this.svc.state,messages:this.svc.state.messages.map(row=>
      row.id===message.id&&row.roomId===message.roomId?{...row,taskActionError:error.message}:row)};
    await this.svc.flushNow();
  }
  recordContinuationFailure(roomId,message,taskId,error) {
    const reason=error instanceof Error?error.message:String(error);
    this.svc.patchRoom(roomId,r=>({...r,
      teamCurrentRequest:{messageId:message.id,taskId,status:"failed",taskFailure:true,reason,
        rawDiagnostic:error.stack??reason}}));
  }
  response(record,messageId,extra={}) {
    return {ok:true,taskId:record.taskId,taskKey:record.taskId,requestId:messageId,revision:record.revision,
      status:this.statusView(record.state).status,...extra};
  }
  async resumeRequest(taskId,message,authorization,{fallback,resumeStopped,requirePending=false,preferTarget=false,inSerial=false}={}) {
    const applyRequest=async()=>{
      const r=this.store.get(taskId);
      if(!r||r.state.roomId!==message.roomId)throw Error("原任务在本群不可用");
      const s=r.state,step=s.steps[s.currentStepId];
      const lastWait = s.status==="stopped" ? r.events.findLast(e=>e.type==="WAITING")?.payload.reasons : s.missing;
      const refused = lastWait?.some(text=>text.startsWith("宿主审批阻塞（"));
      if((hasDocumentOrder(s)) && s.roles.unattended &&
          ["stopped","pending-review"].includes(s.status) && (refused || lastWait?.some(text=>text.startsWith(preflightPrefix)))){
        const missing=await documentPreflight(this.svc,{...s,permissions:this.currentMembers(s.roomId)},refused);
        if(missing.length)throw Error(missing.join(" "));
      }
      if(s.authSnapshots[message.id])return this.response(r,message.id,{alreadySelected:true});
      if(s.status==="stopping")throw Error("原回合正在停止，等待同一回合的上游终态回执");
      if(s.roles.kind==="ordered-chat"&&!live(s))throw Error("这轮接话已结束，请直接发下一条消息");
      const kind=this.resumeKind(s);
      if(requirePending&&!kind)throw Error("这项任务的待办或状态已更新，请刷新后核对");
      const members=authorization.members.filter(id=>this.currentMembers(s.roomId).includes(id));
      if(!members.length)throw Error("原授权成员当前不可用，请重新点名授权");
      if(preferTarget&&!members.includes(fallback))throw Error("原任务复核成员已不可用，请重新授权");
      let recover;
      if(kind==="final-delivery"&&s.status==="completed"){
        await this.readFinalReceipt(s);
        if(!this.signatureDeliveryNeeded(s))throw Error("原文件卡片已核实，任务已交稿");
        recover={kind,versionId:s.versionId};
      }else if(resumeStopped && s.status==="stopped" && s.roles.unattended && s.versionId && Object.keys(s.confirmations).length){
        const manifest=s.manifests[s.versionId];
        if(!manifest || digest((await this.store.readBlob(manifest.bodyRef)).toString())!==manifest.bodyHash)throw Error("原稿版本核对失败");
        for(const ref of finalFileRefs(s))await this.store.readBlob(ref);
        recover={kind:"signed-resume",versionId:s.versionId};
      }else if(kind==="legacy-cap"){
        recover=await recoverLegacyCap(this.legacyCapped.get(taskId),s,this.store,this.svc);
      }
      const returnHandoffs=step && ended(step.status) ? Object.values(s.handoffs).filter(h=>{
        if(!["scheduled","accepted"].includes(h.status)||!members.includes(h.targetId))return false;
        const previousStep=s.steps[h.stepId];
        const attempt=previousStep?.attempts[previousStep.currentAttemptId];
        // A failed current step reuses its step and handoff. A new step must sign for the handoff again.
        return attempt?.stopVerified===true && ended(attempt.status) && !(previousStep===step&&step.status==="failed");
      }).map(h=>h.id):[];
      const last=step&&s.dispatches[step.attempts[step.currentAttemptId]?.dispatchId];
      const resume=last&&this.review.missingDecision(r,last)&&members.includes(last.targetId)?{...this.review.versionFor(s,last),targetId:last.targetId}:null;
      const carried=s.authSnapshots[step?.authorizationId]?.reviewOffer;
      if(s.roles.unattended&&message.routeDecision?.intent==="append"){
        const event=this.events("REQUIREMENTS_UPDATED",{messageRef:await this.store.putBlob(message),authorization:{...authorization,members},previousVersion:s.versionId},"requirements:"+message.id);
        const next=apply(s,{...event,taskId});
        const plan=await this.buildPlan(next,s.roles.first,[],{purpose:"revision",previous:last?.terminal?.outputRef});
        await this.commit(taskId,[event,...plan.events],r.revision);
        this.svc.executor?.nudge();
        return this.response(this.store.get(taskId),message.id,{runId:plan.dispatchId});
      }
      const event=this.events("USER_AUTHORIZED",{authorization:{...authorization,members,...(resume?{reviewResume:resume}:{}),...(carried&&!carried.sourceVersion&&!s.versionId?{reviewOffer:carried}:{})},recover,returnHandoffs,
        messageRef:await this.store.putBlob(message),resumeStopped});
      const prospective=apply({...s,permissions:this.currentMembers(s.roomId)},{...event,taskId});
      const events=[event];
      let runId;
      if(!step||ended(step.status)){
        const previous=step?.currentAttemptId&&Object.values(s.dispatches).find(d=>d.attemptId===step.currentAttemptId);
        const handoffs=Object.values(prospective.handoffs).filter(h=>h.status==="pending");
        const unfinishedReview=previous&&this.review.missingDecision(r,previous)&&members.includes(previous.targetId)?previous.targetId:null;
        const eligible=handoffs.find(h=>h.targetId===unfinishedReview)??handoffs.find(h=>members.includes(h.targetId));
        const needsDelivery=!handoffs.length&&this.signatureDeliveryNeeded(prospective);
        if(step?.status==="failed"){
          const run=previous&&this.svc.state.runs.find(x=>x.id===previous.runId);
          if(!members.includes(step.targetId))throw Error("失败棒的接收方没有获本次点名授权");
          if(!run||!this.svc.canRetryToolRelay(run))throw Error("原失败回合的上游终态尚未核对，待核对后可重试");
          const dispatchId=randomUUID();
          events.push(this.events("DISPATCH_PLANNED",{...this.runInput(run),dispatchId,runId:dispatchId,
            attemptId:randomUUID(),ticketId:randomUUID(),authorizationId:message.id,
            payloadRef:previous.payloadRef,source:"manual",safeToRetry:true}));
          runId=dispatchId;
        }else{
          const order=prospective.roles.writerFinalReview?[prospective.roles.reviewer,prospective.roles.first]:prospective.roles.confirmers??[];
          const nextSignature=prospective.versionId&&order.find(id=>
            !signatureVerified(prospective,id)&&members.includes(id));
          const target=needsDelivery?(prospective.roles.delivererId??prospective.roles.reviewer):
            (preferTarget&&members.includes(fallback)?fallback:unfinishedReview??eligible?.targetId)??(nextSignature||null)??(members.includes(fallback)?fallback:members.includes(step?.targetId)?step.targetId:members[0]);
          if(!members.includes(target))throw Error("交稿成员没有获本次点名授权，请点名终审成员");
          if(requirePending&&handoffs.length&&!eligible)throw Error("剩余待办接收方不在原授权范围，请重新点名");
          const plan=await this.buildPlan(prospective,target,handoffs.filter(h=>h.targetId===target).map(h=>h.id),
            {purpose:needsDelivery?"final-delivery":(resume?.targetId===target||carried&&!carried.sourceVersion&&!s.versionId&&carried.targetId===target)?"return-review":undefined,previous:previous?.terminal?.outputRef});
          events.push(...plan.events);runId=plan.dispatchId;
        }
      }
      const next=await this.commit(taskId,events,r.revision);
      await this.svc.flushNow();
      return this.response(next,message.id,runId?{runId}:{alreadyRunning:true});
    };
    return inSerial?applyRequest():this.serial(taskId,applyRequest);
  }
  async continueChoice(input) {
    const room = this.svc.getRoom(input.roomId);
    if (!room) throw Error("群聊不存在");
    if(["check-member-receipt","retry-member-delivery"].includes(input.mode)){this.assert();return this.assignments.action(room,input);}
    if(input.mode==="retry-message")return this.threadCloser.retryMessage(room,input);
    if(input.mode==="continue-chat")return this.chat.continue(room,input);
    if(input.mode==="convert-message"){
      const original=this.svc.state.messages.find(m=>m.roomId===room.id&&m.id===input.messageId&&m.sender.kind==="user"&&m.runtime==="chat");
      if(!original?.text.trim())throw Error("这条消息不能转为任务，请明确发送执行要求");
      const result=await this.send({roomId:room.id,text:original.text,mentions:original.mentions,replyTo:original.id,
        requestId:"convert:"+digest(original.id)},original);
      return {ok:!!result.taskRef&&!this.svc.getRoom(room.id)?.teamCurrentRequest?.taskFailure,requestId:result.id,taskId:result.taskRef};
    }
    if (input.mode === "resume-pending") {this.assert();return this.resumePending(room, input);}

    if (input.mode === "stop-task") {
      this.assert();
      const record=await this.stop(input.taskKey,"用户点击中止任务",input);
      return this.response(record,input.messageId);
    }

    const request = room.continuationRequests?.find(row => row.messageId === input.messageId);
    const cancel = input.mode === "cancel-selection";
    if (cancel && ["cancelled", "expired"].includes(request?.closedReason)) {
      return { ok: true, requestId: input.messageId, status: request.closedReason };
    }
    if (request?.selectedTaskKey && !cancel) {
      this.assert();
      if (request.selectedTaskKey !== input.taskKey) throw Error("本次请求已关联另一项原任务");
      return this.response(this.store.get(input.taskKey), input.messageId, { alreadySelected: true });
    }
    if (!request || request.closedAt || this.pendingChoiceId(room) !== input.messageId) {
      throw Error("原任务选择已失效，请重新发送续做请求");
    }
    const expired = choiceExpired(request);
    if (expired || cancel) {
      const status = expired ? "expired" : "cancelled";
      this.closeChoice(room.id, input.messageId, status);
      await this.svc.flushNow();
      if (expired && !cancel) throw Error("原任务选择已过期，请重新发送续做请求");
      return { ok: true, requestId: input.messageId, status };
    }
    this.assert();
    if (!(request.choices ?? []).some(choice => choice.taskKey === input.taskKey)) {
      throw Error("所选任务不在本次候选中");
    }
    const message = this.svc.state.messages.find(row =>
      row.id === request.messageId && row.roomId === room.id && row.sender.kind === "user");
    if (!message?.authorizationSnapshot) throw Error("缺少本次选择对应的用户授权消息");

    try {
      const record=this.store.get(input.taskKey);
      if(!record||record.state.roomId!==room.id)throw Error("所选原任务已不可用");
      const linked={...message,routeDecision:message.routeDecision??{intent:request.intent??"resume"},taskRef:record.taskId,mentionTask:record.taskId};
      this.authorizeAction(linked,record);
      this.svc.state={...this.svc.state,messages:this.svc.state.messages.map(row=>row===message?linked:row)};
      const result=await this.applyRequestAction(linked,record);
      await this.svc.flushNow();
      return result;
    }catch(error) {
      this.closeChoice(room.id,message.id,"failed");
      const linked=this.svc.state.messages.find(row=>row.id===message.id&&row.roomId===room.id);
      if(linked)await this.markRequestFailed(linked,error);
      this.recordContinuationFailure(room.id,message,input.taskKey,error);
      await this.svc.flushNow();throw error;
    }
  }
  async resumePending(room,input){
    return this.serial("choice:"+input.taskKey+":"+input.messageId,async()=>{
      const r=this.store.get(input.taskKey);
      if(!r||r.state.roomId!==room.id)throw Error("原任务在本群不可用");
      const s=r.state;
      const requestId="resume:"+digest({taskId:r.taskId,previousAuthorization:input.messageId});
      if(s.authSnapshots[requestId])return this.response(r,requestId,{alreadySelected:true});
      if(s.activeAuthorizationId!==input.messageId)throw Error("任务已更新，请从当前任务继续");
      if(!this.resumeKind(s))throw Error("该任务当前无可继续的交稿或交接待办");
      const original=s.authSnapshots[input.messageId];
      const members=effectiveMembers({...s,permissions:this.currentMembers(room.id)},input.messageId);
      if(!original||!members.length)throw Error("原任务授权已失效，请重新点名");
      const authorization={messageId:requestId,members,at:now(),source:"resume-pending",from:original.messageId};
      const message={id:requestId,roomId:room.id,sender:{kind:"user",name:"user"},text:"继续原任务",
        mentions:[],mentionTask:r.taskId,authorizationSnapshot:authorization,createdAt:authorization.at,
        sequence:this.svc.state.messages.filter(row=>row.roomId===room.id).length};
      try {
        await this.persistMessage(message);
        const reply=await this.resumeRequest(r.taskId,message,authorization,{requirePending:true});
        this.setCurrentRequest(room.id,requestId,this.store.get(r.taskId));
        await this.svc.flushNow();this.svc.executor?.nudge();return reply;
      }catch(error) {
        this.recordContinuationFailure(room.id,message,r.taskId,error);await this.svc.flushNow();throw error;
      }
    });
  }
  async payload(s,targetId,handoffIds,{previous,purpose}={}){
    const goal=s.goalRef?JSON.parse((await this.store.readBlob(s.goalRef)).toString()):null;
    const handoffs=[];
    for(const id of handoffIds){const h=s.handoffs[id],text=h.textRef?JSON.parse((await this.store.readBlob(h.textRef)).toString()):[];
      const evidence=[];for(const ref of h.evidenceRefs??[]){
        if(ref.missing)throw Error("交接证据缺失："+ref.name);
        const bytes=await this.store.readBlob(ref);
        const path=this.recipientFilePath(s,targetId,ref);
        await mkdir(resolve(path,".."),{recursive:true});
        await writeFile(path,bytes);
        evidence.push({...ref,targetPath:path});
      }handoffs.push({id,targetId,text,evidence,acceptedRunId:h.acceptedRunId??null});}
    const current=s.messages.at(-1)?JSON.parse((await this.store.readBlob(s.messages.at(-1))).toString()):goal;
    const reviewer=targetId===s.roles.reviewer;
    const finalDelivery=!s.roles.unattended&&reviewer&&requiresFinalDelivery(s)?{
      versionId:s.versionId,
      alreadyConfirmed:signatureVerified(s,targetId),
      files:await stageVersionFiles(this.store,s,join(this.svc.runWorkspaceDir(targetId),"handoffs","signed-versions"))
    }:null;
    if(s.roles.delivererId&&purpose==="final-delivery"){
      if(targetId!==s.roles.delivererId||!hasFinalSignatures(s))throw Error("尚不能派发最终交付");
      const files=await stageVersionFiles(this.store,s,join(this.svc.runWorkspaceDir(targetId),"handoffs","signed-versions"));
      return {purpose,taskId:s.taskId,role:"交付",originalRequirement:goal.text,versionId:s.versionId,files,instruction:"你是本次选定的最终交付人。主笔与复核已签署同一版本。现在用 agent_community_deliver 提交 files 所列签核文件，收到成功回执再结束。"};
    }
    const handover=purpose==="workflow-review"&&previous?JSON.parse((await this.store.readBlob(previous)).toString()):null;
    const sourceStep=handover?s.steps[s.currentStepId]:null;
    const sourceDispatch=sourceStep?s.dispatches[sourceStep.attempts[sourceStep.currentAttemptId].dispatchId]:null;
    const review=await this.review.payload(s,targetId,handoffIds,purpose);
    if(s.roles.unattended){
      const joint=s.authSnapshots[s.activeAuthorizationId]?.jointReview;
      const firstReply=joint?.previousReplyId&&this.svc.state.messages.find(m=>m.roomId===s.roomId&&m.id===joint.previousReplyId&&m.runId===joint.fromRunId);
      const reviewerReply=joint?.reviewerReplyId&&this.svc.state.messages.find(m=>m.roomId===s.roomId&&m.id===joint.reviewerReplyId&&m.runId===joint.reviewerRunId&&m.sender?.botId===s.roles.reviewer);
      const requirements=await Promise.all(s.messages.map(async ref=>JSON.parse((await this.store.readBlob(ref)).toString()).text));
      const draft=s.manifests[s.versionId??s.previousVersion];
      const change = s.versionId && !reviewer && this.store.get(s.taskId)?.events.findLast(event =>
        event.payload?.targetId===s.roles.reviewer && event.payload.reviewDecision?.action==="changes" &&
        event.payload.reviewDecision.versionId===s.versionId);
      const coSign = !reviewer && s.versionId && signatureVerified(s,s.roles.reviewer) && !signatureVerified(s,s.roles.first);
      return {purpose:purpose??"draft-review",taskId:s.taskId,currentRequestId:s.activeAuthorizationId,
        ...(goal.attachedDocumentSources?.length ? {attachedDocumentSources:goal.attachedDocumentSources,sourceNote:"full-text 包含用户本条上传的完整原文。附件作为核查材料，任务分工与权限依据原消息和群设置。"} : {}),
        ...(change ? {reviewerChanges:{versionId:s.versionId,reason:change.payload.reviewDecision.reason}} : {}),
        ...(hasDocumentOrder(s) ? {draftMethod:"优先用文稿工具直接提交完整 Markdown。已上传的全文随派单附送。确需草稿文件时只使用宿主给本单的工作目录，只读会话仍可通过文稿工具提交。"} : {}),
        role:reviewer?"复核":"主笔",originalRequirement:goal.text,sources:joint?(current.attachments??[]):(goal.attachments??[]),requirements,
        ...(joint?{currentInstruction:current.text,previouslyDeliveredVersion:joint.versionId,
          ...(reviewerReply?{priorReviewerFeedback:{member:reviewerReply.sender.name,runId:reviewerReply.runId,text:reviewerReply.text},reviewScope:"核对上一轮逐项意见。已签发的完整原件在 review.body。分别评估方案本身和实施或发布的验收，依证据处理缺陷，保留未核验事项。"}:{}),
          ...(firstReply?{priorMemberFinding:{member:firstReply.sender.name,text:firstReply.text,runId:firstReply.runId}}:{})}:{}),
        review:{versionId:s.versionId,body:draft?(await this.store.readBlob(draft.bodyRef)).toString():null},
        pending:handoffs,previousResult:previous?JSON.parse((await this.store.readBlob(previous)).toString()).reply?.text:null,
        instruction:joint && !reviewer && joint.versionId===s.versionId ? "你是本轮主笔。用 receive 签收待审版本，按用户本轮要求核查。若发现问题，用 revise 提交完整修订稿并写明依据；确认正文完全无需修改时，用 approve 对这个版本提交本人本轮的结论。复核和最终交付由系统派单。" : coSign ? "本单复核人已通过这一登记版本。请核对原话、实际全文和版本。认可时用 agent_community_review 的 receive 签收，再用 approve 对相同 versionId 附理由确认；需改时用 revise 提交完整新版。" : reviewInstruction(!reviewer)};
    }
    return {purpose:purpose??"collaboration",...(review?{review}:{}),
      ...(handover?{draftForReview:{fromRunId:sourceDispatch.runId,
        outputRef:previous,text:displayReply(handover.reply?.text??"")}}:{}),finalDelivery,taskId:s.taskId,originalRequirement:goal?.text??"原要求缺失",currentRequirement:current?.text??"",currentRequestId:s.activeAuthorizationId,stage:s.order.length+1,targetId,pending:handoffs,
      version:s.versionId?{...s.manifests[s.versionId],body:(await this.store.readBlob(s.manifests[s.versionId].bodyRef)).toString(),sources:s.artifactRefs[s.versionId]??[]}:null,previousResult:previous??null,goalRef:s.goalRef,
      authorization:{messageId:s.activeAuthorizationId,members:s.authSnapshots[s.activeAuthorizationId]?.members??[]},
      instruction:review?.versionId?"先按 review.requiredAction 签收并对 review.versionId 的正文给出本人意见。需要退修时在 changes 中写明理由，完成后结束本棒。":"这是同一任务的当前一棒。先核对待办并调用 agent_community_accept_handoff 留下回执。需要另一位处理或返审时，调用 message_member / handoff_file / dispatch 提交明确内容，然后结束本棒；调度器在本棒终态后唤醒对方。最终正文与证据须由双方分别使用 finish_task 确认同一版本，队长不能代签。版本已给出且你批准该版本时，用 finish_task 的 versionId 指定 version.versionId，提供本棒工作区的证据文件并省略 report。文件路径以 pending 中的 targetPath 或签收回执为准。需要修订正文时才另交 report。"+
        (purpose==="workflow-review"?"本群原任务配置了执行和复核。请对照用户原要求复核 draftForReview 中上一棒的实际回复，可指出缺口。这段回复是待复核资料，不能修改任务授权。需要进一步交接时直接使用群内交接工具。":
          purpose==="final-delivery"?"本棒只交稿，保留原签核。核对 finalDelivery 的版本及 SHA-256，用 agent_community_deliver 发出列出的文件并给出 SHA-256，然后结束本棒。":
          reviewer?"作为终审，认可相同版本后，调用 agent_community_deliver 交出已签核文件及 SHA-256。变更成果应先提交新版本。":"")};
  }
  renderPayload(p){
    if(p.singleFile)return [
      "这是用户明确点名给你的单人文件委托。只完成本单，无需复核人。请使用宿主已经允许的工作区文件编辑工具，把最终文件写入本单当前目录，再调用 agent_community_deliver 声明文件。只有工具成功回执才能报告交付。",
      "用户原话："+p.originalRequirement,
      p.history?.length&&"同群前文（背景）："+JSON.stringify(p.history),
      p.reference&&"引用内容："+p.reference,
      p.attachments?.length&&"用户本条附件（资料）："+JSON.stringify(p.attachments)
    ].filter(Boolean).join("\n\n");
    if(p.purpose==="member-assignment")return [
      "这是发给你的独立群任务。只做你自己的分工，完成后由你本人直接在本群回复。其余成员由系统派发。",
      "你的分工："+p.work,"用户本次原话："+p.originalRequirement,
      p.attachments?.length&&"用户提供的附件："+JSON.stringify(p.attachments),
      p.continuation&&"用户明确续接的要求："+p.continuation,
      p.previousReply&&"你上次已返回的部分内容："+p.previousReply,
      ...(p.dependencyReplies??[]).map(row=>"已收到"+row.name+"的回复："+row.text),
      p.hostScheduled && "本棒的交接已由工作室安排。直接返回本人的核查结果与依据，正文发布后工作室自动交给下一位；派单状态由工作室显示。"
    ].filter(Boolean).join("\n\n");
    if(p.purpose==="ordered-chat")return [
      "这是按顺序接话的群聊。只发你这一棒的正文，直接延续话题。",
      "用户：" + p.originalRequirement,
      p.previousReply ? p.previousReply.name + "：" + p.previousReply.text : ""
    ].filter(Boolean).join("\n");
    return "【持久任务交接】\n"+JSON.stringify(p,null,2);
  }
  async buildPlan(s,targetId,handoffIds=[],extra={}){
    const payload=s.roles.assignment?await this.assignments.payload(s,extra.previous):s.roles.kind==="ordered-chat"?{
      purpose:"ordered-chat",originalRequirement:this.goalCache.get(s.taskId)?.text??
        JSON.parse((await this.store.readBlob(s.goalRef)).toString()).text,previousReply:extra.previousReply
    }:await this.payload(s,targetId,handoffIds,extra);
    const ref=await this.store.putBlob(payload);
    const stepId=randomUUID(),attemptId=randomUUID(),dispatchId=randomUUID(),ticketId=randomUUID();
    const p={taskId:s.taskId,stepId,attemptId,dispatchId,ticketId,targetId,authorizationId:s.activeAuthorizationId,runId:dispatchId,payloadRef:ref,source:"initial",...(extra.purpose==="final-delivery"?{purpose:extra.purpose}:{})};
    return {events:[this.events("STEP_PLANNED",{...p,handoffIds}),this.events("DISPATCH_PLANNED",p)],dispatchId};
  }
  async planStep(taskId,targetId,handoffIds=[],extra={}){
    const r=this.store.get(taskId),plan=await this.buildPlan(r.state,targetId,handoffIds,extra);
    await this.commit(taskId,plan.events,r.revision);await this.svc.flushNow();
    return this.svc.state.runs.find(x=>x.id===plan.dispatchId);
  }
  async promptForRun(run){const r=this.recordForRun(run),d=r.state.dispatches[run.dispatchId];return this.renderPayload(JSON.parse((await this.store.readBlob(d.payloadRef)).toString()));}
  async runtimeAccepted(runId,receipt){
    const run=this.svc.state.runs.find(r=>r.id===runId);if(!this.managed(run))return;
    const state=this.recordForRun(run)?.state, dispatch=state?.dispatches[run.dispatchId];
    if(!dispatch||dispatch.status==="revoked"||state.roles.assignment&&(dispatch.status==="terminal"||dispatch.receipt))return;
    const old=state.bindings[run.botId],events=[];
    if(!old)events.push(this.events("SESSION_BOUND",{botId:run.botId,roomId:run.roomId,sessionId:receipt.sessionId,rootSessionId:receipt.rootSessionId??receipt.sessionId,
      creationRelation:receipt.creationRelation??{kind:"host-agent-registry",sessionId:receipt.sessionId},...receipt.threadId?{threadId:receipt.threadId}:{}}));
    events.push(this.events("HOST_ACCEPTED",{...this.runInput(run),receipt}));
    await this.commit(run.teamTaskId,events);
  }
  codexRunIsCurrent(run){
    if(!run||!this.isGroup(run.roomId)||this.svc.getRoom(run.roomId)?.paused||
      this.svc.getBot(run.botId)?.provider!=="codex-cli"||run.status!=="running"||run.stop||run.upstream?.turnId||
      this.svc.executor?.upstreamByRun?.get(run.id)?.turnId)return false;
    if(isChatRun(run)){
      // The task session registry omits the separate chat session by design.
      return this.chat.canClaim(run)&&this.svc.chatRunner?.sessionOf(run.roomId,run.botId)?.id===run.sessionId;
    }
    return this.opened&&this.svc.state.roomAgentSessions.some(row=>row.roomId===run.roomId&&row.botId===run.botId&&row.sessionId===run.sessionId);
  }
  codexDispatchNotStarted(run,state){
    const dispatch=state?.dispatches[run.dispatchId];
    return dispatch?.receipt?.sessionId===run.sessionId&&!dispatch.turn&&!dispatch.stop&&this.canClaim(run);
  }
  async prepareCodexWriterRecovery(sessionId){
    const run=this.svc.state.runs.find(row=>row.sessionId===sessionId&&row.status==="running");
    if(!this.codexRunIsCurrent(run))return;
    if(this.managed(run))await this.sessionBridge.pending(run.id);
    return this.codexWriterRecoveryScope(sessionId);
  }
  codexWriterRecoveryScope(sessionId){
    const runs=this.svc.state.runs.filter(run=>run.sessionId===sessionId&&run.status==="running");
    if(runs.length!==1||!this.codexRunIsCurrent(runs[0]))return;
    const run=runs[0];
    if(this.roomReply(run)&&this.canClaimRoomReply(run))return {runId:run.id,mayFork:true};
    const state=this.recordForRun(run)?.state;
    if (this.codexDispatchNotStarted(run,state)) return {runId:run.id,mayFork:state.roles.kind==="ordered-chat"};
  }
  async bindCodexThread(binding){
    const run=this.svc.state.runs.find(r=>r.sessionId===binding.sessionId&&r.status==="running"&&r.teamTaskId);
    if(!run)return;
    await this.sessionBridge.pending(run.id);
    return await this.serial(run.teamTaskId,async()=>{
      const record=this.recordForRun(run),previous=record.state.bindings[run.botId];
      if(!previous||previous.sessionId!==binding.sessionId||previous.rootSessionId!==binding.rootSessionId) {
        throw Error("Codex原线程尚未绑定宿主收件关系");
      }
      const changed=previous.threadId&&previous.threadId!==binding.threadId;
      const recovery=changed?this.svc.ctx.get?.("localAgent")?.codexWriterRecoveryFrom(binding.sessionId,previous.threadId,binding.threadId):undefined;
      if(changed&&(!recovery?.length||!this.codexRunIsCurrent(this.svc.state.runs.find(r=>r.id===run.id))||!this.codexDispatchNotStarted(run,record.state))) {
        throw Error(bindingRefusal);
      }
      if(previous.threadId===binding.threadId)return;
      const recorded=binding.recovery??recovery?.at(-1);
      await this.commit(run.teamTaskId,[this.events("SESSION_BOUND",{...previous,threadId:binding.threadId,
        bindingSource:binding.source,...recorded?{writerRecovery:recorded}:{}})],record.revision);
    });
  }
  async runtimeStarted(runId,turn){
    const run=this.svc.state.runs.find(r=>r.id===runId);if(!this.managed(run))return;
    const s=this.recordForRun(run)?.state,dispatch=s?.dispatches[run.dispatchId],changes=[];
    if(!dispatch||dispatch.status==="revoked"||s.roles.assignment&&(dispatch.status==="terminal"||dispatch.turn))return;
    if(turn.threadId){
      const binding=s.bindings[run.botId];
      if(!binding||(binding.threadId&&binding.threadId!==turn.threadId))throw Error("Codex回合缺少同线程的原宿主收件关系");
      if(!binding.threadId)changes.push(this.events("SESSION_BOUND",{...binding,threadId:turn.threadId}));
    }
    changes.push(this.events("TURN_STARTED",{...this.runInput(run),turn}));await this.commit(run.teamTaskId,changes);
  }
  async submit(input){
    try{
      await this.waitRuntime(input.roomId,input.botId);const {run,p}=this.actorRun(input.roomId,input.botId);return await this.serial(run.teamTaskId,async()=>{
        const s=this.recordForRun(run).state;if(s.roles.unattended&&!s.roles.confirmers.includes(input.targetId))throw Error("本任务只在已确定的主笔和复核人之间流转，请使用本棒复核工具");if(!this.svc.getRoom(input.roomId).memberIds.includes(input.targetId))throw Error("目标不在本群");
        const evidenceRefs=[];
        if(input.path){
          const plan=await this.helpers.planFileHandoff({senderWorkspace:this.svc.runWorkspaceDir(input.botId),targetWorkspace:this.svc.runWorkspaceDir(input.targetId),sourcePath:input.path});
          if(!plan.ok)throw Error(plan.reason);
          evidenceRefs.push({...await this.store.putBlob(await readFile(plan.sourcePath),"file"),name:basename(plan.sourcePath),sourcePath:plan.sourcePath,sourceBotId:input.botId});
        }
        const text=String(input.text??"").trim();
        if(!text&&!evidenceRefs.length)throw Error("交接缺少具体事项或文件");
        const contentHash=digest({text,evidence:evidenceRefs.map(r=>({id:r.id,sha256:r.sha256}))});
        const id="handoff:"+digest({task:run.teamTaskId,step:run.teamStepId,target:input.targetId,label:input.step??"",contentHash});
        const handoff={id,step:input.step??"next",targetId:input.targetId,textRef:await this.store.putBlob([text]),evidenceRefs,contentHash};
        await this.commit(run.teamTaskId,[this.events("HANDOFF_SUBMITTED",{...p,handoff},"submit:"+id)]);
        const view=this.handoffView(this.recordForRun(run).state,this.recordForRun(run).state.handoffs[id]);
        this.svc.recordNotice(run.roomId,"已提交待接棒："+(this.svc.getBot(input.targetId)?.name??input.targetId)+"，交接 "+id.slice(-12)+"。"+(effectiveMembers(s).includes(input.targetId)?"当前棒结束后由调度器投递。":"等待用户在原任务中点名授权。"));
        return {ok:true,status:"submitted",handoff:view,...evidenceRefs[0]?{size:evidenceRefs[0].bytes}:{}};
      });
    }catch(e){return {ok:false,status:"rejected",reason:e.message};}
  }
  handoffStatus(input){
    const rows=this.store.list().filter(r=>r.state.roomId===input.roomId);
    for(const r of rows){const h=r.state.handoffs[input.id];if(h&&[h.fromBotId,h.targetId].includes(input.botId))return {ok:true,handoff:this.handoffView(r.state,h)};}
    return {ok:false,reason:"该成员没有这条交接记录"};
  }
  async accept(input){
    try{await this.waitRuntime(input.roomId,input.botId);const {run,p}=this.actorRun(input.roomId,input.botId),r=this.recordForRun(run),h=r.state.handoffs[input.id];
      if(!h)throw Error("交接不存在");
      for(const ref of h.evidenceRefs??[])await this.store.readBlob(ref);
      await this.commit(run.teamTaskId,[this.events("HANDOFF_ACCEPTED",{...p,handoffId:input.id},"accept:"+input.id+":"+run.dispatchId)]);
      const s=this.recordForRun(run).state;this.svc.recordNotice(run.roomId,"已接棒："+this.svc.getBot(input.botId).name+"，运行 "+run.id+"。");
      return {ok:true,handoff:this.handoffView(s,s.handoffs[input.id])};
    }catch(e){return {ok:false,reason:e.message};}
  }
  async confirm(input){
    try{
      await this.waitRuntime(input.roomId,input.leaderId);const {run,p}=this.actorRun(input.roomId,input.leaderId);
      if(this.recordForRun(run)?.state.roles.unattended)throw Error("本次方案请使用 agent_community_review 提交完整稿或对本轮版本签核");
      const refs=[];
      for(const evidence of input.evidence??[]){
        if(evidence.kind==="file"){
          const full=resolve(this.svc.runWorkspaceDir(input.leaderId),evidence.path);
          const inside=relative(this.svc.runWorkspaceDir(input.leaderId),full);
          if(inside.startsWith("..")||resolve(full)===resolve(this.svc.runWorkspaceDir(input.leaderId)))throw Error("证据文件必须位于当前成员工作区");
          const ref=await this.store.putBlob(await readFile(full),"file");
          if(evidence.sha256 && String(evidence.sha256).toLowerCase()!==ref.sha256)throw Error("声明的文件 SHA-256 与实际字节不一致");
          refs.push({...ref,name:basename(full),sourcePath:full,sourceBotId:input.leaderId});
        }else if(evidence.kind==="message"){
          const m=this.svc.state.messages.find(m=>m.id===evidence.messageId&&m.roomId===input.roomId);if(!m)throw Error("证据消息不在本群");
          refs.push({...await this.store.putBlob(m,"json"),referenceId:"message:"+m.id});
        }else throw Error("请使用可回读的文件或本群消息证据");
      }
      const record=this.recordForRun(run),before=record.state,dispatch=before.dispatches[run.dispatchId];
      const subject=this.review.versionFor(before,dispatch),v=subject?.manifest.versionId;
      const priorDecision=record.events.findLast(e=>e.payload.dispatchId===run.dispatchId&&e.payload.reviewDecision);
      if(priorDecision&&priorDecision.type!=="ARTIFACT_CONFIRMED")throw Error("本棒已经提交了修改意见。");
      let report=String(input.report??"").normalize("NFC").replace(/\r\n?/g,"\n").trim();
      if(input.versionId){
        if(input.versionId!==v)throw Error("所签版本不属于本棒待审稿，请复核当前派单版本。");
        const body=(await this.store.readBlob(subject.manifest.bodyRef)).toString();
        if(report && report!==body)throw Error("提交的正文与指定版本不一致");
        // manifestOf below verifies the declared evidence, including duplicates, against the offered version.
        report=body;
      }
      const m=manifestOf(report,refs);
      if(input.versionId&&m.versionId!==input.versionId)throw Error("成果版本指纹未通过校验");
      if(v&&v!==m.versionId&&before.manifests[m.versionId])throw Error("旧版成果不能代替当前待审稿。");
      if(priorDecision&&priorDecision.payload.manifest.versionId!==m.versionId)throw Error("本棒已经提交本人签核。");
      m.bodyRef=await this.store.putBlob(report,"text");
      if(before.versionId===m.versionId&&signatureVerified(before,run.botId))
        return {ok:true,finished:false,teamConfirmation:{version:m.versionId,alreadyConfirmed:true,
          confirmed:Object.keys(before.confirmations),remaining:(before.roles.confirmers??[]).filter(id=>!before.confirmations[id])}};
      const payload={...p,manifest:m,evidenceRefs:refs};
      await this.commit(run.teamTaskId,[this.events("ARTIFACT_CONFIRMED",payload,"confirm:"+run.dispatchId+":"+m.versionId)],record.revision);
      this.svc.recordFinishReport(input.roomId,input.leaderId,report);
      const s=this.recordForRun(run).state;
      return {ok:true,finished:false,teamConfirmation:{version:m.versionId,confirmed:Object.keys(s.confirmations),remaining:(s.roles.confirmers??[]).filter(id=>!s.confirmations[id])}};
    }catch(e){return {ok:false,finished:false,reason:e.message};}
  }
  async recordUncertainDelivery(run,reason) {
    await this.serial(run.teamTaskId,async()=>{
      const r=this.recordForRun(run),s=r.state,d=s.dispatches[run.dispatchId];
      if(!live(s)||s.stop||!d||["terminal","revoked"].includes(d.status)||d.verificationReason===reason||
        s.roles.assignment&&this.assignments.absence(r,d))return;
      if(s.roles.assignment&&this.assignments.current(r)?.dispatchId!==d.dispatchId)return;
      await this.commit(run.teamTaskId,[this.events("DELIVERY_UNKNOWN",{...this.runInput(run),reason})],r.revision);
    });
  }
  startWasRejected(run) {
    const kind=this.recordForRun(run)?.state.dispatches[run.dispatchId]?.terminal?.receipt?.kind;
    return failedBeforeCodexTurn(kind)||kind==="codex-stop-before-native-turn";
  }
  startRejectionEvidence(run,record,dispatch,error) {
    const binding=record.state.bindings[run.botId],receipt=dispatch?.receipt;
    if(!receipt?.messageId||receipt.sessionId!==run.sessionId||binding?.sessionId!==run.sessionId||
      dispatch.turn||dispatch.stop?.turnId||run.stop?.turnId||run.upstream?.turnId||
      this.svc.executor?.upstreamByRun?.get(run.id)?.turnId||
      this.svc.getBot(run.botId)?.provider!=="codex-cli")return;
    const threadId=String(error??"").match(codexResumeWriterError)?.[1];
    if(!threadId||(binding.threadId&&binding.threadId!==threadId))return;
    return {kind:"codex-resume-active-writer",threadId,sessionId:receipt.sessionId,messageId:receipt.messageId,error};
  }
  async settle(run,input){
    const member=this.recordForRun(run)?.state.roles.assignment;
    const carrier=this.sessionBridge.pending(run.id),upstream=this.runtimeWork.get(run.id);
    if(member)await Promise.allSettled([carrier,upstream]);else{await carrier;await upstream;}
    const r=this.recordForRun(run),d=r.state.dispatches[run.dispatchId];
    if(d.status==="terminal")return d.terminal.status==="succeeded"?"completed":d.terminal.status;
    if(!d.turn){
      if(r.state.roles.assignment&&this.assignments.absence(r,d))return "failed";
      const rejection=input.status==="failed"&&this.startRejectionEvidence(run,r,d,input.error);
      if(rejection){
        const terminalId="start-rejected:"+d.dispatchId;
        const settled=await this.commit(run.teamTaskId,[this.events("TURN_START_REJECTED",{...this.runInput(run),receipt:rejection,terminalId})]);
        return settled.state.dispatches[d.dispatchId].terminal.status;
      }
      await this.recordUncertainDelivery(run,"宿主受理或回合启动证据缺失："+(input.error??"等待核对"));
      throw Error("缺少目标回合标识，保留待核对，禁止推断终态");
    }
    const codex=!!d.turn.threadId;
    let receipt=codex?(this.svc.executor?.upstreamByRun?.get(run.id)?.terminal??run.stop?.receipt??input.terminalReceipt):
      (input.terminalReceipt??input.reply?.terminalReceipt??this.sessionBridge.terminals.get(run.id));
    if(!codex&&!receipt){try{receipt=(await this.sessionBridge.inspect(run)).terminal;}catch{}}
    const matches=codex?receipt&&receipt.threadId===d.turn.threadId&&receipt.turnId===d.turn.turnId&&["completed","failed","interrupted"].includes(receipt.status):
      receipt&&receipt.sessionId===d.turn.sessionId&&receipt.hostTurnId===d.turn.turnId&&["completed","error","aborted","failed","interrupted"].includes(receipt.status);
    if(!matches){
      await this.recordUncertainDelivery(run,"原上游回合的终态回执尚未确认，继续核对原回合");
      throw Error("上游终态未确认，不能结算或创建恢复回合");
    }
    const requested=input.status==="completed"?"succeeded":["cancelled","interrupted"].includes(input.status)?"cancelled":"failed";
    const nativeInterrupted=!codex && ["interrupted","aborted"].includes(receipt.status);
    const status=receipt.status==="completed"?"succeeded":nativeInterrupted?"cancelled":requested==="succeeded"?"failed":requested;
    const outputRef=await this.store.putBlob({reply:input.reply??null,error:input.error??null,status});
    const terminalId=receipt.id??"codex:"+receipt.threadId+":"+receipt.turnId+":"+receipt.status;
    await this.commit(run.teamTaskId,[this.events("TURN_ENDED",{...this.runInput(run),status,terminalId,sessionId:d.turn.sessionId,
      turnId:d.turn.turnId,outputRef,receipt,
      ...(nativeInterrupted && !r.state.stop ? {missing:["原宿主回合已中断，已有记录已保留。可明确继续原任务。"]} : {})},"terminal:"+run.dispatchId)]);
    return status==="succeeded"?"completed":status;
  }
  nameOfReviewBlock(s,h){
    const actual=s.handoffs[h.id];
    const name=this.review.name(h.targetId);
    return actual?.acceptedDispatchId?name+"已签收，缺本人对这版的复核意见。可继续原任务补交。":
      name+"这一棒已结束，缺本人签收。可在原单继续签收，或明确把已交的新版派回复核。";
  }
  async registerUserDraft(room,message,input) {
    const id=input.taskId;
    return this.serial(id,async()=>{
      const record=this.store.get(id),s=record?.state;
      if(!s||s.roomId!==room.id||s.stop||s.status!=="pending-review"||s.versionId||
          Object.values(s.handoffs).some(h=>!["resolved","revoked"].includes(h.status)) ||
          Object.values(s.dispatches).some(d=>!["terminal","revoked"].includes(d.status))) throw Error("原单已有待办、版本或在途派单，请使用普通返审");
      const goal=JSON.parse((await this.store.readBlob(s.goalRef)).toString());
      if(goal.id!==input.replyTo||goal.sender.kind!=="user"||s.roles.confirmers?.length!==2)throw Error("原任务与复核分工不符");
      const members=s.roles.confirmers;
      if(!members.every(m=>this.currentMembers(room.id).includes(m)&&effectiveMembers(s).includes(m)))throw Error("原任务成员授权已变化");
      const inputs=attachedDocumentSources(input.attachments,message.attachments);
      if(inputs.length!==1||inputs[0].readMode!=="full-text"||inputs[0].text.trim().length<16)throw Error("请附上一份可完整回读的 UTF-8 待审稿");
      const draft=await this.review.draft(inputs[0].text);
      const auth={...message.authorizationSnapshot,members,originalMessageId:goal.id,documentWorkOrder:{
        taskId:id,roomId:room.id,origin:message.id,writer:s.roles.first,reviewer:s.roles.reviewer,deliverer:s.roles.delivererId??s.roles.reviewer
      },reviewOffer:{...draft,targetId:s.roles.reviewer,requestId:message.id}};
      message.taskRef=message.mentionTask=id;message.authorizationSnapshot=auth;
      const messageRef=await this.store.putBlob(message,"json");
      const e=this.events("USER_DRAFT_SUBMITTED",{authorization:auth,messageRef,sourceName:inputs[0].name,sourceHash:inputs[0].sha256,manifest:draft.manifest,refs:draft.refs},"user-draft:"+message.id);
      const next=apply(s,{...e,taskId:id});
      const plan=await this.buildPlan(next,s.roles.reviewer,[],{purpose:"return-review"});
      await this.commit(id,[e,...plan.events],record.revision);await this.persistMessage(message);
      this.setCurrentRequest(room.id,message.id,this.store.get(id));await this.svc.flushNow();this.svc.executor?.nudge();return message;
    });
  }
  async advance(taskId){
    const state=this.store.get(taskId)?.state;
    if(state?.roles.assignment)return this.assignments.schedule(this.assignments.origin(state));
    return this.serial(taskId,async()=>{
      let r=this.store.get(taskId),s=r.state;if(!live(s)||s.status==="stopping"||!s.currentStepId)return;
      const step=s.steps[s.currentStepId];if(!ended(step.status))return;
      if(!s.roles.unattended&&await this.review.beforeAdvance(r))return;
      const request=this.svc.state.messages.find(row=>row.roomId===s.roomId&&row.sender.kind==="user"&&row.taskRef===taskId&&
        ["append","review"].includes(row.routeDecision?.intent)&&!row.taskActionError&&!s.authSnapshots[row.id]);
      if(request){
        try{
          const reviewer=request.routeDecision.intent==="review";
          await this.resumeRequest(taskId,request,request.authorizationSnapshot,{inSerial:true,preferTarget:reviewer,fallback:reviewer?s.roles.reviewer:undefined});
          this.setCurrentRequest(s.roomId,request.id,this.store.get(taskId));
          await this.svc.flushNow();this.svc.executor?.nudge();return;
        }catch(error){
          await this.markRequestFailed(request,error);
          this.recordContinuationFailure(s.roomId,request,taskId,error);
          await this.svc.flushNow();
        }
      }
      const d=Object.values(s.dispatches).find(d=>d.attemptId===step.currentAttemptId);
      if (s.roles.unattended && d?.terminal && !r.events.some(e=>e.payload.dispatchId===d.dispatchId && e.payload.reviewDecision) &&
          !(step.purpose==="final-delivery" && await this.readFinalReceipt(s))) {
        const reason=await this.documentBlock(r,d);
        if(reason){await this.waitForAction(taskId,[reason]);return;}
      }
      if(step.status==="failed"){
        if(failedBeforeCodexTurn(d.terminal?.receipt?.kind))return;
        const run=this.svc.state.runs.find(r=>r.id===d.runId);
        const output=JSON.parse((await this.store.readBlob(step.attempts[step.currentAttemptId].outputRef)).toString());
        const toolActivity=[...(output.reply?.toolActivity??[]),...(this.svc.ledger?.toolActivityFromRun?.(run?.roomId,run?.id)??[])];
        const readOnly=new Set(["read","read_file","list_files","glob","grep","search","web_search","web_fetch","agent_community_accept_handoff","agent_community_handoff_status"]);
        const safe=!output.reply?.text&&!output.reply?.deliverables?.length&&!Object.values(s.handoffs).some(h=>h.fromDispatchId===d.dispatchId)&&toolActivity.every(t=>readOnly.has(t.name));
        if(step.automaticRecoveries<1&&safe&&run&&effectiveMembers(s).includes(step.targetId)&&this.svc.canRetryToolRelay(run)){await this.retry(run,true,undefined,true);return;}
        await this.waitForAction(taskId,[step.automaticRecoveries>=1?"本棒自动恢复一次额度已用完，请核对原记录后重试当前棒":"原回合成果或停止回执待核对，不能安全重跑"]);return;
      }
      if(step.status==="cancelled")return;
      if(s.roles.unattended&&step.purpose!=="final-delivery"){
        const decision=r.events.findLast(e=>e.payload.dispatchId===d.dispatchId&&e.payload.reviewDecision);
        if(!decision){
          const prior=r.events.filter(e=>e.type==="REVIEW_REQUEUED"&&e.payload.authorizationId===s.activeAuthorizationId&&e.payload.targetId===step.targetId&&e.payload.versionId===s.versionId);
          if(prior.length>=2){await this.waitForAction(taskId,["成员两次补做后仍未交回可核实的稿件或审核回执，已保留上次成果"]);return;}
          const reset=this.events("REVIEW_REQUEUED",{dispatchId:d.dispatchId,versionId:s.versionId,targetId:step.targetId,authorizationId:s.activeAuthorizationId},"requeue:"+d.dispatchId);
          const next=apply(s,{...reset,taskId});
          const plan=await this.buildPlan(next,step.targetId,step.handoffIds,{purpose:"recover-review",previous:d.terminal.outputRef});
          await this.commit(taskId,[reset,...plan.events],r.revision);this.svc.executor?.nudge();return;
        }
      }
      const missing=this.review.missingDecision(r,d);if(missing){await this.waitForAction(taskId,[missing]);return;}
      if(s.roles.kind==="ordered-chat"){
        const output=JSON.parse((await this.store.readBlob(d.terminal.outputRef)).toString());
        const text=output.reply?.text?.trim();
        if(!text){await this.waitForAction(taskId,["当前成员未发出回复"]);return;}
        const next=s.roles.order[step.order+1];
        if(!next){
          await this.commit(taskId,[this.events("ORDERED_CHAT_ENDED",{},"ordered-chat-ended:"+taskId)],r.revision);
          await this.svc.flushNow();
        }else if(effectiveMembers(s).includes(next)){
          await this.planStep(taskId,next,[],{previousReply:{name:this.svc.getBot(step.targetId)?.name??"上一位成员",text}});
          this.svc.executor?.nudge();
        }else await this.waitForAction(taskId,["下一位接话成员当前不可用"]);
        return;
      }
      if(s.versionId){
        let changed=false;for(const ref of s.artifactRefs[s.versionId]??[]){if(!ref.sourcePath)continue;try{if(createHash("sha256").update(await readFile(ref.sourcePath)).digest("hex")!==ref.sha256)changed=true;}catch{changed=true;}}
        if(changed){
          if(Object.keys(s.confirmations).length)await this.commit(taskId,[this.events("ARTIFACT_INVALIDATED",{
            versionId:s.versionId,reason:"已签核的成果文件发生变化或缺失，需要双方重新确认新版本"})]);
          return;
        }
      }
      if(completionReady(s)){
        if((s.roles.writerFinalReview||requestsFile(this.goalCache.get(s.taskId)))&&!requiresFinalDelivery(s)){
          await this.waitForAction(taskId,["约定的最终文件尚未登记到本轮签核版本"]);return;
        }
        let receipt=requiresFinalDelivery(s)?await this.readFinalReceipt(s):null;
        if(!receipt&&s.roles.unattended&&!s.roles.delivererId&&requiresFinalDelivery(s)){
          const reviewer=s.roles.reviewer, signed=s.dispatches[s.confirmations[reviewer].dispatchId];
          const files=await stageVersionFiles(this.store,s,join(this.store.root,"deliveries",digest(s.taskId)));
          const id="run:"+signed.runId+":deliverable";
          const prior=this.svc.ledger.listLedger(s.roomId,{force:true,limit:Number.MAX_SAFE_INTEGER}).find(row=>row.id===id);
          if(!prior)this.svc.ledger.push({type:"deliverable",roomId:s.roomId,botId:reviewer,runId:signed.runId,files});
          receipt=await this.readFinalReceipt(s);
          if(!receipt){await this.waitForAction(taskId,["交付记录待核实，已保留签核终稿"]);return;}
        }
        if(requiresFinalDelivery(s)&&!receipt){
          const reviewer=s.roles.delivererId??s.roles.reviewer;
          const payload=JSON.parse((await this.store.readBlob(d.payloadRef)).toString());
          if(!effectiveMembers(s).includes(reviewer)){
            await this.waitForAction(taskId,["等待终审成员交稿。请在原任务中点名授权终审成员"]);return;
          }
          if(payload.purpose==="final-delivery"){
            await this.waitForAction(taskId,["终审回合已结束，未收到符合签核版本的文件卡片。可继续原任务重试交稿"]);return;
          }
          try { await this.planStep(taskId,reviewer,[],{purpose:"final-delivery",previous:d.terminal?.outputRef}); }
          catch(error){ await this.waitForAction(taskId,["准备原版本交稿失败："+error.message]); }
          return;
        }
        await this.commit(taskId,[this.events("TASK_COMPLETED",{versionId:s.versionId,delivery:receipt??undefined,
          notificationId:"complete:"+taskId+":"+s.activeAuthorizationId+":"+s.versionId},"complete:"+s.activeAuthorizationId+":"+s.versionId)]);
        this.svc.recordNotice(s.roomId,receipt?"整件任务完成：同版本已签核，终审文件已交付。":"整件任务完成：双方已确认同一成果版本。");return;
      }
      const pending=Object.values(s.handoffs).filter(h=>h.status==="pending"),allowed=effectiveMembers({...s,permissions:this.currentMembers(s.roomId)});
      const next=pending.find(h=>allowed.includes(h.targetId));
      if(next){
        const repeated=pending.filter(h=>h.targetId===next.targetId&&h.contentHash===next.contentHash).length+
          Object.values(s.handoffs).filter(h=>h.status==="resolved"&&h.targetId===next.targetId&&h.contentHash===next.contentHash).length;
        if(repeated>=3){await this.waitForAction(taskId,["同一版本和要求反复退回，没有新进展，请核对后继续原任务"]);return;}
        try { await this.planStep(taskId,next.targetId,pending.filter(h=>h.targetId===next.targetId).map(h=>h.id),{previous:d.terminal?.outputRef}); }
        catch(error){await this.waitForAction(taskId,["准备交接失败："+error.message]);}return;
      }
      // A signature requests the other independent confirmation; ordinary turn end never does.
      if(s.versionId){
        const signatureOrder=s.roles.writerFinalReview?[s.roles.reviewer,s.roles.first]:(s.roles.confirmers??[]);
        const target=signatureOrder.find(id=>!signatureVerified(s,id)&&(s.roles.writerFinalReview||allowed.includes(id)));
        if(target && !allowed.includes(target)){await this.waitForAction(taskId,["原单的"+(target===s.roles.reviewer?"复核人":"主笔")+"当前已失去群内资格，保留现有版本和签核。"]);return;}
        if(target){
          const round=s.authSnapshots[s.activeAuthorizationId]?.jointReview?":"+s.activeAuthorizationId:"";
          const h={id:"review:"+s.versionId+":"+target+round,step:"joint-review",targetId:target,
            textRef:await this.store.putBlob(["请复核并确认这一不可变成果版本；有修改请提交新版本。"]),evidenceRefs:s.artifactRefs[s.versionId]??[],
            contentHash:digest({versionId:s.versionId,target}),fromStepId:step.stepId,fromDispatchId:d.dispatchId,fromBotId:d.targetId,status:"pending"};
          // Created by the orchestrator, as a derived event carrying the settled source facts.
          if(!s.handoffs[h.id])await this.commit(taskId,[this.events("REVIEW_REQUESTED",{handoff:h,sourceDispatchId:d.dispatchId})]);
          if(this.store.get(taskId).state.handoffs[h.id]?.status==="pending"){
            try { await this.planStep(taskId,target,[h.id],{previous:d.terminal?.outputRef}); }
            catch(error){await this.waitForAction(taskId,["准备复核失败："+error.message]);}
          }else await this.waitForAction(taskId,[this.nameOfReviewBlock(s,h)]);
          return;
        }
      }
      const output=step.attempts[step.currentAttemptId].outputRef?JSON.parse((await this.store.readBlob(step.attempts[step.currentAttemptId].outputRef)).toString()):{};
      const text=output.reply?.text?.trim()??"";
      // This handover is authorized by the original user and the room's saved workflow.
      // The draft supplies review material. Only the saved role determines its recipient.
      if(s.roles.reviewFirstResult && !s.versionId && !s.stop && !pending.length && s.order.length===1 &&
          d.targetId===s.roles.first && d.receipt && d.turn && d.terminal?.status==="succeeded" &&
          allowed.includes(s.roles.reviewer) && displayReply(text).trim()){
        await this.planStep(taskId,s.roles.reviewer,[],{purpose:"workflow-review",previous:d.terminal.outputRef});
        this.svc.executor?.nudge();return;
      }
      const reasons=pending.length?["待办接收人尚未获本轮用户授权："+pending.map(h=>this.svc.getBot(h.targetId)?.name??h.targetId).join("、")]:
        !text?["本棒空回复，缺少成果或具体交接"]:text==="接力"?["仅有“接力”字样，缺少具体内容和证据"]:
        !s.versionId?["本棒已结束；缺少最终成果版本、证据或明确交接"]:
        ["尚未完成双方同版本确认或交接回执"];
      await this.waitForAction(taskId,reasons);
    });
  }
  async retry(run,automatic,input,inside=false){
    const fn=async()=>{
      const r=this.recordForRun(run),s=r.state,step=s.steps[run.teamStepId];
      const previous=s.dispatches[run.dispatchId];
      if(s.roles.assignment)throw Error("请在原分工下核对接单，或明确点名续接。");
      if(step.currentAttemptId!==run.attemptId)return this.svc.state.runs.find(x=>x.attemptId===step.currentAttemptId);
      if(s.stop||!live(s))throw Error("用户已停止或任务已完成，不能自动恢复");
      if(input&&run.controlRevision!==input.expectedRevision)throw Error("原记录已更新，请刷新");
      if(!ended(step.status)||!step.attempts[run.attemptId].stopVerified)throw Error("原回合未终止，不能重复启动");
      if(!this.svc.canRetryToolRelay(run))throw Error("原上游停止回执尚未核对");
      const p={...this.runInput(run),dispatchId:randomUUID(),attemptId:randomUUID(),ticketId:randomUUID(),
        authorizationId:s.activeAuthorizationId,payloadRef:previous.payloadRef,source:automatic?"automatic":"manual",safeToRetry:true};
      p.runId=p.dispatchId;
      await this.commit(s.taskId,[this.events("DISPATCH_PLANNED",p)],r.revision);await this.svc.flushNow();this.svc.executor?.nudge();
      return this.svc.state.runs.find(x=>x.id===p.runId);
    };
    return inside?fn():this.serial(run.teamTaskId,fn);
  }
  async stop(taskId,reason,guard){
    const record=await this.serial(taskId,async()=>{
      const r=this.store.get(taskId);
      if(guard&&(!r||r.state.roomId!==guard.roomId||r.state.activeAuthorizationId!==guard.messageId))
        throw Error("原任务已变更，请刷新后重试");
      if(!r||r.state.stop)return r;
      if(guard&&r.revision!==guard.expectedRevision)throw Error("任务进度已更新，请刷新后重试");
      if(!live(r.state))throw Error("任务已经结束");
      const d=this.assignments.current(r),proof=r.state.roles.assignment&&this.assignments.absence(r,d);
      const run=proof&&this.svc.state.runs.find(row=>row.id===d.runId&&row.status==="failed");
      const changes=run&&!this.svc.executor?.active.has(run.id)?[this.events("DELIVERY_ABSENT",{...this.runInput(run),proof})]:[];
      return this.commit(taskId,[...changes,this.events("USER_STOPPED",{reason})],r.revision);
    });
    if(!record?.state.stop)return record;
    for(const run of this.svc.state.runs.filter(r=>r.teamTaskId===taskId)){
      if(run.status==="running"&&!run.stop){
        if(!await this.reconcileRejectedStart(this.store.get(taskId),run))
          await this.svc.executor?.requestRunStop(run,{kind:"user",action:"cancel"});
      }
      else if(run.status==="queued"){run.status="cancelled";run.controlRevision++;run.updatedAt=now();}
    }await this.svc.flushNow();
    return this.store.get(taskId);
  }
  async savedBindingRejection(record, run, dispatch) {
    const binding = record.state.bindings[run.botId];
    if (!dispatch?.receipt || dispatch.status !== "unknown" || dispatch.turn || dispatch.stop ||
        record.state.stop || run.stop || run.upstream?.turnId || this.svc.executor?.upstreamByRun?.get(run.id)?.turnId ||
        !binding?.threadId || binding.sessionId !== run.sessionId || this.svc.getBot(run.botId)?.provider !== "codex-cli") return;
    const reported = record.events.some(event => event.type === "DELIVERY_UNKNOWN" &&
      event.payload.dispatchId === run.dispatchId && event.payload.attemptId === run.attemptId &&
      event.payload.reason?.includes(bindingRefusal));
    if (!reported) return;
    // bindCodexThread is awaited by local-agent before the native turn/start request.
    // The exact persisted host error must belong to the receipt for this attempt.
    const host = await this.sessionBridge.inspectStoppedCarrier(run, true).catch(() => undefined);
    const reason = host?.terminal?.raw?.data?.reason;
    if (host?.kind !== "terminal" || host.terminal.status !== "error" || reason?.kind !== "error" ||
        reason.error?.code !== "LOCAL_AGENT_FAILED" || reason.error.message !== bindingRefusal ||
        host.receipt.sessionId !== run.sessionId || host.receipt.messageId !== dispatch.receipt.messageId ||
        host.receipt.eventSeq !== dispatch.receipt.eventSeq || host.terminal.terminalSeq <= host.receipt.eventSeq) return;
    return {kind:"codex-binding-refused", threadId:binding.threadId, sessionId:run.sessionId,
      messageId:host.receipt.messageId, hostMessageSeq:host.receipt.eventSeq, hostTurnId:Number(host.terminal.hostTurnId),
      hostTerminalSeq:host.terminal.terminalSeq, errorCode:reason.error.code, error:reason.error.message};
  }
  async reconcileRejectedStart(record,run) {
    if(!run||run.status!=="running"||this.svc.executor?.active.has(run.id))return false;
    const dispatch=record.state.dispatches[run.dispatchId];
    const receipt=dispatch?.terminal?.receipt;
    if (receipt?.kind==="codex-stop-before-native-turn") {
      if (run.stop?.state!=="confirmed") await this.svc.persistRunStop(run.id,{...run.stop,state:"confirmed",transport:"codex",receipt});
      await this.svc.settleRun({id:run.id,expectedRevision:run.controlRevision,status:"cancelled"});
      return true;
    }
    let error=receipt?.error??dispatch?.verificationReason;
    if(!this.startWasRejected(run)&&!this.startRejectionEvidence(run,record,dispatch,error)) {
      const proof = await this.savedBindingRejection(record,run,dispatch);
      if (!proof) return false;
      const current = this.svc.state.runs.find(row => row.id === run.id);
      if (current?.status !== "running" || current.controlRevision !== run.controlRevision || current.stop ||
          current.upstream?.turnId || this.svc.executor?.active.has(run.id) ||
          this.svc.executor?.upstreamByRun?.get(run.id)?.turnId) return false;
      await this.commit(run.teamTaskId,[this.events("TURN_START_REJECTED",{
        ...this.runInput(run),receipt:proof,terminalId:"start-rejected:"+run.dispatchId
      },"binding-refused:"+run.dispatchId)],record.revision);
      error = proof.error;
    }
    await this.svc.settleRun({id:run.id,expectedRevision:run.controlRevision,status:"failed",error});
    return true;
  }
  async reconcileStoppedCodex(record, run) {
    if (!this.svc.stopRecoveryReady || !run || run.status !== "running" ||
        run.stop?.kind !== "user" || run.stop?.state === "confirmed" || run.stop?.turnId ||
        run.upstream?.turnId || this.svc.executor.active.has(run.id) ||
        this.svc.executor.upstreamByRun?.get(run.id)?.turnId ||
        this.svc.getBot(run.botId)?.provider !== "codex-cli") return;
    const state = record.state;
    const dispatch = state.dispatches[run.dispatchId];
    const binding = state.bindings[run.botId];
    const local = this.svc.ctx.get?.("localAgent");
    if (!state.stop || !dispatch?.receipt || dispatch.turn || !binding?.threadId ||
        binding.sessionId !== run.sessionId || !local?.verifyCodexIdleCheckpoint) return;
    const previous = Object.values(state.dispatches).filter(row =>
      row.targetId === run.botId && row.turn?.sessionId === run.sessionId && row.turn.threadId === binding.threadId &&
      row.terminal?.receipt?.threadId === binding.threadId && row.terminal.receipt.turnId === row.turn.turnId &&
      row.terminal.at <= dispatch.issuedAt
    ).sort((a, b) => a.terminal.at.localeCompare(b.terminal.at)).at(-1);
    if (!previous) return;
    const last = this.stoppedCodexChecks.get(run.id);
    if (last && (last.attempt >= 2 || Date.now() - last.at < 15000)) return;
    this.stoppedCodexChecks.set(run.id, { at: Date.now(), attempt: (last?.attempt ?? 0) + 1 });
    let stage = "host-receipt";
    const diagnostic = process.env.DSH_AGENT_COMMUNITY_RELAY_STARTUP_RECEIPT;
    const report = async result => {
      if (!diagnostic) return;
      await appendFile(diagnostic + ".stop-check.jsonl", JSON.stringify({
        runId: run.id, stage, result, at: now()
      }) + "\n").catch(error => this.svc.ctx.logger?.warn?.("中止核对记录写入失败：" + error.message));
    };
    try {
      const host = await this.sessionBridge.inspectStoppedCarrier(run);
      if (host.kind !== "terminal" || host.receipt.sessionId !== run.sessionId ||
          host.receipt.messageId !== dispatch.receipt.messageId || host.receipt.eventSeq !== dispatch.receipt.eventSeq ||
          !host.terminal?.terminalSeq) {
        await report(host.reason ?? "host-receipt-mismatch");
        return;
      }
      stage = "codex-checkpoint";
      const checkpoint = await local.verifyCodexIdleCheckpoint({sessionId: run.sessionId,
        threadId: binding.threadId, checkpointTurnId: previous.turn.turnId});
      if (!checkpoint || checkpoint.checkpointStatus !== previous.terminal.receipt.status) {
        await report("checkpoint-not-verified");
        return;
      }
      stage = "settle";
      const receipt = {
        ...checkpoint, kind: "codex-stop-before-native-turn", status: "not-started",
        sessionId: run.sessionId, messageId: host.receipt.messageId,
        hostTurnId: Number(host.terminal.hostTurnId), hostTerminalSeq: host.terminal.terminalSeq,
        checkpointDispatchId: previous.dispatchId
      };
      await this.commit(run.teamTaskId, [this.events("TURN_START_REJECTED", {
        ...this.runInput(run), receipt, terminalId: "stop-before-turn:" + run.dispatchId
      }, "stop-before-turn:" + run.dispatchId)], record.revision);
      await this.svc.persistRunStop(run.id, {...run.stop, state: "confirmed", transport: "codex", receipt});
      const latest = this.svc.state.runs.find(row => row.id === run.id);
      if (latest?.status !== "running") return;
      await this.svc.settleRun({id: latest.id, expectedRevision: latest.controlRevision, status: "cancelled"});
      this.svc.ledger?.settleRunEntries(run.id, run.roomId);
      this.svc.recordNotice(run.roomId, "已中止原任务。已核对原宿主回合结束，Codex 未启动新回合。");
      await this.svc.flushNow();
      this.stoppedCodexChecks.delete(run.id);
      await report("confirmed");
      this.svc.executor.nudge();
    } catch (error) {
      const detail = String(error?.message ?? error);
      this.svc.ctx.logger?.warn?.("中止核对未确认，保留原任务：" + detail);
      await report(detail);
    }
  }
  async checkPendingDocumentStart(r) {
    const s = r.state;
    if (!(hasDocumentOrder(s)) || !s.roles.unattended || s.currentStepId ||
        s.status !== "pending-review" || s.stop || !s.missing?.some(reason => reason.startsWith(preflightPrefix))) {
      this.nextDocumentCheck.delete(r.taskId);
      return false;
    }
    if (Date.now() < (this.nextDocumentCheck.get(r.taskId) ?? 0)) return true;
    this.nextDocumentCheck.set(r.taskId, Date.now() + 60_000);
    await this.serial(r.taskId, async () => {
      const current = this.store.get(r.taskId)?.state;
      if (!current || current.currentStepId || current.stop || current.status !== "pending-review" ||
          this.svc.getRoom(current.roomId)?.paused || current.activeAuthorizationId !== s.activeAuthorizationId) return;
      const reasons = await documentPreflight(this.svc, {...current,permissions:this.currentMembers(current.roomId)});
      if (reasons.length) {
        await this.waitForAction(r.taskId,reasons);
        return;
      }
      await this.planStep(r.taskId,current.roles.first);
      this.nextDocumentCheck.delete(r.taskId);
      this.svc.executor?.nudge();
    });
    return true;
  }
  async drain(){
    if(!this.opened||this.draining)return;this.assert();this.draining=true;
    try{
      await this.expireChoices();
      await this.threadCloser.recover();
      await this.assignments.recover();
      for(let r of this.store.list()){
        const members=this.currentMembers(r.state.roomId);if(canonical(members)!==canonical(r.state.permissions))r=await this.commit(r.taskId,[this.events("PERMISSIONS_OBSERVED",{members})]);
        const s=r.state,step=s.steps[s.currentStepId];
        const dispatch=s.dispatches[step?.attempts[step.currentAttemptId]?.dispatchId];
        const run = dispatch && this.svc.state.runs.find(row => row.id === dispatch.runId);
        const waiting=this.waitingTerminals.get(run?.id);
        if (waiting && await this.reconcileRejectedStart(r,run)) {
          this.waitingTerminals.delete(run.id);
          continue;
        }
        if (waiting) {
          if (run.status!=="running" || run.controlRevision!==waiting.input.expectedRevision ||
              (run.stop && waiting.input.status!=="cancelled" && waiting.input.status!=="interrupted")) {
            this.waitingTerminals.delete(run.id);
          } else {
            if (!this.svc.executor?.active.has(run.id) && Date.now()>=waiting.after) {
              waiting.after=Date.now()+5000;
              await this.svc.settleRun(waiting.input);
            }
            continue;
          }
        }
        if(dispatch&&await this.reconcileRejectedStart(r,run))continue;
        const legacyApprovalWait = !s.roles.writerFinalReview && hasDocumentOrder(s) && s.status==="pending-review" && dispatch?.status==="terminal" && s.missing.some(reason=>reason.startsWith("宿主审批阻塞（"));
        if(!legacyApprovalWait&&s.roles.unattended&&live(s)&&!s.stop&&Date.now()-Date.parse(s.authSnapshots[s.activeAuthorizationId]?.at??r.events[0].at)>=maxDeliveryDurationMs){await this.stop(s.taskId,"达到四小时任务总时限，保留最近稿件和复核记录");continue;}
        if(await this.checkPendingDocumentStart(r))continue;
        if(s.status==="stopping") {
          // The durable task decision can precede the executor's per-run intent during startup or shutdown.
          if(this.svc.stopRecoveryReady&&run&&(run.status==="queued"||(run.status==="running"&&!run.stop))){
            await this.stop(s.taskId,s.stop.reason);
          }
          const latest=run&&this.svc.state.runs.find(row=>row.id===run.id);
          await this.reconcileStoppedCodex(this.store.get(s.taskId), latest);
          continue;
        }
        if(!live(s))continue;
        if(step&&ended(step.status)){
          if(!s.roles.assignment&&(s.status!=="pending-review"||!s.missing.length||this.review.freshReturn(s)))await this.advance(s.taskId);
          continue;
        }
        for(const d of Object.values(s.dispatches)){
          if(d.status==="pending"){await this.project(r);this.svc.executor?.nudge();}
          else if(["sending","unknown","delivered","running"].includes(d.status)){
            // Never convert an uncertain upstream attempt to a fresh dispatch.
            const run=this.svc.state.runs.find(v=>v.id===d.runId);
            if(!this.svc.executor?.active.has(d.runId)&&run)await this.reconcile(run,d);
          }
        }
      }
    }finally{this.draining=false;}
  }
  async reconcile(run,d){
    if(this.reconciling?.has(run.id))return;this.reconciling??=new Set();this.reconciling.add(run.id);
    try{
      const binding=this.recordForRun(run).state.bindings[run.botId],route=this.svc.contextRunnerOf(this.svc.getBot(run.botId));
      if (route!=="codex" && d.turn && !d.turn.threadId && d.receipt && !run.stop) {
        const saved=await this.sessionBridge.inspectStoppedCarrier(run,true).catch(()=>null);
        if (saved?.kind==="terminal" && saved.receipt.messageId===d.receipt.messageId &&
            saved.receipt.eventSeq===d.receipt.eventSeq && saved.receipt.sessionId===d.turn.sessionId &&
            saved.terminal.hostTurnId===d.turn.turnId && ["completed","error","aborted","failed","interrupted"].includes(saved.terminal.status)) {
          const status=saved.terminal.status==="completed"?"completed":saved.terminal.status==="aborted"?"cancelled":"failed";
          await this.svc.settleRun({id:run.id,expectedRevision:run.controlRevision,status,
            terminalReceipt:saved.terminal,reply:{text:saved.output}});
          return;
        }
      }
      if(binding?.threadId&&route==="codex"){const local=this.svc.ctx.get?.("localAgent");await local?.restoreCodexContinuation?.({sessionId:binding.sessionId,threadId:binding.threadId});}
      const record=this.recordForRun(run);
      if(record.state.roles.assignment&&this.assignments.absence(record,d))return;
      const found=record.state.roles.assignment?await this.sessionBridge.inspectSaved(run):await this.sessionBridge.inspect(run);
      if(found.kind==="unknown"){await this.recordUncertainDelivery(run,found.reason);return;}
      if(!d.receipt)await this.runtimeAccepted(run.id,found.receipt);
      if(route==="codex"){
        // The original App Server turn must be checked by ID; a native carrier ending is not its receipt.
        if(!d.turn?.threadId||!d.turn?.turnId)return;
        await this.svc.executor?.inspectBeforeTimeout?.(run,{});
        const current=this.svc.state.runs.find(r=>r.id===run.id);
        if(current?.status!=="running" || current.controlRevision!==run.controlRevision ||
           this.svc.executor?.active.has(run.id))return;
        const result=recoveredCodexResult(current,d,found);
        if (result) await this.svc.settleRun({id:run.id,expectedRevision:current.controlRevision,...result});
        return;
      }else if(found.turn&&!d.turn)await this.runtimeStarted(run.id,found.turn);
      if(found.terminal){const status=found.terminal.status==="completed"?"completed":found.terminal.status==="aborted"?"cancelled":"failed";
        await this.svc.settleRun({id:run.id,expectedRevision:run.controlRevision,status,terminalReceipt:found.terminal,reply:{text:found.output}});}
    }finally{this.reconciling.delete(run.id);}
  }
  async botMessage(input){
    const binding=this.svc.state.roomAgentSessions.find(s=>s.sessionId===input.senderSessionId&&s.roomId===input.roomId);
    if(!binding)throw Error("群 Bot 消息缺少宿主会话身份");
    if(input.toBotName){
      const target=this.svc.getRoom(input.roomId).memberIds.map(id=>this.svc.getBot(id)).find(b=>b?.name===input.toBotName);
      if(!target)throw Error("交接目标不在群内");return this.submit({roomId:input.roomId,botId:binding.botId,targetId:target.id,text:input.text});
    }
    const {run}=this.actorRun(input.roomId,binding.botId);
    if (run.sessionId !== input.senderSessionId) throw Error("该发言会话不属于当前派单");
    const prior=this.svc.state.messages.find(message=>message.runId===run.id&&message.roomId===run.roomId&&message.sender.kind==="bot");
    if(prior)return prior;
    const text=displayReply(input.text,"当前任务状态可在详情中查看。");
    if(!text.trim())throw Error("本回合尚无可发布正文");
    const message={id:randomUUID(),roomId:input.roomId,sender:{kind:"bot",botId:run.botId,name:this.svc.getBot(run.botId).name},
      text,mentions:[],runId:run.id,mentionTask:run.teamTaskId,taskRef:run.teamTaskId,presentation:"chat",runtime:"task",createdAt:now(),sequence:this.svc.listMessages(input.roomId).length};
    await this.persistMessage(message);return message;
  }
}
