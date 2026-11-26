import {createUserMessage} from "@deepseek-ai/dsh-llm";
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
export class TeamSessionBridge {
  constructor(orchestrator){this.orchestrator=orchestrator;this.deliveries=new Map();this.bindings=new Map();this.terminals=new Map();}
  pending(runId){return this.deliveries.get(runId)??Promise.resolve();}
  events(session){return session.snapshotEvents().slice();}
  facts(session,dispatchId){
    const events=this.events(session),message=events.find(e=>e.type==="user/message"&&e.data?.source?.dispatchId===dispatchId);
    if(!message)return {message:null};
    // A turn/start can precede the user/message. Restrict it to the interval since the previous turn/end.
    const before=events.filter(e=>e.seq<message.seq&&e.type==="turn/start").at(-1);
    const closedBefore=before&&events.some(e=>e.type==="turn/end"&&e.seq>before.seq&&e.seq<message.seq&&e.data?.turn===before.data?.turn);
    const start=before&&!closedBefore?before:events.find(e=>e.type==="turn/start"&&e.seq>message.seq);
    const end=start&&events.find(e=>e.type==="turn/end"&&e.seq>start.seq&&e.data?.turn===start.data?.turn);
    return {message,start,end};
  }
  receipt(session,message){
    return {sessionId:String(session.id),rootSessionId:String(session.header.id),
      creationRelation:{kind:"native-agent-registry",parentSession:session.header.parentSession??null,origin:session.header.origin??null},
      messageId:String(message.data.id),eventSeq:message.seq,source:"session/flush"};
  }
  deliver({agent,runId,text}){
    if(this.deliveries.has(runId))return this.deliveries.get(runId);
    const promise=this.deliverOnce(agent,runId,text);this.deliveries.set(runId,promise);
    promise.catch(()=>{});return promise;
  }
  async deliverOnce(agent,runId,text){
    const run=this.orchestrator.svc.state.runs.find(r=>r.id===runId);if(!run?.teamTaskId)throw Error("缺少当前派单身份");
    this.orchestrator.assert();
    let facts=this.facts(agent.session,run.dispatchId);
    if(!facts.message){
      const message=await createUserMessage({content:[{type:"text",text}],source:{kind:"user",dispatchId:run.dispatchId,taskId:run.teamTaskId,stepId:run.teamStepId,attemptId:run.attemptId}});
      agent.followup(message);
      for(let i=0;i<600&&!facts.message;i++){await sleep(25);facts=this.facts(agent.session,run.dispatchId);}
    }
    if(!facts.message)throw Error("目标宿主尚未确认收件，保留原派单待核对");
    if(await agent.ctx.sessions.flush(agent.session)!==true)throw Error("宿主收件尚未持久化，保留待核对");
    const receipt=this.receipt(agent.session,facts.message);this.bindings.set(runId,receipt);
    await this.orchestrator.runtimeAccepted(runId,receipt);
    const codex=this.orchestrator.svc.contextRunnerOf(this.orchestrator.svc.getBot(run.botId))==="codex";
    if(!codex){
      for(let i=0;i<600&&!facts.start;i++){await sleep(25);facts=this.facts(agent.session,run.dispatchId);}
      if(!facts.start)throw Error("宿主已收件，目标回合尚未开始");
      await agent.ctx.sessions.flush(agent.session);
      await this.orchestrator.runtimeStarted(runId,{sessionId:receipt.sessionId,turnId:String(facts.start.data.turn),eventSeq:facts.start.seq,source:"native-session"});
    }
    return receipt;
  }
  async terminal(agent,runId){
    const run=this.orchestrator.svc.state.runs.find(r=>r.id===runId);
    const pending=this.pending(runId);
    if(this.orchestrator.recordForRun(run)?.state.roles.assignment)await pending.catch(()=>{});else await pending;
    const facts=this.facts(agent.session,run.dispatchId);
    if(!facts.start||!facts.end)throw Error("缺少匹配的原宿主回合终态");
    if(await agent.ctx.sessions.flush(agent.session)!==true)throw Error("宿主终态尚未持久化");
    const value={id:"session:"+agent.session.id+":"+facts.end.seq,sessionId:String(agent.session.id),hostTurnId:String(facts.start.data.turn),
      terminalSeq:facts.end.seq,status:facts.end.data?.reason?.kind,raw:facts.end,source:"session/flush"};
    this.terminals.set(runId,value);return value;
  }
  turnOutput(events, start, end) {
    return events.filter(e=>e.seq>start.seq&&(!end||e.seq<end.seq)&&e.type==="assistant/message"&&
      (e.data?.turn===undefined||e.data.turn===start.data.turn))
      .flatMap(e=>e.data?.message?.content??[]).filter(c=>c.type==="text").map(c=>c.text).join("\n");
  }
  async inspectStoppedCarrier(run, withOutput=false) {
    const persistence = this.orchestrator.svc.ctx.get?.("sessionPersistence");
    if (!persistence) return { kind: "unknown", reason: "session-persistence-unavailable" };
    const stored = await persistence.open(run.sessionId, "read");
    try {
      if (String(stored.id) !== run.sessionId || String(stored.header.id) !== run.sessionId) {
        return { kind: "unknown", reason: "host-session-mismatch" };
      }
      const { events } = await stored.read();
      const session = { id: stored.id, header: stored.header, snapshotEvents: () => events };
      const { message, start, end } = this.facts(session, run.dispatchId);
      if (!message || !start || !end || end.seq <= message.seq) {
        return { kind: "unknown", reason: "host-terminal-unavailable" };
      }
      return { kind: "terminal", receipt: this.receipt(session, message), terminal: {
        hostTurnId: String(start.data.turn), terminalSeq: end.seq, status: end.data?.reason?.kind,
        ...(withOutput ? {id:"session:"+run.sessionId+":"+end.seq,sessionId:run.sessionId,source:"persisted-session",raw:end} : {})
      }, ...(withOutput ? {output:this.turnOutput(events,start,end)} : {}) };
    } finally {
      await stored.close();
    }
  }
  async inspectSaved(run){
    const persistence=this.orchestrator.svc.ctx.get?.("sessionPersistence");
    if(!persistence)return this.inspect(run,true);
    let stored;
    try{
      stored=await persistence.open(run.sessionId,"read");
      if(String(stored.id)!==run.sessionId||String(stored.header.id)!==run.sessionId)
        return {kind:"unknown",reason:"原会话身份不匹配"};
      const {events}=await stored.read();
      return this.inspectEvents({id:stored.id,header:stored.header,snapshotEvents:()=>events},run);
    }catch{
      return this.inspect(run,true);
    }finally{await stored?.close();}
  }
  async inspect(run,flush=false){
    const svc=this.orchestrator.svc,runner=svc.sessionRunner;
    if(!runner)return {kind:"unknown",reason:"原宿主会话恢复服务尚未就绪"};
    // Public agent restoration re-establishes the original identity. No new prompt is sent.
    let agent;try{agent=await runner.ensureAgent(run.roomId,run.botId,run.sessionId);}catch(error){return {kind:"unknown",reason:"原会话恢复失败："+error.message};}
    if(String(agent.session.id)!==run.sessionId)return {kind:"unknown",reason:"恢复会话身份不匹配"};
    if(flush&&await agent.ctx.sessions.flush(agent.session)!==true)return {kind:"unknown",reason:"原宿主回执尚未持久化"};
    return this.inspectEvents(agent.session,run);
  }
  inspectEvents(session,run){
    const facts=this.facts(session,run.dispatchId);
    if(!facts.message)return {kind:"unknown",reason:"原会话未找到该派单收件记录，禁止猜测重发"};
    const receipt=this.receipt(session,facts.message),turn=facts.start?{sessionId:receipt.sessionId,turnId:String(facts.start.data.turn),eventSeq:facts.start.seq,source:"native-session"}:null;
    const output=facts.start?this.turnOutput(this.events(session),facts.start,facts.end):"";
    const terminal=facts.end?{id:"session:"+session.id+":"+facts.end.seq,sessionId:receipt.sessionId,hostTurnId:turn.turnId,
      terminalSeq:facts.end.seq,status:facts.end.data?.reason?.kind,raw:facts.end,source:"restored-session"}:null;
    return {kind:terminal?"terminal":turn?"running":"accepted",receipt,turn,terminal,output};
  }
}
