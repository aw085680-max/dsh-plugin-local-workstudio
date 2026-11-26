import {managedGroup} from "./group-routing.mjs";

const check = /核查|核对|核实|检查|查|清点|清算|统计|算|找|看|比对|对照|整理|盘点|梳理|排查|分析|汇总|审阅|审查|读|确认|列出/u;
const receiverWork = /复核|复审|复查|检查|核对|对一遍|核一遍|验证|验算|复算|确认|把关|过目|审阅|接手/u;
const indirect = /如果|假如|假设|要是|比如|例如|举例|据说|他说|她说|听说|怎么操作|如何操作|是否要|要不要|是不是要/u;
const noHandoff = /(?:不必|不要|不用|无需|别|禁止|暂不|先不)[^。！？；\n]{0,32}(?:交|转|给|发|让|请|复核|接手)/u;
const escape = s => s.replace(/[.*+?^${}()|[\]\\]/gu,"\\$&");

function directive(text) {
  return text.replace(/\x60{3}[\s\S]*?(?:\x60{3}|$)|^\s*>[^\n]*|“[^”]*(?:”|$)|「[^」]*(?:」|$)|『[^』]*(?:』|$)|"[^"\n]*"|\x60[^\x60\n]*\x60/gmu," ");
}

export function sequentialHandoff(room,body,roster,eligible,marked,reference) {
  if(!managedGroup(room)||room.paused||marked.length>2)return;
  const words=directive(body);
  if(indirect.test(words)||noHandoff.test(words))return;
  const labels=new Map();
  const add=(label,id)=>{if(label&&eligible.includes(id))labels.set(label,labels.has(label)&&labels.get(label)!==id?null:id);};
  for(const bot of roster)for(const label of new Set([bot.name,bot.name.split(/--|——/u).at(-1).trim()]))add(label,bot.id);
  for(const label of ["复核成员","复核人","复核方","审核人"])add(label,room.teamWorkflow?.reviewerId);
  const names=[...labels.keys()].sort((a,b)=>b.length-a.length).map(escape).join("|");
  if(!names)return;
  const recipient=new RegExp("(?:转交(?:给)?|交由|交给|转给|递给|发给|送给|送交|交到|(?:然后|再|接着|随后|最后|就|后)\\s*(?:请|让|由|给)|(?:请|让|由))\\s*@?("+names+")","gu");
  const matches=[...words.matchAll(recipient)];
  if(matches.length!==1)return;
  const hit=matches[0],second=labels.get(hit[1]),left=words.slice(0,hit.index),right=words.slice(hit.index+hit[0].length).trim();
  if(!second||!check.test(left)||/^(?:了|过|了吗|了么|吗|么)/u.test(right))return;
  const transfer=/交|转|递给|发给|送/u.test(hit[0]);
  if(!transfer && (!receiverWork.test(right)||!/(?:先|完|好|之后|然后|再|接着|随后|下一步)/u.test(left+hit[0])))return;
  const question=right.split(/[。！；\n]/u,1)[0];
  if(/[？?]/u.test(question)&&!/(?:可以吗|好吗|行吗)[？?]/u.test(question))return;
  // A question about an earlier handoff has no new work to start.
  if(/(?:是否|有没有|还在|已经|是不是|有没|正在)[^。！？\n]{0,30}$/u.test(left)&&!/(?:先|请|帮我)[^。！？\n]*$/u.test(left))return;
  const namePattern=new RegExp("("+names+")\\s*(?:，|,|：|:)?\\s*(?:帮我|麻烦|请)?\\s*(?:先|来|负责)?\\s*(?:"+check.source+")","gu");
  const named=new Set([...left.matchAll(namePattern)].map(m=>labels.get(m[1])));
  if(named.size>1 || named.has(null))return;
  const ref=reference?.sender?.kind==="bot"?reference.sender.botId:reference?.mentions?.length===1?reference.mentions[0]:undefined;
  const implied=/(?:^|[。！？?!；\n])\s*(?:(?:请|麻烦)?你|帮我|请先|先|查一下|核对一下|算一下)/u.test(left);
  const first=[...named][0]??(marked.length===1?marked[0]:ref??(implied&&room.team?.leader?.kind==="bot"?room.team.leader.botId:undefined));
  if(!eligible.includes(first)||first===second||marked.some(id=>id!==first&&id!==second))return;
  const formal=/(?:给我|交付|提交|交稿|发我|输出|出一份|形成|生成|整理成).{0,14}(?:终稿|文件|报告|方案|执行稿|清单)|(?:最终|正式)(?:交付|交稿)/u.test(words);
  const pair=[first,second];
  return {intent:"create",basis:body,sequentialMembers:pair,...(formal?{delivery:true}:{
    sequentialAssignments:[{botId:first,work:"先完成用户交给你的核查，回复可供下一位复算的实际结果与依据。",verb:"核查",dependsOn:[]},
      {botId:second,work:"收到上一位实际结果后，按用户本次原话完成自己的复核或后续工作，在本群答复。",verb:"复核",dependsOn:[first]}]
  })};
}
// Unfamiliar phrasing is interpreted by the addressed member during its own normal turn.
// The host fixes the only possible recipient from the user's message before a model runs.
export function handoffScope(room,text,roster,eligible,marked,reference) {
  if(!managedGroup(room)||room.paused||marked.length>1)return;
  const words=directive(text);
  if(!words.trim()||indirect.test(words)||noHandoff.test(words))return;
  const first=marked[0]??(reference?.sender.kind==="bot"?reference.sender.botId:reference?.mentions?.length===1?reference.mentions[0]:undefined)??room.team?.leader?.botId;
  if(!eligible.includes(first))return;
  const candidates=[];
  for(const bot of roster){
    if(!eligible.includes(bot.id)||bot.id===first)continue;
    const labels=[bot.name,bot.name.split(/--|——/u).at(-1).trim()];
    if(bot.id===room.teamWorkflow?.reviewerId)labels.push("复核成员","复核人","复核方","负责复核的","下一位");
    const present=[...new Set(labels.filter(label=>label&&words.includes(label)))];
    if(present.length)candidates.push({first,second:bot.id,labels:present});
  }
  return candidates.length===1?candidates[0]:undefined;
}

export function readHandoffDecision(text,original,scope){
  const index=String(text??"").lastIndexOf("WORKSTUDIO_RESULT ");
  if(index<0)return;
  let packet;
  try{packet=JSON.parse(text.slice(index+18).trim());}catch{return;}
  if(typeof packet?.say!=="string"||!packet.say.trim())return;
  if(packet.action==="answer")return {action:"answer",say:packet.say.trim()};
  const basis=typeof packet.basis==="string"?packet.basis.trim():"";
  if(packet.action!=="handoff"||!basis||!directive(original).includes(basis)
     ||!scope.labels.some(label=>basis.includes(label)))return;
  return {action:"handoff",basis,say:packet.say.trim()};
}
