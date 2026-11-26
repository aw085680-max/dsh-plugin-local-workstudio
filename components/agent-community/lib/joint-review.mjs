import {readFile} from "node:fs/promises";
import {apply} from "./team-machine.mjs";
import {fileSha256} from "./team-delivery.mjs";
import {managedGroup} from "./group-routing.mjs";

const escape = value => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
const separator = /[\n。！？!?；;]/u;

const artifactKind = /方案|执行稿|报告|文稿|稿件|终稿|计划书|计划|文档|手册|清单/u;
const reviewVerb = /复核|复审|审核|核查|核对|检查|审阅|过目|把关|看一遍|再看/u;

// Identify requests to review a work product independently of word order and handoff verbs.
export function documentReview(body) {
  const authored = body.replace(/“[^”]*”|「[^」]*」|『[^』]*』|\x60[^\x60]*\x60/gu, " ");
  for (const clause of authored.split(/[。！？!?；;\n]/u)) {
    const subject = clause.split(/[，,]/u).find(part => {
      if (!artifactKind.test(part) || !reviewVerb.test(part)) return false;
      const verb = part.search(reviewVerb), noun = part.search(artifactKind);
      return noun < verb || !/(?:给我一份|再出|出一份|新建|起草|编写|生成|拟定|制定)/u.test(part.slice(verb, noun));
    });
    if (!subject || /(?:复核|核查|审核|检查|核对)过|已经.{0,24}(?:过了|完成了|完了)|我记得|听他说/u.test(subject)) continue;
    if (/(?:不用|无需|不必|先别|不要|别再|不需要|是否|有没有|听说|曾经|假如|假设|例如|据说|如果|怎么样|怎么回事|过了吗|现在.{0,5}进度|能看到|能读到)/u.test(clause) || /[吗么呢]\s*$/u.test(clause)) continue;
    const name = subject.match(/《([^》]+)》/u)?.[1];
    const residual = (name ?? subject).replace(new RegExp(reviewVerb.source, "gu"), " ").replace(new RegExp(artifactKind.source, "gu"), " ")
      .replace(/你们|请你|麻烦|给我|现在|最后|一起|共同|分别|各自|重新|接着|再|一遍|一下|一次|优化|完善|上次|之前|前面|那份|这份|原来|最初|原先|那版|这版|已经|提交|交付|给|由|让|和|与|跟|把|的/gu, " ");
    return {clause, title:name, residual};
  }
}

