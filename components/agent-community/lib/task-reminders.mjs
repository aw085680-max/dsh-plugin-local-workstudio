import {desktopDeliveryPath} from "./desktop-delivery-path.mjs";
import {createHash, randomUUID} from "node:crypto";
import {mkdir, readFile, readdir, realpath, rename, stat, unlink, writeFile} from "node:fs/promises";
import {isAbsolute, join} from "node:path";
import {WindowsReminders} from "./windows-reminders.mjs";
import {hasFinalSignatures, requiresFinalDelivery, fileSha256} from "./team-delivery.mjs";

const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const now = () => new Date().toISOString();
const missing = error => error?.code === "ENOENT";
const terminal = state => ["completed", "stopped"].includes(state.status);
async function writeJson(path, value) {
  const temporary = path + "." + randomUUID() + ".tmp";
  try {
    await writeFile(temporary, JSON.stringify(value), {flag:"wx",mode:0o600});
    await rename(temporary, path);
  } finally { await unlink(temporary).catch(error => { if (!missing(error)) throw error; }); }
}
export function requestsFile(goal) {
  const text = String(goal?.text ?? "").replace(/(?:不(?:用|需要|必)|无需|不要)(?:再)?(?:生成|制作|提交|提供|交付|导出|输出)?(?:任何)?(?:文件|附件|文档)/gu,"");
  return goal?.requiresFile === true || /(?:交付|提交|提供|发给我|输出|导出|生成|制作|整理成|保存为|写成)(?:一[份个张])?(?:最终|正式|可下载的|实际的|对应的|可打开的|的|版|\s){0,8}(?:文件|附件|文档|表格|演示文稿|[Ww]ord|[Ee]xcel|[Pp][Dd][Ff]|[Pp][Pp][Tt]|[Dd][Oo][Cc][Xx]|[Xx][Ll][Ss][Xx])/u.test(text);
}

