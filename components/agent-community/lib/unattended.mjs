import {managedGroup} from "./group-routing.mjs";
// A request can appoint a different pair without changing the room's saved workflow.
export function deliveryPair(room,roster,eligible,saved,message,roles) {
  const members=roster.filter(b=>eligible.includes(b.id)&&room.memberIds.includes(b.id));
  const alias=b=>b.name.trim().split(/--|——/u).at(-1).trim();
  const named=name=>{const found=members.filter(b=>alias(b)===name);return found.length===1?found[0].id:undefined;};
  const assigned=pattern=>members.filter(b=>{
    const label=alias(b).replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
    return new RegExp(label+"\\s*(?:来|负责|担任)?\\s*(?:"+pattern+")","u").test(message.text);
  });
  const authors=assigned("主笔|起草|执笔"), reviewers=assigned("复核|审稿|审核");
  if(authors.length>1||reviewers.length>1)throw Error("本次分工有多位主笔或复核人，请明确一组。");
  const marked=message.mentions??[];
  let partner;
  if(managedGroup(room) && marked.length===1 && members.some(bot=>bot.id===marked[0])) {
    const explicitPartners = members.filter(bot => {
      if(bot.id===marked[0] || named(alias(bot))!==bot.id)return false;
      const label=alias(bot).replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
      return new RegExp("(?:你|你们|"+alias(members.find(m=>m.id===marked[0])).replace(/[.*+?^${}()|[\]\\]/g,"\\$&")+")\\s*(?:和|与|跟|同)\\s*"+label+"\\s*(?:一起|共同|协同|负责|制定|完成|编写|核查|商定|讨论|合作|拟定|[,，。])","u").test(message.text);
    });
    if(explicitPartners.length===1)partner=explicitPartners[0].id;
  }
  if(marked.length===1&&!partner&&!authors.length&&!reviewers.length&&!roles?.reviewerId)return null;
  const preferred=[roles?.sequence?.[0],...marked,saved?.firstBotId].filter(Boolean);
  const second=reviewers[0]?.id??roles?.reviewerId;
  const first=authors[0]?.id??preferred.find(id=>id!==second&&eligible.includes(id));
  const reviewer=second??[partner,...marked,saved?.reviewerId].find(id=>id!==first&&eligible.includes(id));
  if(!first||!reviewer||first===reviewer)return null;
  return [first,reviewer];
}
export function reviewInstruction(author) {
  return author
    ? "你是主笔。查阅原话指定的资料和证据，完成整份方案。逐条覆盖全部补充要求。若有退修意见逐条回应并修改。用 agent_community_review 的 revise 提交完整 Markdown 正文，有旧版本时携带 review.versionId。交接由系统完成。确实因必要资料或权限无法继续时说明具体缺口并保留阶段稿。"
    : "你是独立复核人。用 agent_community_review 的 receive 签收本轮版本，对照原话、全部补充和证据逐条复核。缺项用 changes 写明问题、依据和改好标准。合格用 approve 写明复核结论。必须使用本次 review.versionId。系统负责返修派单和最终交付。";
}
