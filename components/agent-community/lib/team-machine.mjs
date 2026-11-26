import {createHash} from "node:crypto";

export const SCHEMA_VERSION = 1;
export const bindingRefusal = "当前棒没有可核对的Codex分支关系";
export function failedBeforeCodexTurn(kind) {
  return kind === "codex-resume-active-writer" || kind === "codex-binding-refused";
}
export function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(v => canonical(v ?? null)).join(",") + "]";
  return "{" + Object.keys(value).filter(k => value[k] !== undefined).sort().map(k => JSON.stringify(k)+":"+canonical(value[k])).join(",") + "}";
}
export const digest = value => createHash("sha256").update(typeof value === "string" ? value : canonical(value)).digest("hex");
export const copy = value => JSON.parse(canonical(value));
export class TransitionError extends Error {
  constructor(code, message) {super(message);this.name="TransitionError";this.code=code;}
}
const need=(ok,code,message)=>{if(!ok)throw new TransitionError(code,message);};
const terminal = status => ["succeeded","failed","cancelled"].includes(status);
const closed = state => ["completed","stopped"].includes(state.status);
export function emptyState(taskId) {
  return {taskId,status:"uninitialized",roomId:null,goalRef:null,authSnapshots:{},activeAuthorizationId:null,
    permissions:[],roles:{},messages:[],steps:{},order:[],currentStepId:null,handoffs:{},tickets:{},
    dispatches:{},manifests:{},artifactRefs:{},versionId:null,confirmations:{},bindings:{},missing:[],stop:null,
    completion:null,history:null};
}
export function effectiveMembers(s,authorizationId=s.activeAuthorizationId) {
  return (s.authSnapshots[authorizationId]?.members??[]).filter(id=>s.permissions.includes(id));
}
function activeAttempt(s,p,{terminalAllowed=false}={}) {
  const d=s.dispatches[p.dispatchId],step=d&&s.steps[d.stepId];
  need(d&&step,"UNKNOWN_DISPATCH","派单不存在");
  for(const key of ["taskId","stepId","attemptId","ticketId","targetId"])if(p[key]!==undefined)
    need(p[key]===d[key],"IDENTITY_MISMATCH","回执字段不匹配："+key);
  need(step.currentAttemptId===d.attemptId,"STALE_ATTEMPT","旧运行回执不能推进当前棒");
  if(!terminalAllowed)need(!terminal(step.attempts[d.attemptId].status),"ATTEMPT_ENDED","回合已经结束");
  return {d,step,attempt:step.attempts[d.attemptId]};
}
function mayAct(s,p) {
  const x=activeAttempt(s,p);
  need(!closed(s)&&s.status!=="stopping","TASK_CLOSED","任务已停止或结束");
  need(effectiveMembers(s,x.d.authorizationId).includes(x.d.targetId),"AUTH_REVOKED","成员不在原授权与当前权限交集");
  return x;
}
function actor(s,p) {
  const x=mayAct(s,p);
  need(p.actor?.kind==="host-run"&&p.actor.botId===x.d.targetId&&p.actor.runId===x.d.runId,
    "UNTRUSTED_ACTOR","只接受宿主绑定的当前运行身份");
  need(x.attempt.status==="running","NOT_RUNNING","工具调用不属于执行中的回合");
  return x;
}
export function manifestOf(body, evidence) {
  const normalized=String(body??"").normalize("NFC").replace(/\r\n?/g,"\n").trim();
  need(normalized&&!/^(?:接力|继续|完成|好的|已完成)[。.!！\s]*$/u.test(normalized),"MISSING_ARTIFACT","缺少可核对的最终成果正文");
  need(Array.isArray(evidence)&&evidence.length>0,"MISSING_EVIDENCE","缺少成果证据");
  const refs=evidence.map(r=>({id:r.id,sha256:r.sha256,kind:r.kind})).sort((a,b)=>canonical(a).localeCompare(canonical(b)));
  need(refs.every(r=>typeof r.id==="string"&&r.id&&/^[a-f0-9]{64}$/i.test(r.sha256)),"INVALID_EVIDENCE","证据必须有稳定 ID 和 SHA-256");
  const bodyHash=digest(normalized);return {versionId:digest({bodyHash,evidence:refs}),bodyHash,evidence:refs};
}
export function signatureVerified(s,id) {
  const c=s.confirmations[id],d=c&&s.dispatches[c.dispatchId];
  return !!c&&c.versionId===s.versionId&&(c.legacyReceipt?.terminalStatus==="completed"||
    !!d&&s.steps[d.stepId]?.attempts[d.attemptId]?.status==="succeeded");
}
export function completionReady(s) {
  const required=s.roles.confirmers??[],m=s.manifests[s.versionId];
  if(required.length!==2||!m||closed(s)||s.stop)return false;
  if(!required.every(id=>signatureVerified(s,id)))return false;
  if(Object.values(s.handoffs).some(h=>!["resolved","revoked"].includes(h.status)))return false;
  return Object.values(s.dispatches).every(d=>["terminal","revoked"].includes(d.status));
}

