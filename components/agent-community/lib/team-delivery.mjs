import {createHash} from "node:crypto";
import {readFile,writeFile,mkdir} from "node:fs/promises";
import {basename,join} from "node:path";
import {digest,manifestOf,signatureVerified} from "./team-machine.mjs";

export const fileSha256 = bytes => createHash("sha256").update(bytes).digest("hex");

export function finalFileRefs(state) {
  const refs=state.artifactRefs[state.versionId]??[];
  const files=new Map();
  for(const evidence of state.manifests[state.versionId]?.evidence??[]) {
    if(evidence.kind!=="file")continue;
    const matching=refs.filter(ref=>ref.kind==="file"&&ref.sha256===evidence.sha256);
    const ref=matching.find(ref=>ref.sourceBotId===state.roles.reviewer)??matching[0];
    if(ref)files.set(evidence.sha256,ref);
  }
  return [...files.values()];
}

export function requiresFinalDelivery(state) {
  return state.manifests[state.versionId]?.evidence?.some(ref=>ref.kind==="file")===true;
}

export function hasFinalSignatures(state) {
  const ids=state.roles.confirmers??[];
  return !!state.versionId&&ids.length===2&&ids.every(id=>signatureVerified(state,id));
}

export async function stageVersionFiles(store,state,root) {
  const staged=[],refs=finalFileRefs(state);
  const expected=new Set((state.manifests[state.versionId]?.evidence??[]).filter(ref=>ref.kind==="file").map(ref=>ref.sha256));
  if(refs.length!==expected.size)throw Error("签核版本中的文件证据不齐，无法准备交稿");
  for(const ref of refs) {
    const bytes=await store.readBlob(ref);
    const name=basename(ref.name??"成果文件");
    const path=join(root,state.versionId,ref.sha256,name);
    await mkdir(join(root,state.versionId,ref.sha256),{recursive:true});
    try { await writeFile(path,bytes,{flag:"wx"}); }
    catch(error) { if(error.code!=="EEXIST")throw error; }
    if(fileSha256(await readFile(path))!==ref.sha256)throw Error("交稿文件 SHA-256 不一致，请检查签核版本");
    staged.push({id:ref.id,name,path,size:bytes.length,sha256:ref.sha256,teamVersion:state.versionId,teamTaskId:state.taskId,roundId:state.activeAuthorizationId});
  }
  return staged;
}

async function readVerifiedLegacyFile(ref,handoffs,store) {
  const paths=new Set([ref.path,ref.targetPath,ref.sourcePath]);
  for(const h of handoffs)for(const file of h.files??[])if(file.sha256===ref.sha256) {
    paths.add(file.targetPath);paths.add(file.sourcePath);
  }
  for(const path of paths)if(path) {
    let bytes;
    try { bytes=await readFile(path); } catch { continue; }
    if(fileSha256(bytes)===ref.sha256)return {...await store.putBlob(bytes,"file"),name:basename(ref.name??path)};
  }
  throw Error("找不到与原 SHA-256 一致的文件「"+(ref.name??"旧证据")+"」");
}

// Only historical records stopped with an unconsumed authorized handoff are eligible.
export function isLegacyCap(source,state) {
  const relay=source?.relay;
  if(relay?.status!=="completed"||relay.steps?.length!==4||
    !relay.steps.every(step=>step.status==="completed")||state.stop||!state.history?.canResume)return false;
  const authorized=state.authSnapshots[state.activeAuthorizationId]?.members??[];
  return source.handoffs?.some(handoff=>["pending","offered","interrupted"].includes(handoff.state)&&
    handoff.fromRelayStep===relay.currentIndex&&relay.members?.includes(handoff.toBotId)&&authorized.includes(handoff.toBotId));
}

export async function recoverLegacyCap(source,state,store,service) {
  const {relay}=source,handoffs=source.handoffs??[],handoffRefs={};
  for(const h of handoffs)if(state.handoffs[h.id]?.status==="pending") {
    handoffRefs[h.id]=await Promise.all((h.files??[]).map(ref=>readVerifiedLegacyFile(ref,handoffs,store)));
  }
  const recovery={kind:"legacy-cap",handoffRefs};
  const signed=relay.consensus;
  if(!signed?.version||!signed.confirmations?.length)return recovery;
  const oldManifest={body:signed.body,evidence:signed.evidence};
  if(!Array.isArray(signed.evidence)||fileSha256(Buffer.from(JSON.stringify(oldManifest)))!==signed.version)
    throw Error("原签核版本的正文与证据清单无法校验");
  const checkRun=confirmation=>(source.runs??[]).find(run=>run.id===confirmation.runId&&
    run.botId===confirmation.botId&&run.roomId===state.roomId&&run.mentionTask===state.taskId&&run.status==="completed");
  const approved=signed.confirmations.filter(c=>c.version===signed.version&&
    (state.roles.confirmers??[]).includes(c.botId)&&checkRun(c));
  if(!approved.length)throw Error("原确认回合缺少身份匹配的成功终态");
  async function readRef(ref) {
    if(ref.kind==="file")return readVerifiedLegacyFile(ref,handoffs,store);
    const record=ref.kind==="message"?service.state.messages.find(m=>m.id===ref.messageId&&m.roomId===state.roomId):
      ref.kind==="task"?service.finishGateBoard(state.roomId).find(t=>(t.id??t.assignmentId)===ref.taskId):null;
    if(!record)throw Error("缺少旧任务签核引用的证据记录");
    const bytes=Buffer.from(JSON.stringify(record));
    if(fileSha256(bytes)!==ref.sha256)throw Error("旧任务签核证据的 SHA-256 不一致");
    return store.putBlob(bytes,ref.kind);
  }
  const refs=await Promise.all((signed.refs??[]).map(readRef));
  const body=String(signed.body).normalize("NFC").replace(/\r\n?/g,"\n").trim();
  const manifest=manifestOf(body,refs);
  manifest.bodyRef=await store.putBlob(body,"text");
  const confirmations={};
  for(const confirmation of approved) {
    const verified=await Promise.all((confirmation.refs??[]).map(readRef));
    if(digest(verified.map(ref=>ref.sha256).sort())!==digest(refs.map(ref=>ref.sha256).sort()))
      throw Error("旧签核回执的证据与成果版本不一致");
    confirmations[confirmation.botId]={botId:confirmation.botId,versionId:manifest.versionId,
      at:confirmation.at,legacyReceipt:{runId:confirmation.runId,version:signed.version,terminalStatus:"completed"}};
  }
  return {...recovery,manifest,refs,confirmations};
}
