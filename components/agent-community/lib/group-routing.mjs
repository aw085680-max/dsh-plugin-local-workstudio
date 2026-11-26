// Room policy is independent of provider credentials and of historical preview-room migrations.
export function managedGroup(room) {
  return Boolean(room?.id && room.directBotId === undefined && Array.isArray(room.memberIds));
}

const escape = text => text.replace(/[.*+?^$\x7b\x7d()|[\]\\]/gu, '\\$&');
const reviewWork = '(?:按原件|按原文|对照原件|对照原文|独立|再|来|负责|帮忙|先|最后|进行|一遍|仔细|逐项|按原材料|\\s)*(?:复核|核对|核查|审核|复审|挑错|审稿|审阅|把关|先核|核一遍|核一下|核(?=$|[，,。；;\\s]))';
const together = '(?:一起|共同|协作|合作|协同)(?:完成|编写|写|做|处理|起草|整理)?';
const context = /(?:昨天|之前|上次|已经|曾经|复核过|核对过|审过|建议过|转述|告诉我|(?<!按)(?<!对照)原文|示例|假设|原话|历史|例子|举例|例如|比如|据说|听说|假设|假如|是否|是不是|要不要|有没有|不要|不用|无需|不必|暂不|先别|禁止|不让|别请|说过|提过|写道|提到)/u;
const actionBoundary = '(?:^|[，,。；;：:\\n]|然后|随后|接着|之后|再|把初稿|把稿件|将初稿|写完后|完成后)\\s*';
function clausesFor(visible) {
  // Mention parsing has already masked quotes, code, URLs and block quotes.
  return visible.split(/[。！？!?\n；;]/u).filter(sentence => !context.test(sentence) ||
    !/(?:原话|他说|她说|写道|提到|举例|例如|比如|假设|假如)/u.test(sentence))
    .flatMap(sentence => sentence.split(/[，,、]/u)).map(part => part.trim())
    .filter(part => part && !context.test(part));
}
export function collaborationPlan({authored, body, roster, eligible, leader, saved, referenced, button=false, delegatedToGroup=false}) {
  const visible = authored.authoredText ?? body;
  const clauses = clausesFor(visible);
  if (!button && (/(?:[？?]|[吗么呢][。！!]?)\s*$/u.test(visible) || /(?:不必|不要|不用|无需|禁止|先别)[^。；;\n]{0,20}(?:复核|挑错|一起|交给|协作|审核|接棒)/u.test(visible))) return;
  const labels = new Map();
  for (const bot of roster) for (const label of new Set([bot.name,bot.name?.split(/--|——/u).at(-1)?.trim()])) {
    if (label) labels.set(label, labels.has(label) && labels.get(label)!==bot.id ? null : bot.id);
  }
  const alternatives=[...labels.keys()].sort((a,b)=>b.length-a.length).map(escape);
  if (!alternatives.length) return button ? {clarification:'请先登记本群主笔和复核人。'} : undefined;
  const name='@?('+alternatives.join('|')+')';
  const addressed=authored.ids ?? [];
  const second=new Set(), authors=new Set(), partners=new Set(), senders=new Set(), basis=[];
  const addressee=addressed.length===1?addressed[0]:referenced??leader;
  const roles=(pattern,clause,ids)=>{
    for (const m of clause.matchAll(new RegExp(pattern,'gu'))) { ids.add(labels.get(m[1])); basis.push(m[0].trim()); }
  };
  let joint=button || delegatedToGroup;
  for (const clause of clauses) {
    roles(actionBoundary+'(?:请|让|交由|交给|转给|转交给|请把初稿交给|把初稿交给|由)?\\s*'+name+'\\s*'+reviewWork,clause,second);
    roles('(?:你|您)\\s*(?:和|与|跟|同)\\s*'+name+'\\s*'+together,clause,partners);
    roles(actionBoundary+'(?:请|让|由)?\\s*'+name+'\\s*(?:来|负责|先|担任)*\\s*(?:主笔|起稿|起草|执笔|写初稿|写一版|出初稿)',clause,authors);
    roles('(?:最后|最终|改妥后?|复核后)\\s*(?:由|请|让)?\\s*'+name+'\\s*(?:来|负责)?\\s*(?:交付|交稿|发群|汇总|提交终稿)',clause,senders);
    if (/^(?:最后|然后|再)?(?:由|请)?你(?:来|负责|最后)?(?:复核|复审|审核)(?:[。！! ]|$)/u.test(clause)) {second.add(addressee);basis.push(clause);}
    if (/^(?:改妥|最后|最终|复核后)(?:由|请|让)?你(?:来|负责)?(?:交付|汇总|交稿|发群)/u.test(clause)) {senders.add(addressee);basis.push(clause);}
    if (/^(?:请|麻烦|这次|这项任务|你们|两位|两人|双方|\s)*(?:多人协作|双人协作|共同完成|一起完成|分工协作)|(?:请|让|交给|交由)(?:本群)?复核人(?:复核|审核)|(?:两人|双方)复核/u.test(clause)) {joint=true;basis.push(clause);}
  }
  if (partners.size) joint=true;
  if (!joint && (!second.size || addressed.length===1 && second.size===1 && second.has(addressed[0]) && !authors.size)) return;
  const clarify=()=>({clarification:'请指明本单由谁主笔、谁复核，以及需要时由谁交付。'});
  if (authors.size>1 || partners.size>1 || second.size>1 || senders.size>1 || [...authors,...partners,...second,...senders].some(id=>!eligible.includes(id))) return clarify();
  const explicitReviewer=[...second][0];
  const first=[...authors][0] ?? addressed.find(id=>id!==explicitReviewer) ?? referenced ??
    (button || joint ? saved?.firstBotId ?? saved?.memberIds?.[0] : undefined) ?? leader;
  const reviewer=explicitReviewer ?? [...partners].find(id=>id!==first) ?? addressed.find(id=>id!==first) ?? saved?.reviewerId;
  const deliverer=[...senders][0] ?? (delegatedToGroup ? saved?.delivererId : undefined) ?? first;
  if (!eligible.includes(first)||!eligible.includes(reviewer)||first===reviewer||
      !eligible.includes(deliverer)||[...partners].some(id=>id!==first&&id!==reviewer)||addressed.some(id=>id!==first&&id!==reviewer&&id!==deliverer)) return clarify();
  return {writer:first,reviewer,deliverer,basis};
}