/** All destinations are resolved by the host. The renderer submits only event and artifact IDs. */
export class TaskReminders {
  constructor(team, {native, clock=now} = {}) {
    this.team=team; this.svc=team.svc; this.clock=clock;
    this.root=join(this.svc.home,"agent-community","task-reminders");
    this.bindingPath=join(this.root,"native-binding.json");
    this.bridge=new WindowsReminders(this.bindingPath);
    this.native=native??((op,args)=>this.bridge.call(op,args));
    this.displayPaths=new Map();
    this.retry=new Set();
    this.tail=Promise.resolve(); this.projected=new Map(); this.closed=false; this.interactive=false;
  }
  serial(action) {
    const result=this.tail.then(action);
    this.tail=result.catch(()=>{});
    return result;
  }
  async open() {
    for(const path of ["","tickets","clicks"]) await mkdir(join(this.root,path),{recursive:true,mode:0o700});
    const home=await realpath(this.svc.home);
    this.workspaceId=digest([process.platform==="win32"?home.toLowerCase():home,"agent-community"]);
    this.path=join(this.root,"records.json");
    try { this.data=JSON.parse(await readFile(this.path,"utf8")); }
    catch(error) {
      if (!missing(error)) throw error;
      this.data={schema:1,workspaceId:this.workspaceId,since:this.clock(),quiet:false,events:{},routes:[]};
      await this.save();
    }
    if(this.data.schema!==1||this.data.workspaceId!==this.workspaceId) throw Error("任务提醒记录与当前工作区不符");
    if(process.platform==="win32"){
      try{
        const binding=JSON.parse(await readFile(this.bindingPath,"utf8"));
        if(![binding.root,binding.host,binding.launcher].every(item=>typeof item==="string"&&isAbsolute(item)))
          throw Error("Windows 提醒绑定需要绝对路径");
        if(!/^com\.localworkstudio\.[a-f0-9]{16}$/u.test(binding.appId??"")||binding.protocol!=="dsh-workstudio-task-"+binding.appId.slice(-16))
          throw Error("无效的 Windows 提醒标识");
        const [registered,current,host,launcher]=await Promise.all(
          [binding.root,this.root,binding.host,binding.launcher].map(item=>realpath(item)));
        if(registered.toLowerCase()!==current.toLowerCase())throw Error("Windows 提醒绑定与当前数据目录不一致");
        if(!(await stat(host)).isFile()||!(await stat(launcher)).isFile())throw Error("Windows 提醒启动文件无效");
        this.interactive=true;
      }catch(error){
        if(!missing(error))this.svc.ctx.logger?.warn?.("Windows 任务提醒绑定无效");
      }
    }
  }
  async save(){this.dirty=true;await writeJson(this.path,this.data);this.dirty=false;}
  forRoom(id) {
    const events = Object.values(this.data?.events ?? {}).filter(e => e.roomId === id && e.kind !== "waiting");
    const visible = events.sort((a,b)=>b.at.localeCompare(a.at)).map(e => this.publicEvent(e));
    if (!visible.length) return visible;
    const sources = new Map(this.svc.state.messages.filter(m => m.roomId === id && m.sender.kind === "user").map(m => [m.id,m]));
    for (const event of visible) {
      const m = sources.get(event.messageId);
      if (event.kind !== "done" || !m) continue;
      event.originEntry = {type:"user", id:m.id, messageId:m.id, roomId:id, text:m.text, at:m.createdAt, sequence:m.sequence,
        senderName:m.sender.name, replyTo:m.replyTo, attachments:m.attachments};
    }
    return visible;
  }
  async recordLoad(marker){await writeJson(join(this.root,"host-load.json"),{...marker,workspaceId:this.workspaceId,writer:this.team.store.lock.info(),nativeBindingActive:this.interactive,ready:true});}
  async observe(record,options){try{await this.project(record,options);}catch(error){this.retry.add(record.taskId);this.svc.ctx.logger?.warn?.("任务提醒待恢复："+error.message);}}
  stoppedLabel(s){return s?.status==="stopped"&&(s.roles.reviewProtocol===2||Object.values(s.authSnapshots??{}).some(a=>a.reviewOffer))?"本轮任务已停止。":"本轮任务已结束。";}
  async updatePin(record){
    const s=record.state,pins=Object.values(this.data.pins??{}).filter(p=>p.taskId===(s.roles.assignment?.batchTaskId??s.taskId)&&p.roomId===s.roomId);
    for(const pin of pins){const text=terminal(s)?this.stoppedLabel(s):this.team.statusView(s).missing?.[0]??({running:"任务进行中",delivered:"成员已收件",pending:"等待接棒",stopping:"正在结束本轮任务"}[s.status]??"正在核对任务进度");if(pin.text!==text){pin.text=text;await this.save();}}
  }
  start(){
    this.timer=setInterval(()=>this.tick().catch(error=>this.svc.ctx.logger?.warn?.("任务桌面提醒："+error.message)),1500);
    this.timer.unref?.();
  }
  async close(){this.closed=true;clearInterval(this.timer);await this.tail;this.bridge.close();}
  async verifiedFiles(record, receipt, {signed=true}={}) {
    const s=record.state, files=[];
    for(const item of receipt?.files??[]) {
      const row=this.svc.ledger.listLedger(s.roomId,{force:true,limit:Number.MAX_SAFE_INTEGER})
        .find(r=>r.id===item.cardId&&r.type==="deliverable"&&r.runId===item.runId);
      const file=row?.files?.find(f=>f.name===item.name&&(!f.sha256||f.sha256===item.sha256));
      if(!file||row.botId!==(s.roles.delivererId??s.roles.reviewer))return null;
      const known=(s.artifactRefs?.[s.versionId]??[]).filter(f=>f.kind==="file"&&f.sha256===item.sha256);
      // Older declarations may only have the verified, versioned delivery path.
      const path=s.roles.unattended?file.path:file.deliveryOriginalPath??file.path;
      let bytes;
      try{bytes=await readFile(path);}catch{return null;}
      const sha=fileSha256(bytes);
      if(sha!==item.sha256||signed&&!known.some(f=>f.sha256===sha))return null;
      files.push({id:digest([s.roomId,item.cardId,file.id??file.name,sha]),name:file.name,
        path,sha256:sha,size:bytes.length,runId:item.runId,cardId:item.cardId});
    }
    return files;
  }
  async assignmentFiles(records) {
    const files=[];
    for(const r of records){
      const run=this.team.assignments.reply(r)?.runId;
      if(!run)continue;
      const rows=this.svc.ledger.listLedger(r.state.roomId,{force:true,limit:Number.MAX_SAFE_INTEGER});
      for(const row of rows.filter(row=>row.type==="deliverable"&&row.runId===run)){
        for(const f of row.files??[]){
          const path=f.deliveryOriginalPath??f.path;
          let bytes;try{bytes=await readFile(path);}catch{return null;}
          const sha=fileSha256(bytes);
          if(f.sha256&&f.sha256!==sha)return null;
          if(!files.some(file=>file.path===path&&file.sha256===sha))files.push({id:digest([row.id,path,sha]),name:f.name,path,sha256:sha,size:bytes.length,runId:run,cardId:row.id});
        }
      }
    }
    return files;
  }
  async describe(record) {
    const s=record.state, raw=record.events??[], origin=s.activeAuthorizationId;
    const goal=this.team.goalCache.get(s.taskId);
    const last=raw.at(-1);
    if(!last||s.history&&!raw.some(e=>!["HISTORY_IMPORTED","TASK_CREATED","PERMISSIONS_OBSERVED"].includes(e.type)))return null;
    let taskId=s.taskId,roundId=s.authSnapshots[origin]?.jointReview?origin:s.roles.unattended?(goal?.id??origin):origin,status=s.status, kind, files=[], text, at, eventPart;
    if(s.roles.assignment) {
      const a=s.roles.assignment;
      taskId=a.batchTaskId; roundId=a.sourceMessageId;
      const message=this.svc.state.messages.find(m=>m.roomId===s.roomId&&m.id===roundId);
      if(!message?.memberAssignments?.length)return null;
      const records=message.memberAssignments.map(member=>this.team.store.get(member.taskId));
      if(records.some(r=>!r))return null;
      const closes=records.map(r=>this.team.assignments.reply(r));
      const stopped=records.some(r=>r.state.stop);
      if(!records.every((r,i)=>closes[i]||r.state.status==="stopped"))return null;
      const recorded=await this.assignmentFiles(records);
      if(!stopped&&(!recorded||(a.singleFile||requestsFile(message))&&!recorded.length)){kind="waiting";text="等待本轮最终交付文件。";}
      else {kind=stopped?"stopped":"done";files=recorded??[];}
      at=records.map(r=>r.events.at(-1)?.at??"").sort().at(-1);eventPart=kind;
    } else if(status==="stopped"&&s.stop){
      kind="stopped";eventPart=kind;at=raw.findLast(e=>["TURN_ENDED","USER_STOPPED","TURN_START_REJECTED","DELIVERY_ABSENT"].includes(e.type))?.at??s.stop.at;
      const prior=raw.findLast(e=>e.type==="TASK_COMPLETED"&&e.payload?.delivery);
      const receipt=prior?.payload.delivery??(s.versionId&&hasFinalSignatures(s)?await this.team.readFinalReceipt(s):null);
      if(receipt)files=await this.verifiedFiles(record,receipt)??[];
    } else if(s.roles.kind==="ordered-chat"){return null;}
    else if(status==="completed"&&s.completion&&hasFinalSignatures(s)){
      const complete=raw.findLast(e=>e.id===s.completion.eventId);
      if(!complete)return null;
      at=complete.at;files=await this.verifiedFiles(record,complete.payload.delivery);
      if(!files||(requiresFinalDelivery(s)||requestsFile(goal))&&!files.length){
        kind="waiting";text="等待核实本轮签核版本的最终交付文件。";eventPart="await-file:"+s.versionId;
      }else{kind="done";eventPart=kind;}
    } else if(status==="pending-review"){
      const pending=raw.findLast(e=>["WAITING","ARTIFACT_INVALIDATED","TURN_ENDED","TURN_START_REJECTED"].includes(e.type));
      if(!pending||!s.missing?.length)return null;
      at=pending.at;kind="waiting";text=s.missing.join("、");eventPart=pending.id;
    } else return null;
    if(!at)return null;
    if(s.roles.unattended&&kind==="done"){
      const body=(await this.team.store.readBlob(s.manifests[s.versionId].bodyRef)).toString("utf8");
      const reason=raw.findLast(e=>e.payload.targetId===s.roles.reviewer&&e.payload.reviewDecision?.action==="approve"&&e.payload.reviewDecision?.versionId===s.versionId)?.payload.reviewDecision.reason;
      text=body.replace(/^#+\s*/gmu,"").trim().slice(0,240)+(reason?"\n复核结论："+reason:"");
    }
    const key=digest([this.workspaceId,s.roomId,taskId,roundId,kind,eventPart]);
    const onOrigin=kind==="waiting" || s.roles.unattended || (s.roles.assignment?.singleFile && kind==="done");
    const messageId=onOrigin?roundId:"close-"+digest([this.workspaceId,s.roomId,taskId,roundId]);
    return {key,workspaceId:this.workspaceId,roomId:s.roomId,taskId,roundId,messageId,kind,at,versionId:s.versionId??null,
      roomName:this.svc.getRoom(s.roomId)?.name??"原群",title:(goal?.text??"群任务").slice(0,96),
      text:text??(kind==="stopped"?this.stoppedLabel(s)+"已按你的要求提前结束。":"本轮任务已结束。"),files:files??[]};
  }
  async project(record,{force=false}={}) {
    if(!this.data||!this.ledgerReady||this.closed)return;
    return this.serial(async()=>{
      const fresh=this.team.store.get(record.taskId)??record;
      if(!force&&this.projected.get(fresh.taskId)===fresh.revision)return;
      const s=fresh.state, taskId=s.roles.assignment?.batchTaskId??s.taskId;
      await this.updatePin(fresh);
      if(fresh.events.at(-1)?.at<this.data.since&&!Object.values(this.data.events).some(e=>e.taskId===taskId)){
        this.projected.set(fresh.taskId,fresh.revision);return;
      }
      const event=await this.describe(fresh);
      let changed=false;
      for(const row of Object.values(this.data.events)){
        if(row.roomId===s.roomId&&row.taskId===taskId&&row.kind==="waiting"&&row.effective&&row.key!==event?.key){
          row.effective=false;row.resolvedAt=this.clock();changed=true;
        }
      }
      if(event&&(event.at>=this.data.since||this.data.events[event.key])){
        const existing=this.data.events[event.key];
        if(!existing){
          await this.prepareDisplayPaths(event.files);
          if(event.kind!=="waiting" && event.messageId!==event.roundId){
            const admin=(this.svc.getRoom(s.roomId)?.memberIds??[]).find(id=>this.team.threadCloser.isAdmin(id,s.roomId));
            if(!s.roles.unattended){if(!admin)return;await this.publish(event,admin);}
          }
          this.data.events[event.key]={...event,effective:true,desktop:"pending",handled:null};
          await writeJson(join(this.root,"tickets",event.key+".json"),{key:event.key,workspaceId:event.workspaceId});
          changed=true;
        } else if (s.roles.assignment?.singleFile && event.kind==="done" && existing.messageId!==event.messageId &&
                   existing.taskId===event.taskId && existing.roundId===event.messageId &&
                   existing.messageId==="close-"+digest([this.workspaceId,s.roomId,event.taskId,event.roundId]) &&
                   existing.files.length===event.files.length && existing.files.every((f,i)=>f.id===event.files[i].id && f.sha256===event.files[i].sha256)) {
          // Relink the existing verified receipt. Keep its stable key and notification state.
          existing.messageId=event.messageId;
          changed=true;
        }
      }
      if(changed)await this.save();
      this.projected.set(fresh.taskId,fresh.revision);
    });
  }
  async publish(event,admin){
    const text=(event.kind==="stopped"?this.stoppedLabel(this.team.store.get(event.taskId)?.state):"本轮任务已结束。")+(event.kind==="stopped"?"\n已按你的要求提前结束。":"")+
      (event.files.length?"\n"+event.files.map(file=>file.name).join("、"):(event.kind==="stopped"?"本轮没有最终交付文件。":""));
    const message={id:event.messageId,roomId:event.roomId,runId:"notice-"+event.messageId,taskRef:event.taskId,
      sender:{kind:"bot",botId:admin,name:this.svc.getBot(admin).name},text,createdAt:event.at,mentions:[],
      sequence:this.svc.state.messages.reduce((n,m)=>m.roomId===event.roomId?Math.max(n,m.sequence??0):n,-1)+1,
      threadId:event.roundId,reminderKey:event.key,runtime:"task",presentation:"reply"};
    await this.team.persistMessage(message);
  }
  async prepareDisplayPaths(files) {
    for (const file of files) {
      try {
        const path = await desktopDeliveryPath(this.svc.home, file);
        if (path !== file.path) this.displayPaths.set(file.id, path);
      } catch (error) {
        this.svc.ctx.logger?.warn?.("成品仍可从原消息预览，短路径准备失败：" + error.message);
      }
    }
  }
  async recover(){
    for (const event of Object.values(this.data?.events ?? {})) await this.prepareDisplayPaths(event.files ?? []);
    this.ledgerReady=true;
    for(const record of this.team.store.list())await this.observe(record);
    this.start();
  }
  tick(){
    if(this.closed||this.ticking||!this.data)return Promise.resolve();
    this.ticking=true;
    for(const id of [...this.retry]){this.retry.delete(id);const r=this.team.store.get(id);if(r)void this.observe(r,{force:true});}
    return this.serial(async()=>{
      if(this.dirty)await this.save();
      await this.collectClicks();
      if(this.interactive)await this.collectFailures();
      if(!this.interactive||this.data.quiet)return;
      const rows=Object.values(this.data.events).filter(e=>e.effective&&!e.handled&&["pending","issuing"].includes(e.desktop));
      if(!rows.length)return;
      const eligible=rows.filter(e=>!e.retryAt||e.retryAt<=Date.now());
      if(!eligible.length)return;
      const state=await this.native("state");
      if(state.foreground||!state.enabled)return;
      for(const e of eligible){
        const recovering=e.desktop==="issuing";
        e.desktop="issuing";e.attemptAt=this.clock();await this.save();
        let result;
        try {result=await this.native("present",[e.key,e.roomName,e.kind==="waiting"?e.text:"任务提醒："+e.text,recovering?"recover":"normal"]);}
        catch(error){e.lastError=error.message.slice(0,200);e.retryAt=Date.now()+30000;await this.save();continue;}
        if(result.status==="foreground"||result.status==="disabled") {
          e.desktop=recovering?"issuing":"pending";
        }else if(["accepted","existing","recovered-silently"].includes(result.status)){
          e.desktop="delivered";e.nativeStatus=result.status;e.acceptedAt=this.clock();delete e.lastError;
        }else {e.lastError="Windows 未确认投递";e.retryAt=Date.now()+30000;}
        await this.save();
      }
    }).finally(()=>{this.ticking=false;});
  }
  async collectClicks(){
    const dir=join(this.root,"clicks");
    const files=(await readdir(dir)).filter(x=>/^[0-9]{18,19}-[a-f0-9]{32}\.json$/.test(x)).sort();
    for(const name of files){
      const path=join(dir,name);
      let request;try{request=JSON.parse(await readFile(path,"utf8"));}catch(error){if(missing(error))continue;throw error;}
      const event=this.data.events[request.key]??this.data.pins?.[request.key];
      if(event&&request.workspaceId===this.workspaceId){
        if(request.action==="open"&&!this.data.routes.some(r=>r.id===name)&&event.lastActivation!==name){
          this.data.routes.push({id:name,key:event.key});
        }else if(request.action==="dismiss"&&!event.handled){event.handled="dismissed";event.handledAt=this.clock();}
        await this.save();
      }
      await unlink(path).catch(error=>{if(!missing(error))throw error;});
    }
  }
  async collectFailures(){
    const dir=join(this.root,"native");let names;
    try{names=await readdir(dir);}catch(error){if(missing(error))return;throw error;}
    for(const name of names.filter(n=>/^[a-f0-9]{64}\.failed$/.test(n))){
      const e=this.data.events[name.slice(0,64)];if(!e)continue;
      e.desktop="failed";e.nativeError=(await readFile(join(dir,name),"utf8")).trim();
      delete e.acceptedAt;await this.save();await unlink(join(dir,name));
    }
  }
  publicEvent(e){
    const mark=this.svc.state.roomReadAt?.[e.roomId];
    return {key:e.key,workspaceId:e.workspaceId,roomId:e.roomId,taskId:e.taskId,roundId:e.roundId,messageId:e.messageId,versionId:e.versionId,
      roomName:e.roomName,title:e.title,kind:e.kind,text:e.text,at:e.at,effective:e.effective,desktop:e.desktop,handled:e.handled,
      read:!!mark&&(mark.id===e.messageId||!!mark.at&&mark.at>=e.at),
      files:e.files.map(({id,name,size,path,runId})=>({id,name,size,runId,path:this.displayPaths?.get(id)??path}))};
  }
  async request(input){
    return this.serial(async()=>{
      const op=input?.op;
      if(op==="poll")return {workspaceId:this.workspaceId,route:this.data.routes[0]??null};
      if(op==="list")return {quiet:this.data.quiet,events:Object.values(this.data.events).sort((a,b)=>b.at.localeCompare(a.at)).map(e=>this.publicEvent(e))};
      if(op==="quiet"){if(typeof input.value!=="boolean")throw Error("勿扰设置无效");this.data.quiet=input.value;await this.save();return {quiet:this.data.quiet};}
      if(op==="client-ready"){
        if(!["local-workstudio-v1.0.0-r20","local-workstudio-v1.1.0"].includes(input.build))throw Error("界面构建版本不符");
        await writeJson(join(this.root,"client-load.json"),{build:input.build,at:this.clock(),hostPid:process.pid,desktop:input.desktop===true,workspaceId:this.workspaceId});return {ready:true};
      }
      if(op==="forget-route"){this.data.routes=this.data.routes.filter(r=>r.id!==input.routeId||r.key!==input.key);await this.save();return {ok:true};}
      if(op==="pin-task"){
        if(!this.interactive)throw Error("当前宿主没有启用 Windows 任务小窗");
        const message=this.svc.state.messages.find(m=>m.id===input.messageId&&m.roomId===input.roomId&&m.sender.kind==="user");
        const record=message?.taskRef&&this.team.store.get(message.taskRef);
        if(!record||record.state.roomId!==input.roomId)throw Error("原消息尚未登记为群任务");
        const key=digest([this.workspaceId,input.roomId,input.messageId,"pin"]);
        this.data.pins??={};this.data.pins[key]??={key,workspaceId:this.workspaceId,taskId:record.taskId,roundId:message.id,messageId:message.id,roomId:input.roomId,roomName:this.svc.getRoom(input.roomId).name,kind:"pin",at:message.createdAt,text:"正在核对任务进度",title:"任务进度",files:[],effective:true};
        await this.updatePin(record);await this.save();await writeJson(join(this.root,"tickets",key+".json"),{key,workspaceId:this.workspaceId});await this.native("pin",[key]);return {ok:true};
      }
      const e=this.data.events[input.key]??this.data.pins?.[input.key];
      if(!e||e.workspaceId!==this.workspaceId||!this.svc.getRoom(e.roomId))throw Error("原群或任务提醒已不可用");
      if(op==="navigate"){
        const route={id:randomUUID(),key:e.key};this.data.routes.push(route);await this.save();return route;
      }
      if(op==="target"){
        const msg=this.svc.state.messages.find(m=>m.id===e.messageId&&m.roomId===e.roomId);
        if(!msg)throw Error("原消息已从群历史中移除");
        const rows=this.svc.listLedger(e.roomId,{force:true,limit:Number.MAX_SAFE_INTEGER});
        const index=rows.findIndex(row=>row.messageId===msg.id);
        const adjacent=index<0?[]:rows.slice(Math.max(0,index-5),index+6);
        if(index<0)adjacent.push({type:msg.sender.kind==="user"?"user":"bot-text",id:msg.id,messageId:msg.id,roomId:e.roomId,sequence:msg.sequence,at:msg.createdAt,text:msg.text,senderName:msg.sender.name,botId:msg.sender.botId,runId:msg.runId});
        return {event:this.publicEvent(e),rows:adjacent};
      }
      if(op==="handled"||op==="dismiss"){
        if(op==="handled"&&input.routeId){
          this.data.routes=this.data.routes.filter(r=>r.id!==input.routeId||r.key!==e.key);e.lastActivation=input.routeId;
        }
        e.handled=op==="dismiss"?"dismissed":"opened";e.handledAt=this.clock();await this.save();
        return {handled:e.handled};
      }
      if(op==="pin"){
        if(!this.interactive)throw Error("当前宿主没有启用 Windows 任务小窗");
        await this.native("pin",[e.key]);return {ok:true};
      }
      throw Error("未知的任务提醒操作");
    });
  }
  file(input){
    const e=this.data?.events[input.reminderKey];
    if(!e||e.roomId!==input.roomId||e.workspaceId!==this.workspaceId)return;
    return e.files.find(f=>f.id===input.fileId);
  }
}