// Only the user's action clause can appoint the pair. A quoted bot reply cannot delegate.
export function jointReviewPair(room,body,roster,eligible,addressed,ref) {
  if (!managedGroup(room) || /[“”「」『』"<>]/u.test(body) || addressed.length>2) return;
  const names=new Map();
  for (const bot of roster.filter(b=>eligible.includes(b.id))) {
    for (const name of new Set([bot.name,bot.name.split(/--|——/u).at(-1).trim()])) {
      if (name) names.set(name,names.has(name)?null:bot.id);
    }
  }
  const otherNames=[...names].filter(([,id])=>id).map(([name])=>escape(name)).sort((a,b)=>b.length-a.length);
  if (!otherNames.length) return;
  const namesRx=otherNames.join("|");
  const resolve=name=>name==="你"?(addressed.length===1?addressed[0]:ref?.sender?.botId):names.get(name);
  const pattern=new RegExp("^(?:那就|那|请|麻烦)?\\s*(你|"+namesRx+")\\s*(?:和|与|跟|同)\\s*("+namesRx+")\\s*(?:你们)?(?:一起|共同|分别|各自|都)?\\s*(?:重新|再|在)?\\s*(?:复核|复审|审核|核对|检查)\\s*(?:一遍|一次|一下|这份(?:附件|终稿|方案)|这版(?:方案|稿件)?)?[吧啊。！!\\s]*$","u");
  const artifact=documentReview(body);
  if (artifact) {
    const appointed=artifact.clause.match(new RegExp("(你|"+namesRx+")\\s*(?:和|与|跟|同)\\s*("+namesRx+")","u"));
    if (appointed) {
      const pair=[resolve(appointed[1]),resolve(appointed[2])];
      if(pair[0]!==pair[1] && pair.every(id=>eligible.includes(id)) && addressed.every(id=>pair.includes(id)))return pair;
    }
  }
  for(const clause of body.split(separator)) {
    const match=clause.trim().match(pattern);
    if(!match)continue;
    const pair=[resolve(match[1]),resolve(match[2])];
    if(pair.every(id=>eligible.includes(id))&&pair[0]!==pair[1]&&addressed.every(id=>pair.includes(id)))return pair;
  }
}

export async function matchedReview(team,message,reference) {
  const pair=message.routeDecision.jointMembers;
  let records=team.store.list().filter(({state:s})=>s.roomId===message.roomId && s.roles.unattended &&
    s.roles.confirmers?.length===2 && pair.every(id=>s.roles.confirmers.includes(id)));
  const recorded=records.find(r=>r.state.authSnapshots[message.id]?.jointReview);
  if(recorded)return recorded;
  records=records.filter(({state:s})=>s.status==="completed" && s.completion?.versionId===s.versionId);
  if(reference?.taskRef)records=records.filter(r=>r.taskId===reference.taskRef);
  if(message.attachments?.length) {
    if(message.attachments.length!==1)return;
    const hash=fileSha256(await readFile(message.attachments[0].path));
    records=records.filter(({state:s})=>s.manifests[s.versionId]?.bodyHash===hash);
  }
  const subject=message.routeDecision?.documentReview;
  if(subject && !message.attachments?.length) {
    let residual=subject.residual;
    for(const bot of team.svc.state.bots) for(const name of [bot.name,bot.name.split(/--|——/u).at(-1)]) if(name) residual=residual.split(name).join(" ");
    const terms=residual.match(/[\p{Script=Han}]{2,}|[A-Za-z0-9][A-Za-z0-9_-]{2,}/gu)??[];
    if(terms.length || subject.title) {
      const matched=[];
      for(const record of records) {
        const s=record.state,goal=JSON.parse((await team.store.readBlob(s.goalRef)).toString());
        const manifest=s.manifests[s.versionId],heading=(await team.store.readBlob(manifest.bodyRef)).toString().split(/\r?\n/u).find(line=>line.trim())??"";
        const labels=[heading,goal.text,...(s.artifactRefs[s.versionId]??[]).map(ref=>ref.name??"")].join("\n");
        if(subject.title ? labels.includes(subject.title) : terms.some(term=>labels.includes(term))) matched.push(record);
      }
      records=matched;
    }
  }
  return records.length===1?records[0]:undefined;
}

export async function beginJointReview(team,room,message,record,previousReply,reviewerReply) {
  return team.serial(record.taskId,async()=>{
    const r=team.store.get(record.taskId),s=r.state,pair=message.routeDecision.jointMembers;
    if(room.paused || !pair.every(id=>team.currentMembers(room.id).includes(id)))throw Error("复核成员或群状态已变化");
    const prior=s.authSnapshots[message.id];
    if(!prior && (s.status!=="completed" || s.versionId!==record.state.versionId))throw Error("待复核版本已变化");
    const basis=prior?.jointReview??{versionId:s.versionId,...(previousReply?{previousReplyId:previousReply.id,fromRunId:previousReply.runId}: {}),...(reviewerReply?{reviewerReplyId:reviewerReply.id,reviewerRunId:reviewerReply.runId}:{})};
    const updated={...message,taskRef:r.taskId,mentionTask:r.taskId,runtime:"task",authorizationSnapshot:{...message.authorizationSnapshot,members:pair}};
    delete updated.chatPlan;
    if(!prior) {
      const target=previousReply&&!reviewerReply?pair[1]:pair[0];
      const packet={manifest:s.manifests[s.versionId],refs:s.artifactRefs[s.versionId],targetId:target};
      const authorization={...updated.authorizationSnapshot,jointReview:basis,reviewResume:packet};
      const event=team.events("USER_AUTHORIZED",{authorization,messageRef:await team.store.putBlob(updated)},"joint-review:"+message.id);
      const next=apply(s,{...event,taskId:r.taskId});
      const plan=await team.buildPlan(next,target,[],{purpose:"return-review"});
      await team.commit(r.taskId,[event,...plan.events],r.revision);
    }
    const index=team.svc.state.messages.findIndex(m=>m.roomId===room.id&&m.id===message.id);
    if(index>=0)team.svc.state={...team.svc.state,messages:team.svc.state.messages.map((m,i)=>i===index?updated:m)};
    await team.persistMessage(updated);
    team.setCurrentRequest(room.id,message.id,team.store.get(r.taskId));
    await team.svc.flushNow();team.svc.executor?.nudge();
    return updated;
  });
}

