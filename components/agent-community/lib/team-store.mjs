import {execFile} from "node:child_process";
import {promisify} from "node:util";
const execFileAsync=promisify(execFile);
async function restrictStoreAccess(root){
 if(process.platform!=="win32"){await (await import("node:fs/promises")).chmod(root,0o700);return {kind:"posix",mode:"0700"};}
 const who=await execFileAsync("whoami.exe",["/user","/fo","csv","/nh"],{windowsHide:true,encoding:"utf8"});
 const sid=who.stdout.match(/S-1-5-(?:\d+-)*\d+/)?.[0];if(!sid)throw Error("不能确认当前宿主账户，拒绝打开任务持久存储");
 await execFileAsync("icacls.exe",[root,"/inheritance:r","/grant:r","*"+sid+":(OI)(CI)F","*S-1-5-18:(OI)(CI)F"],{windowsHide:true,encoding:"utf8"});
 return {kind:"windows-dacl",ownerSid:sid,inheritance:false,granted:[sid,"S-1-5-18"]};
}
import net from "node:net";
import {randomUUID,createHmac,randomBytes} from "node:crypto";
import {mkdir,realpath,readFile,writeFile,open} from "node:fs/promises";
import {resolve,join,dirname} from "node:path";
import {DomainFacility,defineDomain,domainTable} from "@deepseek-ai/dsh-storage-domain";
import {JsonStorageBackend} from "@deepseek-ai/dsh-storage-json";
import {append,emptyRecord,validateRecord,canonical,digest,copy,TransitionError} from "./team-machine.mjs";

