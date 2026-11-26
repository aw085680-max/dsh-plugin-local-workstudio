// Extract a speech act from the user's own clauses. Role names and omitted objects come from the room's task.
const transfer=/交接|交棒|移交|转交|递交|送审|返审|派回|送回|交回|交给|递给|转给|发给|送给|接手|接棒/u;
const review=/复核|复审|审阅|审核|评审|过审|验收|签收|签核|签字|确认|同意|把关|过目|核对|看(?:看|一(?:下|眼|遍)|下|完)|过(?:一遍|目)|审(?:一遍|一下)/u;
const draft=/稿(?:子|件)?|方案|定稿|报告|成果|清单|版本|(?:这|那|本|上一|当前)(?:一)?(?:份|版)/u;
const workflow=/(?:任务|既定|当前|后续|原(?:来)?|交接|复核)流程|下一(?:棒|位|步)|接下来/u;
const moving=/继续|推进|接着(?:走|做)?|往下(?:走|推进|做)|走下去|恢复|接手|接棒/u;
const instruction=/^(?:(?:好(?:的)?|那(?:么|就)?|但是|不过|现在|然后|接下来|接着|你们?|您|大家|就|先|再|还是|请(?:你们?)?|麻烦(?:你们?)?|帮我|直接|赶紧|尽快|务必|记得)\s*)*/u;
const negative=/^(?:(?:那|好|你们?|这次|现在|暂时|先|还|就)\s*)*(?:不要|不用|别|不必|暂缓|暂停|不(?:用|要|必|需要|再)|先等等)/u;
const informational=/^(?:随便)?(?:聊聊|谈谈|讨论|解释|科普|介绍|讲讲|举例|假设|如果|据说|听说|转述)|(?:是什么意思|是什么|怎么理解|什么叫|一般怎么|举个例子|你喜欢|当个例子|只是举例|只是转述)/u;
const historical=/^(?:据说|听说|听他|他说|她说|我说的是|复述|转述|引用)|(?:已(?:经|完成|交接|转交|发给)|正在|刚才|刚刚|改好(?:了)?|写完了|交接完了|之前说过|昨天|原来是)/u;
const statusQuestion=/(?:进度|状态|(?<!提)(?<!说)(?<!谈)(?<!讲)到哪(?:一步|里了|儿了|了)|怎么样|如何了|有没有|是否|是不是|谁(?:来|该|在)|该谁|接了没|了没|了吗|收到没|同意没|过了没|没有[？?]?$)/u;
const pronoun=/下一(?:棒|位|个)(?:成员)?|对方|原作者|首做(?:成员)?|应审人|复核(?:人|方)|审核(?:人|方)|[他她]/u;
const direction=/(?:给|交由|交回|送回|转交|交|递|转|请|让|由|找|供|麻烦)\s*$/u;
const escapeRx=s=>s.replace(/[.*+?^$()|[\]\\]/g,"\\$&");

