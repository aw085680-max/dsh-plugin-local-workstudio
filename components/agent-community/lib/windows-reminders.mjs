import {spawn} from "node:child_process";
import {createInterface} from "node:readline";
import {fileURLToPath} from "node:url";
const helper=fileURLToPath(new URL("./win32/TaskReminder.exe",import.meta.url));

/** The pipe lifetime follows the plugin. Windows restores the desktop only on explicit activation. */
export class WindowsReminders {
  constructor(bindingPath){this.bindingPath=bindingPath;this.next=1;this.pending=new Map();}
  open(){
    if(this.child)return;
    const child=spawn(helper,["--binding",this.bindingPath,"serve"],{windowsHide:true,stdio:["pipe","pipe","ignore"]});
    this.child=child;
    const stop=error=>{
      if(this.child!==child)return;
      this.child=null;
      for(const request of this.pending.values())request.reject(error);
      this.pending.clear();
    };
    const rows=createInterface({input:child.stdout});
    rows.on("line",line=>{
      let result;try{result=JSON.parse(line);}catch{return;}
      const request=this.pending.get(result.id);
      if(!request)return;
      this.pending.delete(result.id);
      if(result.error)request.reject(Error(result.error));else request.resolve(result.value);
    });
    child.once("error",stop);
    child.stdin.on("error",stop);
    child.once("exit",()=>stop(Error("Windows 通知服务已退出")));
  }
  call(command,args=[]){
    this.open();
    return new Promise((resolve,reject)=>{
      const id=this.next++;
      const timer=setTimeout(()=>{this.pending.delete(id);reject(Error("Windows 通知服务未在时限内响应"));},12000);
      this.pending.set(id,{resolve:v=>{clearTimeout(timer);resolve(v);},reject:e=>{clearTimeout(timer);reject(e);}});
      this.child.stdin.write(JSON.stringify({id,command,args})+"\n");
    });
  }
  close(){this.child?.stdin.end();}
}
