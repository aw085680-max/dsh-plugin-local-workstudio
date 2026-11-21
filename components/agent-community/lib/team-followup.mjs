import {effectiveMembers} from "./team-machine.mjs";
import {classifyUserRequest,maskGroupLinks} from "./team-chat-routing.mjs";
const finished=s=>["completed","stopped","stopping"].includes(s.status);
const settled=d=>d?.terminal?.status==="succeeded"&&d.receipt&&d.turn;
export function lastAuthorTurn(r,author,until){
  const e=r.events.findLast(e=>e.type==="TURN_ENDED"&&(!until||e.at<=until)&&r.state.dispatches[e.payload.dispatchId]?.targetId===author&&settled(r.state.dispatches[e.payload.dispatchId]));
  return r.state.dispatches[e?.payload.dispatchId];
}
export class TeamFollowup {
  constructor(team){this.team=team;this.svc=team.svc;}
  speechContext(room,input,reference,original,roster){
    const members=roster.map(({id,name})=>({id,name}));
    const id=input.taskId??input.continueTaskId??reference?.taskRef??original?.followupRetry?.anchorTaskId??original?.taskRef??(original&&this.historicalAnchor(room,original))??room.teamCurrentRequest?.taskId;
    if(!id||!this.team.opened||this.team.store.failed)return {members};
    let r;try{r=this.team.store.get(id);}catch{return {members};}
    if(r?.state.roomId!==room.id)return {members};
    const s=r.state,author=s.roles.reviewer,source=author&&lastAuthorTurn(r,author,original?.createdAt);
    const pending=Object.values(s.handoffs).filter(h=>["pending","scheduled","accepted"].includes(h.status));
    const drafted=source&&!r.events.some(e=>e.type==="ARTIFACT_CONFIRMED"&&e.payload.dispatchId===source.dispatchId);
    const nextIds=drafted?[s.roles.first]:pending.length?[...new Set(pending.map(h=>h.targetId))]:s.roles.confirmers??[];
    return {taskId:r.taskId,status:s.status,author,sourceRunId:source?.runId??null,versionId:s.versionId,
      hasReviewWork:s.roles.confirmers?.length===2&&!!(source||s.versionId||pending.length),pendingIds:pending.map(h=>h.id),nextIds,members};
  }
  classify(room,input,original){
    const roster=this.svc.state.bots.filter(b=>room.memberIds.includes(b.id));
    const authored=this.team.helpers.parseMentions(maskGroupLinks(input.text),roster);
    const members=this.team.currentMembers(room.id),selected=new Set(input.mentions??[]);
    const ids=authored.ids.filter(id=>selected.has(id)&&members.includes(id));
    const mentioned=authored.who==="everyone"?[...new Set([...ids,...members])]:ids;
    const unknown=/(?:^|[\s，、。])@[^@\s]/u.test(authored.remainder??"")||!authored.who&&authored.ids.length!==ids.length;
    const refId=input.replyTo??input.threadId,reference=refId?this.svc.state.messages.find(m=>m.roomId===room.id&&m.id===refId):null;
    const invalid=!!refId&&!reference||!!input.threadId&&!this.svc.state.messages.some(m=>m.roomId===room.id&&m.id===input.threadId);
    const context=this.speechContext(room,input,reference,original,roster);
    const body=authored.remainder??input.text,decision=classifyUserRequest(body,{...input,handoffContext:context,hasExplicitOrder:(authored.sequence?.length??0)>1,hasReference:!!reference||!!input.attachments?.length});
    return {roster,authored,ids,mentioned,unknown,reference,invalid,body,decision};
  }
  historicalAnchor(room,message){
    const previous=this.svc.state.messages.filter(m=>m.roomId===room.id&&m.sender.kind==="user"&&m.id!==message.id&&
      (m.sequence!=null&&message.sequence!=null?m.sequence<message.sequence:m.createdAt<message.createdAt));
    const origin=previous.findLast(m=>m.taskRef&&m.runtime==="task"&&!m.requestError&&!m.taskActionError&&this.team.store.get(m.taskRef)?.state.authSnapshots[m.id]);
    return origin?.taskRef??
      previous.findLast(m=>m.chatPlan?.statusReceipt?.taskId)?.chatPlan.statusReceipt.taskId;
  }
  resolve(room,m,input,ref,retry){
    const team=this.team,explicit=input.continueTaskId??input.taskId,linked=ref?.taskRef??ref?.mentionTask??ref?.chatPlan?.statusReceipt?.taskId??ref?.chatPlan?.contextTaskId;
    const pinned=m.followupRetry?.anchorTaskId??m.taskRef??m.chatPlan?.statusReceipt?.taskId??m.chatPlan?.contextTaskId;
    const current=room.teamCurrentRequest?.taskId,old=retry?(pinned??linked??this.historicalAnchor(room,m)):null;
    if(explicit&&linked&&explicit!==linked||ref&&!linked)return {text:"被引用的消息不能唯一对应一张原单，请回复要交接的任务或稿件。"};
    if(retry&&!old)return {text:"无法核实这条历史消息当时对应哪张原单，请回复要交接的原任务。"};
    const recordId=explicit??linked??old??current;
    if(retry&&old&&current&&old!==current){
      const previous=team.store.get(old);
      return {taskId:old,text:previous&&finished(previous.state)?"当时的原任务已结束，当前群任务已更换。":"当前群任务已更换，这条旧重试保留在原任务。"};
    }
    if(!explicit&&!linked&&room.teamCurrentRequest?.status==="pending-selection")return {text:"群里有多个候选任务，请回复其中一张原单。"};
    let r=recordId?team.store.get(recordId):null;
    if(!r&&!recordId){
      const rows=team.taskCandidates(room.id,{},true).filter(x=>x.state.roles.confirmers?.length===2);
      if(rows.length!==1)return {text:rows.length?"群里有多张待复核原单，请回复要交接的那份稿件。":"本群当前没有待交接的复核任务。"};
      r=rows[0];
    }
    if(!r||r.state.roomId!==room.id)return {text:"原任务没有在本群定位到，请回复对应的任务或稿件。"};
    const s=r.state,base={r,taskId:r.taskId},author=s.roles.reviewer,target=s.roles.first;
    if(finished(s)||team.threadCloser.closure(room.id,r.taskId))return {...base,text:s.status==="completed"?"这张原单已经完成。":"这张原单已停止或已收口。"};
    if(s.roles.confirmers?.length!==2||author===target)return {...base,text:"当前原单没有独立的首做与复核接收人，请指明交接哪项工作。"};
    const recipient=m.routeDecision.recipientLabel;
    if(recipient&&!m.routeDecision.recipientId&&!/^(?:[他她]|对方|下一(?:位|棒|个)(?:成员)?|首做(?:成员)?|原作者|应审人|审核方|复核方)$/u.test(recipient))return {...base,text:"没有在原单中核实到接收人「"+recipient+"」，请指明成员或稿件。"};
    const authorized=effectiveMembers({...s,permissions:team.currentMembers(room.id)});
    if(![author,target].every(a=>authorized.includes(a))||(m.mentions??[]).some(a=>!authorized.includes(a)))return {...base,text:"原单成员授权或群成员已变化，交接未投递。"};
    if(room.mentionOnly&&!m.mentions?.length&&!ref)return {...base,text:"本群需要点名稿件成员或回复待审稿。"};
    const source=lastAuthorTurn(r,author),asOf=retry?lastAuthorTurn(r,author,m.createdAt):source;
    const offered=r.events.findLast(e=>e.type==="USER_AUTHORIZED"&&e.payload.authorization?.reviewOffer?.sourceRunId===asOf?.runId&&asOf);
    if(retry&&source?.runId!==asOf?.runId&&!offered)return {...base,text:"这条旧消息对应的稿件已更新，请回复当前要交接的版本。"};
    const known=offered?.payload.authorization.reviewOffer;
    if(known){
      const version=known.manifest.versionId,member=known.targetId,name=team.review.name(member);
      const receipt=r.events.findLast(e=>e.payload.targetId===member&&(e.type==="ARTIFACT_CONFIRMED"&&e.payload.manifest.versionId===version||e.type==="HANDOFF_SUBMITTED"&&e.payload.handoff.reviewDecision?.versionId===version));
      const text=receipt?(receipt.type==="ARTIFACT_CONFIRMED"?name+"已签核 "+version.slice(0,10)+"。":name+"对 "+version.slice(0,10)+" 要求修改："+receipt.payload.handoff.reviewDecision.reason):team.review.feedback(r,member).text;
      if(!retry&&receipt?.type==="HANDOFF_SUBMITTED"){
              const h=s.handoffs[receipt.payload.handoff.id],step=s.steps[s.currentStepId];
              if(h&&["pending","scheduled","accepted"].includes(h.status)){
                if(s.status==="pending-review"&&step&&["succeeded","failed","cancelled"].includes(step.status))return {...base,target:h.targetId,kind:"pending",version};
                return {...base,target:h.targetId,sourceRunId:known.sourceRunId,version,existing:true,text:text+" 下一棒由"+team.review.name(h.targetId)+"处理。"};
              }
            }
      return {...base,target:member,sourceRunId:known.sourceRunId,version,existing:true,text};
    }
    const inbox=Object.values(s.handoffs).filter(h=>["pending","scheduled","accepted"].includes(h.status));
    const next=new Set(inbox.map(h=>h.targetId));
    const signed=source&&r.events.some(e=>e.type==="ARTIFACT_CONFIRMED"&&e.payload.dispatchId===source.dispatchId);
    const outbound=source&&inbox.some(h=>h.fromDispatchId===source.dispatchId);
    if(source&&!signed&&!outbound&&Array.from(next).every(a=>a===author)){
      return {...base,author,target,sourceRunId:source.runId,kind:"draft"};
    }
    if(next.size>1)return {...base,text:"原单有多个不同的待办接收人，请回复要交接的那一棒。"};
    if(inbox.length){
      if(m.routeDecision.recipientId&&m.routeDecision.recipientId!==inbox[0].targetId)return {...base,text:"用户写明的接收人与当前待办不一致，请指明稿件或原单。"};
      const receiver=inbox[0].targetId,name=team.review.name(receiver),step=s.steps[s.currentStepId];
      const live=step&&!["succeeded","failed","cancelled"].includes(step.status);
      if(live)return {...base,target:receiver,text:"当前派单已登记给"+name+"。"+team.review.feedback(r,receiver).text};
      return {...base,target:receiver,kind:"pending",version:s.versionId};
    }
    return {...base,text:source?"当前没有可以唯一确定版本和接收人的待办，请回复相应稿件。":"原单还没有收到复核成员的稿件，等待当前一棒回报。"};
  }
  async save(m){
    const prev=this.svc.state.messages.find(x=>x.id===m.id&&x.roomId===m.roomId);
    if(!prev)return this.team.persistMessage(m);
    if(!m.followupRetry||prev.sender.kind!=="user"||prev.text!==m.text||prev.createdAt!==m.createdAt)return prev;
    this.svc.state={...this.svc.state,messages:this.svc.state.messages.map(x=>x===prev?m:x)};
    await this.svc.flushNow();this.svc.ctx.emit?.("agent-community:update",{roomId:m.roomId,kind:"message"});return m;
  }
  async apply(room,message,input,reference,run){
    const team=this.team,m=run?{...message,routeDecision:{...input.decision,referenceId:reference?.id??null},runtime:"task",presentation:"chat"}:message;
    try{
      const bound=this.resolve(room,m,input,reference,!!run);
      if(run&&!m.followupRetry){
        m.followupRetry={runId:run.id,at:new Date().toISOString(),anchorTaskId:bound.taskId??null,expectedRevision:run.controlRevision,
          original:{runtime:message.runtime,routeDecision:message.routeDecision,chatPlan:message.chatPlan,authorizationSnapshot:message.authorizationSnapshot}};
        if(m.chatPlan)m.chatPlan={...m.chatPlan,closedAt:m.followupRetry.at};
      }
      if(bound.taskId)m.taskRef=m.mentionTask=bound.taskId;
      if(room.paused)throw Error("群聊已暂停，原单尚未投递。");
      if(!bound.kind){
        m.followupReceipt={taskId:bound.taskId??null,versionId:bound.version??null,targetId:bound.target??null,text:bound.text};
        if(bound.existing)m.reviewAlias={...m.followupReceipt};
        return await this.save(m);
      }
      if(bound.kind==="draft"){
        m.followupSource={taskId:bound.taskId,sourceRunId:bound.sourceRunId,targetId:bound.target};
        return await team.review.request(room,m,{...input,taskId:bound.taskId},reference);
      }
      const s=bound.r.state,auth={...m.authorizationSnapshot,members:effectiveMembers({...s,permissions:team.currentMembers(room.id)})};
      m.authorizationSnapshot=auth;
      await this.save(m);
      await team.resumeRequest(bound.taskId,m,auth,{fallback:bound.target,preferTarget:true});
      team.setCurrentRequest(room.id,m.id,team.store.get(bound.taskId));await this.svc.flushNow();this.svc.executor?.nudge();return m;
    }catch(error){
      m.requestError=String(error?.message??error);await this.save(m);return m;
    }
  }
  async retry(room,message,run){
    const team=this.team;
    if(message.followupRetry?.runId===run.id){
      if(message.reviewReturn&&!message.requestError&&!message.reviewAlias)await team.review.process(message);
      return this.result(message,run.id);
    }
    const input={roomId:room.id,text:message.text,mentions:message.mentions??[],replyTo:message.replyTo,threadId:message.threadId};
    const parsed=this.classify(room,input,message);
    if(parsed.decision.intent!=="return-review"){
      if(parsed.decision.reviewQuery){
        const next={...message},marked=parsed.mentioned;
        team.chat.prepare(room,next,{...parsed.authored,ids:parsed.ids},marked,parsed.reference,parsed.decision,parsed.unknown||parsed.invalid);
        if(next.chatPlan?.statusReceipt)await team.chat.updatePlan(message,{reviewQuery:true,statusReceipt:next.chatPlan.statusReceipt,statusContext:next.chatPlan.statusContext});
      }
      return null;
    }
    if(parsed.unknown||parsed.invalid)throw Error("原消息点名或引用已失效，请选取原群的稿件。");
    if(this.svc.state.runs.some(r=>r.originMessageId===message.id&&r.id!==run.id&&["running","queued"].includes(r.status)))throw Error("同一消息还有未结束的回合，等待其回执后可重试。");
    const m=await this.apply(room,message,{...input,decision:parsed.decision},parsed.reference,run);
    return this.result(m,run.id);
  }
  result(m,runId){const r=m.taskRef&&this.team.store.get(m.taskRef);return {ok:true,requestId:m.id,runId,taskId:m.taskRef??null,status:r?.state.status??"unresolved",reclassified:true,detail:m.requestError??m.followupReceipt?.text??(r?this.team.review.feedback(r).text:"待定位原单。")};}
}