export function handoffSpeech(input,ctx={}){
  const text=String(input??"").normalize("NFC").split(/\r?\n/u).filter(s=>!s.trimStart().startsWith(">")).join("\n")
    .replace(/“[^”]*”|「[^」]*」|『[^』]*』|"[^"\n]*"|\x60[^\x60]*\x60/gu," ").trim();
  if(!text)return;
  const clauses=text.replace(/然后|接下来|那就|但是|不过/gu,"，$&").match(/[^，,。；;！？!?\n]+[？?]?/gu)?.map(c=>c.trim()).filter(Boolean)??[];
  const names=(ctx.members??[]).flatMap(m=>[m.name,m.name?.split(/--|——/u).at(-1)]).filter(Boolean).sort((a,b)=>b.length-a.length);
  const named=names.length?new RegExp(names.map(escapeRx).join("|"),"u"):null;
  // Whole-sentence quotation/conditional scopes do not authorize a later quoted imperative.
  if(transfer.test(text)||review.test(text)||workflow.test(text)){
    if(/^(?:如果|假设|假如|比如|引用|转述|他说[：:]|她说[：:]|只是举例|我们(?:聊聊|讨论)|我想(?:聊聊|知道))/u.test(text))return {kind:"chat"};
  }
  let seenDraft=false,speech,recipientId,recipientLabel;
  for(const clause of clauses){
    const subject=clause.replace(instruction,"").trim();
    const hasDraft=draft.test(clause),transferVerb=transfer.test(clause),reviewVerb=review.test(clause);
    const actualName=named?.exec(clause)?.[0],role=actualName??pronoun.exec(clause)?.[0];
    const reviewAt=review.exec(clause)?.index??-1;
        const direct=role&&direction.test(clause.slice(0,clause.indexOf(role)))?role:null;
        const inferred=reviewAt>0?clause.slice(0,reviewAt).match(/(?:给|请|让|交由|由|找|供)([\p{L}\p{N}_-]{1,18})$/u)?.[1]:null;
        const recipient=direct??(inferred&&!/^(?:你|您|我|大家|我们|你们)/u.test(inferred)?inferred:null);
    const mentionedNext=actualName&&(ctx.nextIds??[]).some(id=>ctx.members?.some(m=>m.id===id&&(m.name===actualName||m.name.endsWith("--"+actualName))));
    const artifact=hasDraft||seenDraft||!!ctx.hasReviewWork;
    seenDraft||=hasDraft;
    if(informational.test(subject)){if(transferVerb||reviewVerb||workflow.test(clause))speech="chat";continue;}
    if(negative.test(clause)||negative.test(subject)){if(transferVerb||reviewVerb||moving.test(subject)||/^(?:别|等等|先别发)/u.test(subject))speech="chat";continue;}
    const status=statusQuestion.test(clause)||/(?:吗|么|没|了没有|过没|通过了|好了|完了)[？?]$/u.test(clause)||/^(?:谁|哪位|何时|什么时候|什么时候能|还要多久|为什么还没).{0,20}(?:接手|接棒|复核|送审|签收|签核|验收)[？?]$/u.test(clause);
    const embeddedQuestion=recipient&&artifact&&/^(?:把|将|交给|转交|派回|送审|给|让)/u.test(subject)&&!/(?:了吗|了没|没有)[？?]?$/u.test(clause)&&!/[？?]$/u.test(clause);
    if(status&&!embeddedQuestion&&(transferVerb||reviewVerb||/收到|接到|审核|看(?:过|了)|签了|交给/u.test(clause)||workflow.test(clause))){
      if(speech!=="act")speech="query";continue;
    }
    if(historical.test(subject))continue;
    const transferObject=subject.replace(/(?:交接|移交|复核)(?:文档|说明|手册|教程|规范|制度|模板|培训|流程图)/gu,"");
    const delivery=transfer.test(transferObject)&&(/^(?:把|将|进行|完成|办理|执行|做|安排|发起|开始|继续|重新|交|转|移|递|送|派|退|发给|让|请|由)/u.test(subject)||hasDraft&&!!recipient);
    const reviewOrder=artifact&&reviewVerb&&(!!recipient||mentionedNext&&/^(?:请|麻烦|让|给)/u.test(clause));
    const passToNext=!!ctx.hasReviewWork&&!!recipient&&moving.test(subject)&&!/^等|^等到|^等他|^待|之后|以后/u.test(subject);
    const advance=(workflow.test(clause)||ctx.hasReviewWork&&/流程/u.test(clause))&&moving.test(subject);
    if(delivery||reviewOrder||passToNext||advance){
      speech="act";
      if(recipient){recipientLabel=recipient;recipientId=ctx.members?.find(m=>m.name===recipient||m.name.endsWith("--"+recipient))?.id;}
    }
  }
  return speech?{kind:speech,...(speech==="act"&&recipientLabel?{recipientLabel,recipientId:recipientId??null}:{})}:null;
}