export class WriterLock {
  constructor(path,onLost=()=>{}) {this.path=path;this.onLost=onLost;this.held=false;this.expectedClose=false;this.generation=randomUUID();}
  async acquire() {
    await mkdir(this.path,{recursive:true,mode:0o700});
    this.resource=(await realpath(resolve(this.path))).replace(/[\\/]+$/,"");
    if(process.platform==="win32")this.resource=this.resource.toLowerCase();
    this.key=digest(this.resource);
    this.endpoint=process.platform==="win32"?"\\\\.\\pipe\\dsh-bots-task-"+this.key:join(this.resource,"writer.sock");
    this.server=net.createServer(socket=>{socket.on("error",()=>{});socket.end(canonical(this.info()));});
    this.server.on("close",()=>{const was=this.held;this.held=false;if(was&&!this.expectedClose)this.onLost(new Error("编排独占锁丢失"));});
    this.server.on("error",error=>{const was=this.held;this.held=false;if(was)this.onLost(error);});
    await new Promise((yes,no)=>{const fail=e=>no(new TransitionError("WRITER_LOCKED","同一路径已有编排写入者，拒绝派单："+e.code));
      this.server.once("error",fail);this.server.listen(this.endpoint,()=>{this.server.off("error",fail);this.held=true;yes();});});
    this.server.unref();
    return this;
  }
  assert() {if(!this.held||!this.server?.listening)throw new TransitionError("WRITER_LOCK_LOST","未持有编排独占锁，禁止写入与派单");}
  info(){return {pid:process.pid,resource:this.resource??this.path,key:this.key??null,generation:this.generation,held:this.held};}
  async release(){this.expectedClose=true;this.held=false;if(this.server?.listening)await new Promise(r=>this.server.close(r));}
}
export class TaskStore {
  constructor({root,logger=console,onChange=()=>{},onLockLost=()=>{},fault}){
    this.root=resolve(root);this.logger=logger;this.onChange=onChange;this.onLockLost=onLockLost;this.fault=fault;this.chains=new Map();
    this.busyRecords=new Set();
    this.lock=new WriterLock(this.root,error=>{this.failed=error;onLockLost(error);});
  }
  async open({keepWriterOnError=false}={}){
    await this.lock.acquire();
    try {
      this.access=await restrictStoreAccess(this.root);
      const keyPath=join(this.root,"integrity.key");
      try{this.key=await readFile(keyPath);}catch(e){if(e.code!=="ENOENT")throw e;this.key=randomBytes(32);await writeFile(keyPath,this.key,{flag:"wx",mode:0o600});}
      this.backend=new JsonStorageBackend(this.root);
      const facilityCtx={storage:{backend:{get:name=>{if(name!=="team-json")throw Error("unknown backend");return this.backend;}}},
        emit:(_name,change)=>{this.lock.assert();this.onChange(change);},logger:this.logger};
      this.facility=new DomainFacility(facilityCtx,{backend:"team-json"});
      const schema={parse:record=>{validateRecord(record);this.checkSeal(record);return copy(record);}};
      this.domain=await this.facility.open(defineDomain({name:"team_tasks_v1",version:1,layout:"per-record",
        tables:{tasks:domainTable(schema)}}));
      this.table=this.domain.table("tasks");
      return this;
    }catch(error){this.failed=error;if(!keepWriterOnError)await this.lock.release();throw error;}
  }
  seal(record){const r=copy(record);delete r.seal;r.seal=createHmac("sha256",this.key).update(canonical(r)).digest("hex");return r;}
  checkSeal(record){const {seal,...plain}=record;if(seal!==createHmac("sha256",this.key).update(canonical(plain)).digest("hex"))throw new TransitionError("RECORD_SEAL","任务记录完整性签名不符");}
  assert(){if(this.failed)throw this.failed;this.lock.assert();}
  keyOf(id){return "task_"+digest(id);}
  get(id){const r=this.table.get(this.keyOf(id));if(!r)return undefined;validateRecord(r);this.checkSeal(r);return copy(r);}
  list(){return [...this.table.entries()].map(([_key,record])=>this.get(record.taskId));}
  async exclusive(id,fn){
    const previous=this.chains.get(id)??Promise.resolve();
    const result=previous.catch(()=>{}).then(fn);
    this.chains.set(id,result);
    try{return await result;}finally{if(this.chains.get(id)===result)this.chains.delete(id);}
  }
  event(type,payload={},id=randomUUID()){return {id,type,payload:copy(payload),at:new Date().toISOString()};}
  isRecordSharingError(id, error) {
    return process.platform === "win32" && error?.syscall === "rename" &&
      ["EPERM", "EBUSY", "EACCES"].includes(error.code) && typeof error.dest === "string" &&
      resolve(error.dest).toLowerCase() === join(this.root, "team_tasks_v1", "tasks", this.keyOf(id) + ".json").toLowerCase();
  }
  async writeRecord(id, write) {
    // put/update publishes the memory snapshot only after the atomic rename succeeds.
    const delays = this.busyRecords.has(id) ? [] : [50, 100, 200, 400, 800, 1000];
    for (let attempt = 0; ; attempt++) {
      this.assert();
      try {
        const result = await write();
        this.busyRecords.delete(id);
        return result;
      } catch (error) {
        if (!this.isRecordSharingError(id, error)) throw error;
        this.busyRecords.add(id);
        if (attempt >= delays.length) throw error;
        await new Promise(resolve => setTimeout(resolve, delays[attempt]));
      }
    }
  }
  async create(id,events){
    return this.exclusive(id,async()=>{
      this.assert();
      if(!this.table.get(this.keyOf(id)))await this.writeRecord(id,()=>this.table.put(this.keyOf(id),this.seal(emptyRecord(id))));
      return this.commitUnlocked(id,events,{expectedRevision:0});
    });
  }
  async commit(id,events,options={}) {return this.exclusive(id,()=>this.commitUnlocked(id,events,options));}
  async commitUnlocked(id,events,options={}) {
    this.assert();let rejection;
    const result=await this.writeRecord(id,()=>this.table.update(this.keyOf(id),current=>{
      this.assert();this.checkSeal(current);validateRecord(current);
      try {
        this.fault?.("before-apply",{current,events,options});
        const next=append(current,events,options);
        this.fault?.("before-persist",{current,next,events,options});
        this.assert();
        return this.seal(next);
      }catch(error) {
        // Rejection is audit evidence only; the existing business state is unchanged.
        if(!(error instanceof TransitionError))throw error;
        rejection={code:error.code,reason:error.message,eventIds:events.map(e=>e.id)};
        const rejected=this.event("REJECTED",rejection);
        return this.seal(append(current,[rejected]));
      }
    }));
    this.assert();
    if(rejection){const error=new TransitionError(rejection.code,rejection.reason);error.record=copy(result);throw error;}
    return copy(result);
  }
  /** Content-addressed durable blobs; never overwrite original evidence. */
  async putBlob(value,kind="json") {
    this.assert();const bytes=Buffer.isBuffer(value)?value:Buffer.from(typeof value==="string"?value:canonical(value));
    const contentSha256=(await import("node:crypto")).createHash("sha256").update(bytes).digest("hex");
    const id=contentSha256,path=join(this.root,"blobs",id+"."+kind);await mkdir(dirname(path),{recursive:true,mode:0o700});
    try{const h=await open(path,"wx",0o600);try{await h.writeFile(bytes);await h.sync();}finally{await h.close();}}catch(e){if(e.code!=="EEXIST")throw e;}
    const ref={id,sha256:contentSha256,kind,bytes:bytes.length,path};await this.readBlob(ref);return ref;
  }
  async readBlob(ref) {
    const expected=join(this.root,"blobs",ref.id+"."+ref.kind);
    if(resolve(ref.path??expected)!==resolve(expected))throw new TransitionError("BLOB_PATH","资料引用超出持久存储");
    const bytes=await readFile(expected),hash=(await import("node:crypto")).createHash("sha256").update(bytes).digest("hex");
    if(hash!==ref.sha256||bytes.length!==ref.bytes)throw new TransitionError("BLOB_HASH","持久资料哈希不一致");
    return bytes;
  }
  async close(){this.closed=true;await Promise.allSettled([...this.chains.values()]);await this.domain?.close();await this.backend?.close();await this.lock.release();}
}
