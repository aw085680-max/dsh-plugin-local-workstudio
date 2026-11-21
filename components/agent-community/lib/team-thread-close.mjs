import {isChatRun} from "./team-chat-routing.mjs";
const now=()=>new Date().toISOString();
export class ThreadCloser {
 constructor(team){this.team=team;this.svc=team.svc;}
 isAdmin(botId,roomId){
  const room=this.svc.getRoom(roomId);
  if(!room?.memberIds.includes(botId))return false;
  return this.svc.leaderOfRoom(roomId)===botId;
 }
 closure(roomId,taskId){
  if(!taskId)return undefined;
  const direct=this.svc.getRoom(roomId)?.threadClosures?.[taskId];
  if(direct||!this.team.opened)return direct;
  const state=this.team.store.get(taskId)?.state;
  return state?.roomId===roomId&&state.roles.assignment?this.team.assignments.closed(roomId,state.roles.assignment.batchTaskId):undefined;
 }
 taskIds(roomId,batchTaskId){
  const goal=this.svc.state.messages.find(row=>row.roomId===roomId&&row.taskRef===batchTaskId&&row.memberAssignments?.length);
  return goal?goal.memberAssignments.map(row=>row.taskId):[batchTaskId];
 }
 finished(roomId,taskId){
  return this.taskIds(roomId,taskId).every(id=>{
   const record=this.team.store.get(id);
   return !record||["completed","stopped"].includes(record.state.status)||record.state.roles.assignment&&!!this.team.assignments.reply(record);
  });
 }
 async prepare(room,message,input){
  this.team.assert();
  if(message.mentions.length!==1||!this.isAdmin(message.mentions[0],room.id))
   throw Error("请点名本群队长来结束这件事。");
  const adminId=message.mentions[0];
  const referenced=!!(input.replyTo||input.threadId||input.taskId||input.continueTaskId);
  let candidates=this.team.taskCandidates(room.id,input);
  if(!referenced){
   const current=this.team.store.get(room.teamCurrentRequest?.taskId);
   if(current)candidates=[current];
  }
  if(candidates.length!==1)throw Error(candidates.length?"请回复要结束的那条任务消息，再点名本群队长。":"没有找到要结束的任务，请回复原消息。");
  const record=candidates[0];
  const taskId=record.state.roles.assignment?.batchTaskId??record.taskId;
  message.taskRef=taskId;
  message.closeRequest={taskId,adminId,state:"pending",requestedAt:message.createdAt};
  this.team.chat.prepare(room,message,{ids:[adminId],remainder:message.text},[adminId],undefined,{intent:"chat"},false);
  await this.team.persistMessage(message);
  await this.team.chat.schedule(message);
  return message;
 }
 register(agentCtx,roomId,botId){
  if(!this.isAdmin(botId,roomId))return;
  const tools=agentCtx.tools;
  if(!tools||typeof tools.register!=="function")throw Error("群任务结束工具未能加载");
  tools.register({
   name:"agent_community_close_thread",
   description:"End only the task in the user's current explicit request to end a task, addressed to the room leader. Call this tool before claiming it is ended. No parameters and no other task can be selected.",
   parameters:{type:"object",additionalProperties:false,properties:{},required:[]},
   output:{schema:{type:"object",additionalProperties:true},
    render:(_args,value)=>[{type:"text",text:JSON.stringify(value)}]},
   execute:async(_args,exec)=>{
    const sessionId=exec?.agent?.session?.id;
    const active=this.svc.state.runs.filter(run=>run.roomId===roomId&&run.botId===botId&&
     isChatRun(run)&&run.status==="running"&&run.sessionId===sessionId);
    if(active.length!==1)throw Error("没有本次结束请求的宿主身份");
    return this.execute(active[0]);
   }
  });
 }
 async execute(run){
  return this.svc.roomMessageMutex.run(run.roomId,async()=>{
   const message=this.team.chat.messageFor(run),request=message?.closeRequest;
   if(!this.isAdmin(run.botId,run.roomId)||request?.adminId!==run.botId||!this.team.chat.canClaim(run)||
    message.authorizationSnapshot?.messageId!==message.id||
    message.mentions.length!==1||message.mentions[0]!==run.botId)throw Error("本回合没有结束任务的授权");
   const record=this.team.store.get(request.taskId);
   if(!record||record.state.roomId!==run.roomId)throw Error("本次任务不在当前群里");
   const previous=this.closure(run.roomId,request.taskId);
   if(previous&&previous.requestId!==message.id)throw Error("这件事已由另一条消息结束");
   this.svc.patchRoom(run.roomId,room=>({...room,threadClosures:{...room.threadClosures,
    [record.taskId]:previous??{taskId:record.taskId,requestId:message.id,adminId:run.botId,runId:run.id,at:now()}}}));
   await this.svc.flushNow();
   await this.enforce(run.roomId,record.taskId,message.id);
   const state=this.finished(run.roomId,record.taskId)?"closed":"stopping";
   await this.updateMessage(message.id,state);
   return {ok:true,taskId:record.taskId,status:state,
    message:state==="closed"?"这件事已结束。":"已关闭这件事，正在等原回合停下来。不会再发旧回复。"};
  });
 }
 async enforce(roomId,taskId,requestId){
  for(const id of this.taskIds(roomId,taskId)){
   const record=this.team.store.get(id);
   if(record&&!["completed","stopped"].includes(record.state.status)&&
      !(record.state.roles.assignment&&this.team.assignments.reply(record)))
    await this.team.stop(id,"用户点名群队长结束任务："+requestId);
  }
  for(const message of this.svc.state.messages.filter(row=>row.roomId===roomId&&row.id!==requestId&&row.taskRef===taskId&&row.chatPlan&&!row.chatPlan.closedAt))
   await this.team.chat.updatePlan(message,{closedAt:now(),closedReason:"thread-ended"});
  for(const run of this.svc.state.runs.filter(row=>row.roomId===roomId&&row.originMessageId!==requestId&&
    isChatRun(row)&&row.taskRef===taskId)){
   if(run.status==="queued")await this.svc.controlRun({id:run.id,action:"cancel",expectedRevision:run.controlRevision});
   else if(run.status==="running"&&!run.stop)await this.svc.executor?.requestRunStop(run,{kind:"user",action:"cancel"});
  }
  await this.svc.flushNow();
 }
 async updateMessage(messageId,state){
  this.svc.state={...this.svc.state,messages:this.svc.state.messages.map(row=>row.id===messageId?
   {...row,closeRequest:{...row.closeRequest,state,handledAt:now()}}:row)};
  await this.svc.flushNow();
 }
 async recover(){
  for(const room of this.svc.state.rooms){
   for(const closure of Object.values(room.threadClosures??{})){
    const record=this.team.store.get(closure.taskId);
    if(!record)continue;
    if(!this.finished(room.id,closure.taskId))await this.enforce(room.id,closure.taskId,closure.requestId);
    if(this.finished(room.id,closure.taskId)){
     const message=this.svc.state.messages.find(row=>row.id===closure.requestId);
     if(message?.closeRequest?.state!=="closed")await this.updateMessage(closure.requestId,"closed");
    }
   }
  }
 }
 feedback(room){
  return this.svc.state.messages.filter(row=>row.roomId===room.id&&row.sender.kind==="user").flatMap(message=>{
   const plan=message.chatPlan;
   const recovered=message.followupRetry;
   const task=recovered&&message.taskRef&&this.team.store.get(message.taskRef);
   const receipt=message.followupReceipt??(task&&recovered?this.team.review.feedback(task):null);
   if(!(recovered||receipt||plan?.reason||plan?.statusReceipt||message.requestError||message.closeRequest))return [];
   return [{messageId:message.id,...(recovered?{recoveredRunId:recovered.runId}:{}),...(receipt?{receipt}:{}),...(plan?.reason||message.requestError)?{reason:plan?.reason??message.requestError}:{},
    ...plan?.statusReceipt?{receipt:plan.statusReceipt}:{},...message.closeRequest?{close:message.closeRequest}:{}}];
  });
 }
 async retryMessage(room,input){
  const message=this.svc.state.messages.find(row=>row.id===input.messageId&&row.roomId===room.id&&row.sender.kind==="user");
  const run=this.svc.state.runs.find(row=>row.id===input.runId&&row.roomId===room.id&&row.originMessageId===message?.id);
  if(!message||!run||run.status!=="failed"||run.controlRevision!==input.expectedRevision)
   throw Error("这条回复已更新，请看看最新消息。");
  if(run.stop&&run.stop.state!=="confirmed"||this.svc.executor?.active.has(run.id))
   throw Error("原回合还没有停稳，请稍后重试。");
  if(this.closure(room.id,run.teamTaskId??run.taskRef))throw Error("这件事已结束。");
  if(this.svc.state.messages.some(row=>row.runId===run.id&&row.sender.kind==="bot"))
   throw Error("这位成员已经回复，请看看原消息。");
  if(!isChatRun(run))return this.team.retry(run,false,{id:run.id,expectedRevision:input.expectedRevision});
  const corrected=await this.team.followup.retry(room,message,run);
  if(corrected)return corrected;
  if(!this.team.chat.canClaim(run))throw Error("原消息的点名已失效，请重新点名。");
  await this.team.originals.retryRun({id:run.id,expectedRevision:input.expectedRevision});
  this.svc.state={...this.svc.state,runs:this.svc.state.runs.map(row=>row.id===run.id?{
   ...row,stop:undefined,chatStart:undefined,startedAt:undefined,finishedAt:undefined,deadlineAt:undefined,
   lastProgressAt:undefined,error:undefined,lastError:undefined,failureKind:undefined,evidence:undefined,
   upstream:undefined,upstreamVerification:undefined,maxAttempts:row.attempt+1}:row)};
  await this.svc.flushNow();this.svc.executor?.nudge();
  return {ok:true,requestId:message.id,runId:run.id,status:"queued"};
 }
}