/** Pure reducer. All time, identity, permission and receipt facts come from persisted events. */
export function apply(input, event) {
  const s=copy(input),p=event.payload??{};
  need(event.taskId===s.taskId,"TASK_MISMATCH","事件属于其他任务");
  need(typeof event.id==="string"&&event.id&&typeof event.at==="string"&&Number.isFinite(Date.parse(event.at)),
    "INVALID_EVENT","事件缺少稳定 ID 或时间");
  if(event.type==="REJECTED")return s;
  if(event.type==="TASK_CREATED") {
    need(s.status==="uninitialized","ALREADY_CREATED","任务已经存在");
    need(p.roomId&&p.authorization?.messageId&&p.authorization.members.length>0,"MISSING_AUTH","创建任务需要明确用户授权");
    s.roomId=p.roomId;s.goalRef=p.goalRef;s.roles=copy(p.roles??{});s.permissions=[...p.permissions];
    s.authSnapshots[p.authorization.messageId]=copy(p.authorization);s.activeAuthorizationId=p.authorization.messageId;
    s.messages=[p.messageRef];s.status="pending";return s;
  }
  if(event.type==="HISTORY_IMPORTED") {
    need(s.status==="uninitialized","ALREADY_IMPORTED","历史已迁入");
    const restored=copy(p.state);need(restored.taskId===s.taskId,"TASK_MISMATCH","迁移任务身份不一致");
    need(["completed","stopped","pending-review","pending","running","verifying"].includes(restored.status),"INVALID_MIGRATION","迁移状态非法");
    return restored;
  }
  need(s.status!=="uninitialized","NOT_CREATED","任务尚未创建");
  if(event.type==="FINAL_DELIVERER_SELECTED") {
    need(!closed(s)&&!s.stop&&s.recoveredReview&&s.roles.confirmers.includes(p.delivererId)&&effectiveMembers(s).includes(p.delivererId)&&p.source==="group-workflow","DELIVERY_SCOPE","交付人不在原单的授权成员内");
    need(terminal(s.steps[s.currentStepId]?.status)&&!s.order.some(id=>s.steps[id]?.purpose==="final-delivery"),"DELIVERY_STARTED","当前回合尚未结算或已进入交稿");
    s.roles.delivererId=p.delivererId;return s;
  }
  if(event.type==="USER_DRAFT_SUBMITTED") {
    const a=p.authorization,m=p.manifest,g=a?.documentWorkOrder;
    need(s.status==="pending-review"&&!s.stop&&!s.versionId&&Object.values(s.dispatches).every(d=>["terminal","revoked"].includes(d.status)),
      "RECOVERY_STATE","只允许为已停在送审前的原单登记用户稿");
    need(g?.taskId===s.taskId&&g.roomId===s.roomId&&g.origin===a.messageId&&!s.authSnapshots[a.messageId]&&
      s.authSnapshots[a.originalMessageId]&&g.writer===s.roles.first&&g.reviewer===s.roles.reviewer&&g.deliverer===(s.roles.delivererId??s.roles.reviewer)&&
      canonical(a.members)===canonical(s.roles.confirmers)&&a.members.every(id=>effectiveMembers(s).includes(id))&&p.messageRef?.sha256,
      "RECOVERY_SCOPE","待审稿与本单用户授权不符");
    need(m?.bodyRef?.sha256===m.bodyHash&&m.versionId===digest({bodyHash:m.bodyHash,evidence:m.evidence})&&
      /^[a-f0-9]{64}$/.test(p.sourceHash)&&p.refs?.length===1&&p.refs[0].sha256===m.bodyHash&&
      canonical(a.reviewOffer?.manifest)===canonical(m)&&a.reviewOffer.targetId===g.reviewer,"MANIFEST_MISMATCH","重建稿清单与正文不符");
    s.authSnapshots[a.messageId]=copy(a);s.activeAuthorizationId=a.messageId;s.messages.push(copy(p.messageRef));
    s.versionId=m.versionId;s.manifests[m.versionId]=copy(m);s.artifactRefs[m.versionId]=copy(p.refs);s.confirmations={};
    s.recoveredReview={versionId:m.versionId,sourceHash:p.sourceHash,sourceName:p.sourceName,origin:a.originalMessageId};
    s.missing=[];s.status="pending";return s;
  }
  if(event.type==="REVIEW_HANDOFF_RECOVERED") {
    const h=s.handoffs[p.handoffId], source=h&&s.dispatches[h.fromDispatchId], m=p.manifest, a=p.authorization;
    need(s.status==="pending-review" && !s.stop && !s.versionId && !s.roles.reviewer && h?.status==="pending" &&
      h.fromBotId===s.roles.first && source?.terminal?.status==="succeeded" && source.targetId===h.fromBotId &&
      source.stepId===s.currentStepId && h.targetId!==h.fromBotId, "RECOVERY_STATE","交接已变化，不能按待接稿恢复");
    need(h.textRef.sha256===p.sourceHash && p.workOrderRef?.sha256 && a?.originalMessageId===s.activeAuthorizationId &&
      a.members.length===2 && a.members[0]===h.fromBotId && a.members[1]===h.targetId &&
      a.members.every(id=>s.permissions.includes(id)), "RECOVERY_SCOPE","恢复授权与原交接不匹配");
    need(m?.bodyRef?.sha256===m.bodyHash && m.versionId===digest({bodyHash:m.bodyHash,evidence:m.evidence}) &&
      p.refs?.length===1 && m.evidence.length===1 && m.evidence[0].sha256===p.refs[0].sha256 &&
      p.refs[0].sha256===m.bodyHash,"MANIFEST_MISMATCH","待审版本不符合原稿登记");
    s.authSnapshots[a.messageId]=copy(a);s.activeAuthorizationId=a.messageId;
    s.roles={...s.roles,unattended:true,reviewProtocol:2,reviewFirstResult:true,order:[...a.members],confirmers:[...a.members],reviewer:h.targetId};
    s.recoveredReview={handoffId:h.id,sourceHash:p.sourceHash,sourceDispatchId:h.fromDispatchId,versionId:m.versionId,workOrderRef:copy(p.workOrderRef)};
    s.versionId=m.versionId;s.manifests[m.versionId]=copy(m);s.artifactRefs[m.versionId]=copy(p.refs);
    h.reviewDraft={manifest:copy(m),refs:copy(p.refs)};h.evidenceRefs=copy(p.refs);
    s.missing=[];s.status="pending";return s;
  }
  if(event.type==="PERMISSIONS_OBSERVED") {
    s.permissions=[...new Set(p.members)];
    for(const d of Object.values(s.dispatches))if(d.status==="pending"&&!effectiveMembers(s,d.authorizationId).includes(d.targetId)){
      d.status="revoked";s.tickets[d.ticketId].events.push({kind:"revoked",eventId:event.id,at:event.at,reason:"permission-revoked"});
      const step=s.steps[d.stepId];step.attempts[d.attemptId].status="cancelled";step.status="cancelled";
      if(!closed(s)){s.status="pending-review";s.missing=["接收方已离群或撤权，旧票据已撤销"];}
    }return s;
  }
  if(event.type==="USER_AUTHORIZED") {
    need(p.authorization?.messageId&&p.authorization.members?.length,"MISSING_AUTH","续做必须有用户授权");
    need(!s.authSnapshots[p.authorization.messageId],"AUTH_IMMUTABLE","授权快照不能覆盖");
    need(!s.stop||p.resumeStopped===true,"STOPPED","任务已由用户停止，请明确继续原任务");
    const recovery=p.recover;
    if(recovery?.kind==="final-delivery") {
      need(!s.stop&&s.status==="completed"&&s.versionId===recovery.versionId&&
        (s.roles.confirmers??[]).length===2&&s.roles.confirmers.every(id=>signatureVerified(s,id)),
        "UNVERIFIED_SIGNATURES","原签核版本或终态未核实");
    }
    if(recovery?.kind==="signed-resume"){
      need(s.status==="stopped" && p.resumeStopped && recovery.versionId===s.versionId &&
        s.roles.unattended && s.roles.confirmers?.length===2 && s.roles.confirmers.every(id=>p.authorization.members.includes(id) && effectiveMembers(s).includes(id)) &&
        Object.values(s.dispatches).every(d=>["terminal","revoked"].includes(d.status)) &&
        Object.keys(s.confirmations).length>0 && Object.keys(s.confirmations).every(id=>signatureVerified(s,id)),
        "UNVERIFIED_SIGNATURES","续办前须核对当前版本、原签核、成员和终态");
    }
    if(closed(s)){
      if(s.completion)s.completionHistory=[...(s.completionHistory??[]),s.completion];
      s.completion=null;
      if(!["final-delivery","signed-resume"].includes(recovery?.kind))s.confirmations={};
    }
    if(recovery?.kind==="legacy-cap") {
      need(!s.stop&&!!s.history?.sourceRef&&s.status==="completed","UNVERIFIED_HISTORY","旧任务结算证据缺失");
      for(const [id,refs] of Object.entries(recovery.handoffRefs??{})) {
        const h=s.handoffs[id];
        need(h&&h.status==="pending","HANDOFF_MISMATCH","历史待办已经处理或撤销");
        h.evidenceRefs=copy(refs);
      }
      if(recovery.manifest) {
        const m=recovery.manifest;
        need(m.bodyRef.sha256===m.bodyHash&&m.versionId===digest({bodyHash:m.bodyHash,evidence:m.evidence}),
          "MANIFEST_MISMATCH","旧签核的成果版本哈希不一致");
        s.versionId=m.versionId;s.manifests[m.versionId]=copy(m);s.artifactRefs[m.versionId]=copy(recovery.refs);
        s.confirmations=copy(recovery.confirmations);
      }
    }
    if(p.returnHandoffs)for(const id of p.returnHandoffs){
      const h=s.handoffs[id],step=h&&s.steps[h.stepId],attempt=step?.attempts?.[step.currentAttemptId];
      need(h&&["scheduled","accepted"].includes(h.status)&&attempt?.stopVerified===true&&
        terminal(attempt.status),"HANDOFF_ACTIVE","原接棒回合尚未核实结束");
      h.status="pending";delete h.stepId;delete h.acceptedDispatchId;delete h.acceptedRunId;delete h.acceptedAt;
    }
    s.authSnapshots[p.authorization.messageId]=copy(p.authorization);s.activeAuthorizationId=p.authorization.messageId;
    s.messages.push(p.messageRef);if(closed(s)||s.status==="pending-review"){s.status="pending";s.stop=null;s.missing=[];}
    return s;
  }
  if(event.type==="REVIEW_REQUEUED"){
    const d=s.dispatches[p.dispatchId],step=s.steps[s.currentStepId];
    need(s.roles.unattended&&!s.stop&&!closed(s)&&d?.terminal?.status==="succeeded"&&d.stepId===step.stepId&&step.targetId===p.targetId,"REVIEW_ACTIVE","需要已结束且身份一致的审稿回合");
    for(const id of step.handoffIds){const h=s.handoffs[id];h.status="pending";delete h.stepId;delete h.acceptedDispatchId;delete h.acceptedAt;}
    return s;
  }
  if(event.type==="REQUIREMENTS_UPDATED"){
    const step=s.steps[s.currentStepId];
    need(s.roles.unattended&&!closed(s)&&!s.stop&&(!step||terminal(step.status)),"TASK_ACTIVE","只能在已核实的回合边界应用补充");
    need((s.roles.writerFinalReview?p.authorization?.members?.every(id=>[...s.roles.confirmers,s.roles.delivererId].includes(id)&&effectiveMembers(s).includes(id))&&p.authorization.members.includes(s.roles.delivererId):p.authorization?.members?.length===2)&&s.roles.confirmers.every(id=>p.authorization.members.includes(id)&&effectiveMembers(s).includes(id)),"AUTH_REVOKED","补充要求的工作成员已变化");
    s.authSnapshots[p.authorization.messageId]=copy(p.authorization);s.activeAuthorizationId=p.authorization.messageId;
    s.messages.push(copy(p.messageRef));s.previousVersion=s.versionId??s.previousVersion;s.versionId=null;s.confirmations={};
    for(const h of Object.values(s.handoffs))if(!["resolved","revoked"].includes(h.status))h.status="revoked";
    s.status="pending";s.missing=[];return s;
  }
  if(event.type==="SESSION_BOUND") {
    need(p.botId&&p.sessionId&&p.rootSessionId&&p.creationRelation,"MISSING_RELATION","缺少根会话或创建关系");
    const old=s.bindings[p.botId];
    need(!old||old.sessionId===p.sessionId&&old.rootSessionId===p.rootSessionId,"SESSION_MISMATCH","原会话映射不能静默替换");
    s.bindings[p.botId]={...old,...copy(p)};return s;
  }
  if(event.type==="STEP_PLANNED") {
    need(!closed(s)&&s.status!=="stopping","TASK_CLOSED","任务已收口");
    need(!s.steps[p.stepId],"DUPLICATE_STEP","逻辑步骤重复");
    need(!s.currentStepId||terminal(s.steps[s.currentStepId]?.status),"PREVIOUS_ACTIVE","上一棒尚未结束");
    need(effectiveMembers(s,p.authorizationId).includes(p.targetId),"AUTH_REVOKED","下一棒没有有效用户授权");
    if(p.handoffIds?.length)for(const id of p.handoffIds){
      const h=s.handoffs[id];need(h&&h.targetId===p.targetId&&h.status==="pending","HANDOFF_MISMATCH","交接身份或状态不匹配");
      h.stepId=p.stepId;h.status="scheduled";
    }
    s.steps[p.stepId]={stepId:p.stepId,targetId:p.targetId,...(p.purpose==="final-delivery"?{purpose:p.purpose}:{}),authorizationId:p.authorizationId,
      order:s.order.length,status:"pending",handoffIds:p.handoffIds??[],attempts:{},currentAttemptId:null,
      automaticRecoveries:0,retrySources:[],payloadRef:p.payloadRef};
    s.order.push(p.stepId);s.currentStepId=p.stepId;s.status="pending";s.missing=[];return s;
  }
  if(event.type==="DISPATCH_PLANNED") {
    need(!closed(s)&&s.status!=="stopping","TASK_CLOSED","任务已收口");
    const step=s.steps[p.stepId];need(step&&s.currentStepId===p.stepId,"STEP_MISMATCH","派单不是当前棒");
    need(effectiveMembers(s,p.authorizationId).includes(p.targetId)&&step.targetId===p.targetId,"AUTH_REVOKED","目标失去授权");
    const previous=step.currentAttemptId&&step.attempts[step.currentAttemptId];
    need(!previous||terminal(previous.status),"ACTIVE_ATTEMPT","同一逻辑棒已有有效运行");
    if(previous) {
      need(previous.stopVerified===true&&p.safeToRetry===true,"RETRY_UNVERIFIED","旧回合或成果未核对，不能重跑");
      need(["automatic","manual"].includes(p.source),"MISSING_RETRY_SOURCE","重试来源缺失");
      if(p.source==="automatic") {need(step.automaticRecoveries<1,"RECOVERY_EXHAUSTED","本棒自动恢复额度已用完");step.automaticRecoveries++;}
      step.retrySources.push({source:p.source,attemptId:p.attemptId,at:event.at});
    }
    need(!s.dispatches[p.dispatchId]&&!s.tickets[p.ticketId]&&!step.attempts[p.attemptId],"DUPLICATE_INTENT","派单、票据或尝试 ID 重复");
    const ticket={ticketId:p.ticketId,taskId:s.taskId,stepId:p.stepId,attemptId:p.attemptId,
      dispatchId:p.dispatchId,targetId:p.targetId,authorizationId:p.authorizationId,issuedAt:event.at};
    s.tickets[p.ticketId]={issued:ticket,issuedHash:digest(ticket),events:[]};
    const d={...ticket,runId:p.runId,status:"pending",payloadRef:p.payloadRef,sends:0,receipt:null,turn:null};
    s.dispatches[p.dispatchId]=d;step.currentAttemptId=p.attemptId;step.status="pending";
    step.attempts[p.attemptId]={attemptId:p.attemptId,dispatchId:p.dispatchId,runId:p.runId,status:"pending",source:p.source??"initial",stopVerified:false};
    s.status="pending";return s;
  }
  if(event.type==="DELIVERY_STARTED") {
    const {d,attempt}=mayAct(s,p);need(["pending","unknown"].includes(d.status),"DELIVERY_STATE","该派单不能重复投递");
    need(p.verifiedAbsent===true||d.sends===0,"ACCEPTANCE_UNKNOWN","重发前必须核对原投递");
    d.status="sending";d.sends++;d.sentAt=event.at;attempt.status="delivering";return s;
  }
  if(event.type==="DELIVERY_UNKNOWN") {
    const {d}=activeAttempt(s,p,{terminalAllowed:true});if(closed(s)){d.lateEvidence=[...(d.lateEvidence??[]),copy(p)];return s;}
    d.status="unknown";d.verificationReason=p.reason;s.status="verifying";s.missing=[p.reason??"投递结果待核对"];return s;
  }
  if(event.type==="DELIVERY_DEFERRED") {
    const {d,attempt}=mayAct(s,p);need(!d.receipt,"ALREADY_DELIVERED","宿主已收件");
    d.status="pending";d.deferredReason=p.reason;attempt.status="pending";s.missing=[p.reason];return s;
  }
  if(event.type==="HOST_ACCEPTED") {
    const {d,step,attempt}=activeAttempt(s,p,{terminalAllowed:true});
    need(p.receipt?.sessionId&&(p.receipt.messageId||p.receipt.childId||p.receipt.acceptanceId),"MISSING_RECEIPT","宿主受理回执缺少会话或受理标识");
    if(d.receipt){need(["sessionId","messageId","childId","acceptanceId"].every(key=>!d.receipt[key]||d.receipt[key]===p.receipt[key]),"RECEIPT_CONFLICT","同一派单回执冲突");return s;}
    if(closed(s)){d.lateEvidence=[...(d.lateEvidence??[]),copy(p)];return s;}
    const stopping=s.status==="stopping";
    need(stopping||effectiveMembers(s,d.authorizationId).includes(d.targetId),"AUTH_REVOKED","接单时授权已失效");
    d.receipt=copy(p.receipt);d.status="delivered";attempt.status="delivered";step.status="delivered";
    s.tickets[d.ticketId].events.push({kind:"consumed",eventId:event.id,at:event.at,receipt:copy(p.receipt)});
    if(!stopping)s.status="delivered";return s;
  }
  if(event.type==="TURN_STARTED") {
    const {d,step,attempt}=activeAttempt(s,p);const stopping=s.status==="stopping";
    if(closed(s)){d.lateEvidence=[...(d.lateEvidence??[]),copy(p)];return s;}
    need(stopping||effectiveMembers(s,d.authorizationId).includes(d.targetId),"AUTH_REVOKED","成员已失去授权");
    need(d.receipt&&p.turn?.turnId&&p.turn.sessionId===d.receipt.sessionId,"TURN_MISMATCH","回合与宿主受理会话不匹配");
    need(!d.turn||(d.turn.sessionId===p.turn.sessionId&&d.turn.turnId===p.turn.turnId&&(!d.turn.threadId||d.turn.threadId===p.turn.threadId)),"TURN_CONFLICT","同一派单不能启动第二个回合");if(d.turn)return s;
    d.turn=copy(p.turn);d.status="running";attempt.status="running";step.status="running";if(!stopping)s.status="running";return s;
  }
  if(event.type==="HANDOFF_SUBMITTED") {
    const {d}=actor(s,p);const h=p.handoff;
    need(h&&h.id&&h.targetId!==d.targetId,"INVALID_HANDOFF","交接目标必须是其他成员");
    need(h.textRef||h.evidenceRefs?.length,"EMPTY_HANDOFF","交接缺少具体内容或文件");
    const old=s.handoffs[h.id];if(old){need(old.contentHash===h.contentHash,"HANDOFF_IMMUTABLE","同一交接内容不可覆盖");return s;}
    s.handoffs[h.id]={...copy(h),fromStepId:d.stepId,fromDispatchId:d.dispatchId,fromBotId:d.targetId,
      status:"pending",at:event.at};return s;
  }
  if(event.type==="REVIEW_REQUESTED") {
    need(!closed(s)&&s.status!=="stopping","TASK_CLOSED","任务已收口");
    const d=s.dispatches[p.sourceDispatchId],h=p.handoff;
    need(d?.status==="terminal"&&s.steps[d.stepId]?.attempts[d.attemptId]?.status==="succeeded"&&s.versionId,"INVALID_REVIEW","返审必须来自成功结算且有成果版本的回合");
    need((s.roles.confirmers??[]).includes(h.targetId),"INVALID_REVIEWER","不是本任务确认成员");
    if(s.handoffs[h.id])return s;s.handoffs[h.id]={...copy(h),at:event.at};return s;
  }
  if(event.type==="DELIVERY_ABSENT") {
    const {d,attempt}=activeAttempt(s,p,{terminalAllowed:true});
    need(p.proof?.definitive===true&&p.proof.kind==="not-found"&&!d.turn&&!d.receipt,"ACCEPTANCE_UNKNOWN","缺少原派单未收件的确定证据");
    need(!closed(s)&&s.status!=="stopping","TASK_CLOSED","任务已收口");
    d.status="pending";d.absenceProof=copy(p.proof);attempt.status="pending";s.status="pending";return s;
  }
  if(event.type==="HANDOFF_ACCEPTED") {
    const {d,step}=actor(s,p),h=s.handoffs[p.handoffId];
    need(h&&h.stepId===step.stepId&&h.targetId===d.targetId,"HANDOFF_MISMATCH","不是本回合的交接");
    if(h.acceptedDispatchId===d.dispatchId)return s;
    need(["scheduled","accepted"].includes(h.status),"HANDOFF_STATE","交接状态非法");
    h.status="accepted";h.acceptedDispatchId=d.dispatchId;h.acceptedAt=event.at;return s;
  }
  if(event.type==="ARTIFACT_CONFIRMED") {
    const {d}=actor(s,p);
    need((s.roles.confirmers??[]).includes(d.targetId),"CANNOT_SIGN","队长或其他成员不能代替双方签核");
    const m=copy(p.manifest);
    need(m&&/^[a-f0-9]{64}$/.test(m.bodyHash??"")&&m.bodyRef?.sha256===m.bodyHash&&Array.isArray(m.evidence)&&m.evidence.length>0,"MISSING_ARTIFACT","成果正文或证据持久引用缺失");
    need(m.versionId===digest({bodyHash:m.bodyHash,evidence:m.evidence}),"MANIFEST_MISMATCH","成果版本哈希不匹配");
    need(s.steps[d.stepId].handoffIds.every(id=>s.handoffs[id]?.acceptedDispatchId===d.dispatchId),"HANDOFF_UNREAD","请先接收本棒交接");
    if(s.versionId!==m.versionId){s.confirmations={};s.versionId=m.versionId;}
    if(s.manifests[m.versionId])need(canonical(s.manifests[m.versionId])===canonical(m),"MANIFEST_IMMUTABLE","成果清单不可修改");
    s.manifests[m.versionId]=m;s.artifactRefs[m.versionId]=[...(s.artifactRefs[m.versionId]??[]),...copy(p.evidenceRefs??[])].filter((ref,i,refs)=>refs.findIndex(v=>v.id===ref.id&&v.sourcePath===ref.sourcePath)===i);
    if (!(s.roles.writerFinalReview && p.reviewDecision?.action==="revise")) {
      s.confirmations[d.targetId]={botId:d.targetId,versionId:m.versionId,dispatchId:d.dispatchId,at:event.at};
    }
    return s;
  }
  if(event.type==="ARTIFACT_INVALIDATED") {
    need(p.versionId===s.versionId,"VERSION_MISMATCH","不是当前成果版本");
    s.confirmations={};s.missing=[p.reason??"正文或证据已变更，需要双方重新确认"];s.status="pending-review";return s;
  }
  if(event.type==="TURN_START_REJECTED") {
    const {d,step,attempt}=activeAttempt(s,p,{terminalAllowed:true});
    const receipt=p.receipt,binding=s.bindings[d.targetId];
    const prior=Object.values(s.dispatches).find(row=>row.dispatchId===receipt?.checkpointDispatchId);
    const unstartedStop=receipt?.kind==="codex-stop-before-native-turn"&&s.stop&&d.stop?.kind==="user"&&
      Number.isInteger(receipt.hostTurnId)&&Number.isInteger(receipt.hostTerminalSeq)&&receipt.hostTerminalSeq>d.receipt?.eventSeq&&
      prior?.targetId===d.targetId&&prior.turn?.threadId===receipt.threadId&&prior.turn?.turnId===receipt.checkpointTurnId&&
      prior.terminal?.receipt?.threadId===receipt.threadId&&prior.terminal?.receipt?.turnId===receipt.checkpointTurnId&&
      prior.terminal?.receipt?.status===receipt.checkpointStatus&&prior.terminal?.at<=d.issuedAt;
    const rejectedBinding = receipt?.kind === "codex-binding-refused" && !s.stop && !d.stop &&
      receipt.errorCode === "LOCAL_AGENT_FAILED" && receipt.error === bindingRefusal &&
      receipt.hostMessageSeq === d.receipt?.eventSeq && Number.isInteger(receipt.hostMessageSeq) &&
      Number.isInteger(receipt.hostTurnId) && Number.isInteger(receipt.hostTerminalSeq) &&
      receipt.hostTerminalSeq > receipt.hostMessageSeq && binding?.threadId === receipt.threadId;
    need(!d.turn&&!d.stop?.turnId&&!closed(s)&&d.receipt&&(receipt?.kind==="codex-resume-active-writer"||rejectedBinding||unstartedStop)&&
      receipt.sessionId===d.receipt.sessionId&&receipt.messageId===d.receipt.messageId&&
      receipt.sessionId===binding?.sessionId&&(!binding.threadId||binding.threadId===receipt.threadId)&&
      /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(receipt.threadId)&&p.terminalId,
      "START_REJECTION_MISMATCH","启动拒绝证据与原派单不匹配");
    need(["sending","unknown","delivered"].includes(d.status)&&!terminal(attempt.status),
      "DELIVERY_STATE","只有未启动的原派单可以结算启动拒绝");
    const status=s.stop?"cancelled":"failed";
    d.status="terminal";d.terminal={status,terminalId:p.terminalId,receipt:copy(receipt),at:event.at};
    attempt.status=status;attempt.terminalId=p.terminalId;attempt.stopVerified=true;step.status=status;
    s.status=s.stop?"stopped":"pending-review";
    s.missing=s.stop?[]:[rejectedBinding
      ? "原会话绑定失败，此棒没有启动，已有交接保留，等待复核"
      : "Codex 会话占用，原回合未启动；空闲后可继续原任务"];
    return s;
  }
  if(event.type==="TURN_ENDED") {
    const {d,step,attempt}=activeAttempt(s,p,{terminalAllowed:true});
    if(terminal(attempt.status)){need(attempt.terminalId===p.terminalId,"TERMINAL_CONFLICT","终态回执冲突");return s;}
    need(["succeeded","failed","cancelled"].includes(p.status),"INVALID_TERMINAL","终态非法");
    need(d.turn&&p.turnId===d.turn.turnId&&p.sessionId===d.turn.sessionId,"TURN_MISMATCH","终态不属于目标回合");
    need(p.terminalId,"MISSING_TERMINAL","终态缺少回执 ID");
    d.status="terminal";d.terminal={...copy(p),at:event.at};attempt.status=p.status;attempt.terminalId=p.terminalId;
    attempt.stopVerified=true;attempt.outputRef=p.outputRef??null;step.status=p.status;
    if(closed(s))return s;
    if(s.status==="stopping"){s.status="stopped";return s;}
    s.status=p.status==="succeeded"?"pending":p.status==="cancelled"?"pending-review":"pending-review";
    if(p.status==="succeeded")for(const id of step.handoffIds) {
      const h=s.handoffs[id];if(h.acceptedDispatchId===d.dispatchId){h.status="resolved";h.resolvedAt=event.at;}
    }
    s.missing=p.missing??[];return s;
  }
  if(event.type==="UPSTREAM_VERIFIED") {
    const {d,attempt}=activeAttempt(s,p,{terminalAllowed:true});
    need(d.turn&&p.sessionId===d.turn.sessionId&&p.turnId===d.turn.turnId,"TURN_MISMATCH","核对的是其他回合");
    attempt.verification=copy(p);
    if(p.state==="unknown"){s.status="verifying";s.missing=["原宿主回合状态待核对"];}
    else if(p.state==="running"){if(!closed(s))s.status="running";}
    else if(p.state==="terminal"){need(terminal(attempt.status),"TERMINAL_NOT_SAVED","先保存匹配终态");attempt.stopVerified=true;}
    return s;
  }
  if(event.type==="WAITING") {
    need(!closed(s)&&s.status!=="stopping","TASK_CLOSED","任务已收口");s.status="pending-review";s.missing=[...p.reasons];return s;
  }
  if(event.type==="TARGET_STOP_REQUESTED") {
    const {d,attempt}=activeAttempt(s,p,{terminalAllowed:true});
    need(!d.stop?.turnId||d.stop.turnId===p.stop.turnId,"TURN_MISMATCH","停止请求不可更换原上游回合");
    if(d.stop?.state==="confirmed"&&p.stop.state!=="confirmed")return s;
    if(p.stop.state==="confirmed"){
      need(p.stop.receipt&&(!p.stop.threadId||p.stop.threadId===p.stop.receipt.threadId&&p.stop.turnId===p.stop.receipt.turnId),"STOP_RECEIPT_MISMATCH","停止回执与原回合不匹配");
    }
    d.stop=copy(p.stop);
    if(!closed(s)&&s.status!=="stopping"){s.status="verifying";s.missing=[p.stop.state==="confirmed"?"原回合终态已确认，正在结算":"正在停止：等待原宿主回合回执"];}
    return s;
  }
  if(event.type==="USER_STOPPED") {
    if(s.status==="stopped")return s;
    need(s.status!=="completed","TASK_COMPLETED","任务已完成");
    s.stop={eventId:event.id,at:event.at,reason:p.reason??"用户主动停止"};
    const live=Object.values(s.dispatches).filter(d=>["sending","unknown","delivered","running"].includes(d.status));
    for(const d of Object.values(s.dispatches))if(d.status==="pending"){
      d.status="revoked";s.tickets[d.ticketId].events.push({kind:"revoked",eventId:event.id,at:event.at});
      s.steps[d.stepId].attempts[d.attemptId].status="cancelled";s.steps[d.stepId].status="cancelled";
    }
    s.status=live.length?"stopping":"stopped";s.missing=live.length?["正在停止：等待原回合终态回执"]:[];return s;
  }
  if(event.type==="ORDERED_CHAT_ENDED") {
    need(s.roles.kind==="ordered-chat"&&!closed(s)&&!s.stop&&s.roles.order.length===s.order.length&&
      s.order.every((id,index)=>s.steps[id].targetId===s.roles.order[index]&&
        s.steps[id].status==="succeeded"&&s.steps[id].attempts[s.steps[id].currentAttemptId]?.outputRef),
      "CHAT_INCOMPLETE","仍有授权成员未完成接话");
    s.status="completed";s.missing=[];return s;
  }
  if(event.type==="TASK_COMPLETED") {
    need(completionReady(s),"NOT_COMPLETE","双方同版本签核、成功终态或待办清理尚不满足");
    need(p.versionId===s.versionId,"VERSION_MISMATCH","完成版本不一致");
    if(s.roles.delivererId&&s.manifests[s.versionId].evidence.some(ref=>ref.kind==="file")) need(p.delivery?.delivererId===s.roles.delivererId,"DELIVERER_MISMATCH","缺少指定交付人的文件回执");
    if(p.delivery) {
      const receipt=p.delivery;
      need(receipt.versionId===s.versionId&&receipt.reviewerId===s.roles.reviewer&&
        s.manifests[s.versionId].evidence.filter(ref=>ref.kind==="file").every(ref=>
          receipt.files?.some(file=>file.sha256===ref.sha256&&file.cardId&&
            Object.values(s.dispatches).some(d=>d.runId===file.runId&&d.targetId===(s.roles.delivererId??receipt.reviewerId)&&(!s.roles.delivererId||s.steps[d.stepId]?.purpose==="final-delivery")&&d.terminal?.status==="succeeded"))),
        "DELIVERY_MISMATCH","终审文件卡片与签核版本或回合不匹配");
    }
    s.status="completed";
    s.completion={eventId:event.id,versionId:p.versionId,notificationId:p.notificationId,at:event.at};
    s.missing=[];return s;
  }
  throw new TransitionError("UNKNOWN_EVENT","不支持的状态迁移："+event.type);
}
export function emptyRecord(taskId) {
  const state=emptyState(taskId);
  return {schemaVersion:SCHEMA_VERSION,taskId,revision:0,events:[],state,stateHash:digest(state)};
}
export function replay(events,taskId) {
  let state=emptyState(taskId),previous="";const seen=new Set();
  for(let i=0;i<events.length;i++){
    const e=events[i];need(e.seq===i+1,"EVENT_SEQUENCE","事件序号不连续");
    need(!seen.has(e.id),"EVENT_DUPLICATE","事件 ID 重复");seen.add(e.id);
    need(e.previousHash===previous,"EVENT_PREFIX","既有事件前缀被修改");
    const {hash,...raw}=e;need(hash===digest(raw),"EVENT_HASH","事件哈希不匹配");
    state=apply(state,e);previous=hash;
  }
  return state;
}
export function validateRecord(record) {
  need(record.schemaVersion===SCHEMA_VERSION,"SCHEMA_VERSION","任务数据格式不支持");
  need(record.revision===record.events.length,"REVISION_MISMATCH","任务修订号与事件数量不一致");
  const restored=replay(record.events,record.taskId);
  need(digest(restored)===record.stateHash&&canonical(restored)===canonical(record.state),"STATE_TAMPER","状态与事件重放结果不一致");
  return record;
}
export function append(record,events,{expectedRevision,expectedPrefix}={}) {
  validateRecord(record);
  need(expectedRevision===undefined||expectedRevision===record.revision,"STALE_REVISION","任务修订号已变化");
  need(expectedPrefix===undefined||expectedPrefix===(record.events.at(-1)?.hash??""),"EVENT_PREFIX","既有事件前缀不匹配");
  let r=copy(record);
  for(const input of events){
    if(r.events.some(e=>e.id===input.id)){
      const old=r.events.find(e=>e.id===input.id);
      need(old.type===input.type&&canonical(old.payload)===canonical(input.payload),"EVENT_ID_CONFLICT","同一事件 ID 内容冲突");continue;
    }
    const e={...copy(input),taskId:r.taskId,seq:r.revision+1,previousHash:r.events.at(-1)?.hash??""};
    r.state=apply(r.state,e);e.hash=digest(e);r.events.push(e);r.revision++;r.stateHash=digest(r.state);
  }
  return validateRecord(r);
}
