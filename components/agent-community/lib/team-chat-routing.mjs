import {handoffSpeech} from "./handoff-speech.mjs";
import {returnIntent,reviewQuestion} from "./team-review.mjs";
import { digest } from "./team-machine.mjs";

export const CHAT_REPLY_LIMIT = 4;
export const CHAT_TURN_LIMIT_MS = 180_000;

const polite = /^(?:(?:请(?:你们?)?|麻烦(?:你们?)?|帮我|我想要?|我要|现在|那就|直接)\s*)+/u;
const prior = /^(?:(?:授权|同意|请)\s*)?(?:继续|续做|恢复|接着做)\s*(?:执行|做|处理|完成|推进)?\s*(?:原(?:来的)?(?:任务|方案|工作)|旧(?:任务|方案)|(?:上(?:一条|一项|一个|次|一轮)|之前|先前|刚才|昨天|前面|(?:我的?)?第一条)的?(?:任务|要求|消息|方案|工作))(?:吧|即可|就行|就好)?(?:$|[\s，,。！!；;：:])/u;
const first = /^(?:继续\s*)?(?:按(?:照)?|根据|沿用)\s*(?:我的?)?第一条\s*(?:消息|要求|任务)\s*(?:要求)?[\s，,。；;]*(?:(?:进行)?执行|继续|续做|实施|推进|(?:开始|重新)?做)/u;
const stop = /^(?:立即\s*)?(?:停止|取消|终止|中止)(?:\s*(?:本轮|这项|当前|原|旧)?(?:任务|接力|运行|对话)|本轮)?[。！!\s]*$/u;
const review = /^(?:发起返审|返审|送审|重新审核|退回复核)\s*(?:(?:这项|该|原|旧|当前)?(?:任务|方案|成果|版本)|本轮)(?:$|[\s，,。！!；;：:])/u;
const append = /^(?:给)?(?:(?:这项|该|原|旧|当前)任务|本轮任务)?\s*(?:追加|补充)(?:\s*(?:这项|该|原|旧|当前)任务)?(?:\s*(?:要求|需求|任务要求)|[：:])\s*/u;
const question = /^(?:请问|什么是|怎么理解|为什么|你觉得|你怎么看|我刚说|是不是|能不能|可以|有没有)|(?:了吗|怎么样|是什么|什么意思|如何理解|靠谱不靠谱|靠谱吗|可以吗|对吗|行吗|完成了吗)[？?。！!\s]*$/u;
const progress = /(?:做到哪了|做(?:到|完)哪一步|(?:进度|做到哪|做到哪一步)(?:如何|怎么样|了)?|(?:完成|做完|交付).{0,20}了吗|(?:当前|现在|目前).{0,16}(?:进度|到哪了))[？?。！!\s]*$/u;
const roleStatement = /^(?:执行|复核|审核|监督|分析|开发|交付|测试)(?:方|人员|组|团队|者|人)\s*(?:已经|已|正在|目前|现在|还在|还没|尚未|刚刚|刚|说|表示|反馈|在等|在做|做完|干完|完成了)/u;
const followOriginal = /(?:^|[。！？!?\n])\s*(?:请(?:你)?\s*)?按(?:照)?我(?:刚才|之前|前面)?(?:说|提)(?:过)?的(?:要求)?\s*(?:去做|做|执行|办理)[。！!\s]*$/u;
const directive = /^(?:(?:先|把|将|对|为|用|根据|按(?:照)?|依据|对照|结合|针对)\s*[^，。！？?；;\n]{0,45}?)?(?:排查|修复|复核|检查|验证|复测|测试|制定|编写|撰写|拟定|整理|实现|完成|修改|更新|优化|升级|核对|迁移|部署|生成|分析|设计|总结|统计|交付|制作|执行|实施|安排|输出|出|进行|配置|跑|做|写|打开|读取|查看)(?<separator>\s*(?:[：:]\s*)?)(?<target>\S[\s\S]*)$/u;
const deliver = /(?:^|[，,；;。\n])\s*(?:请)?(?:交付|提交|产出|输出|生成)\s*([^。！？；;\n]+)\s*$/u;
const simpleChat = /^(?:你们\s*)?(?:一人一句|每个人(?:都)?(?:只)?(?:讲|说|回|回复)(?:一|1)句|每(?:人|个成员)(?:都)?(?:只)?(?:讲|说|回|回复)(?:一|1)句)/u;
const serialChat = /(?:接力|轮流|依次|按顺序)(?:来|各|每人)?\s*(?:说|讲|回复|接话|接棒|回答|聊)|接龙|^(?:你们?\s*)?(?:接棒|继续接话)[。！!\s]*$/u;
const relayCount = /^(?:我(?:先)?说)\s*(\d{1,6})\s*[,，、。]?\s*(?:然后|接下来)?\s*(?:请)?你们?\s*(?:接棒|接力|接龙|轮流)\s*(?:(?:说|数|报)?到\s*(\d{1,6}))?\s*[。！!\s]*$/u;

const groupLink = /\[[^\]\r\n]*\]\((?:codex|https?):\/\/(?:[^()\s]|\([^()\s]*\))+(?:[ \t]+["'][^"'\r\n]*["'])?\)|<(?:codex|https?):\/\/[^<>\s]+>|codex:\/\/threads\/[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}(?:[?#][A-Za-z\d_.~%?&=+/:#-]*)?|(?:codex|https?):\/\/[^\s<>"'（），。！？；：、【】「」『』“”‘’\x60]+/giu;
export function maskGroupLinks(text) {
  return text.replace(groupLink, " \uFFFC ");
}

// Only the authored command determines the route. Keep the original message for execution and review.
export function requestText(text, keepReference = false) {
  const withoutLabels = text.replace(/(?:参考链接|相关链接|会话链接|链接地址|链接|参考资料|资料地址)[ \t]*[:：][ \t]*(?=\uFFFC)/gu, "");
  const body = withoutLabels.replace(/\uFFFC/gu, keepReference ? "所附资料" : " ")
    .replace(/^[\s,，、;；:：。]+|[\s,，、;；:：]+$/gu, "").trim();
  const clauses = body.split(/[，,。；;\r\n]+/u).map(clause => clause.trim()).filter(Boolean);
  // Peel introductory context only when it precedes another clause. Never search a quotation or status report for work.
  let first = 0;
  while (first < clauses.length - 1 && /^(?:根据|依据|按照|结合|针对|对照|参考|就(?:目前|现在))[^。！？?]{0,100}$/u.test(clauses[first].trim())) {
    const tail = clauses.slice(first + 1).join("，").trim();
    if (!tail || classifyGroupMessage(clauses[first].trim()).intent === "create") break;
    first++;
  }
  return first ? clauses.slice(first).join("，").trim() : body;
}

export function classifyUserRequest(authoredBody, input = {}) {
  const hasLink = authoredBody.includes("\uFFFC");
  const routing = {...input, liveMessage:true, hasReference:!!input.hasReference || hasLink};
  const body = requestText(authoredBody);
  // “能帮我整理清单吗” contains a direct request. A question asking about a task remains a chat.
  const politeAction=body.match(/^(?:(?:你们?|您)\s*)?(?:能不能|可不可以|能否|可以|能)\s*(?:帮我|替我|给我)\s*(.+?)(?:吗|么)?[？?。！!]*$/u);
  const text = politeAction?.[1]?.trim()||body;
  const assessment=handoffSpeech(text,input.handoffContext),speech=assessment?.kind;
  if(speech==="chat")return {intent:"chat",basis:text};
  if(speech==="act"||returnIntent(text))return {intent:"return-review",basis:text,...(assessment?.recipientLabel?{recipientLabel:assessment.recipientLabel,recipientId:assessment.recipientId}:{})};
  if(speech==="query"||reviewQuestion(text))return {intent:"progress",reviewQuery:true,basis:text};
  const decide = value => {
    const prior = classifyGroupMessage(value, routing);
    if (prior.intent !== "chat" || prior.roleStatement || question.test(value) || /[？?]/u.test(value)) return prior;
    const command = value.replace(polite, "").replace(/^(?:你们?|大家)\s*(?=把|将|帮我|给我|一起|分别)/u, "")
      .replace(/^(?:(?:一起|一起帮我|分别|各自|给我|帮我|先)\s*)+/u, "");
    if (command !== value && classifyGroupMessage(command, routing).intent === "create") return {intent:"create", basis:value};
    const request = command.match(/^(?:梳理|汇总|排查|校对|列出|给出|拟订|制作|对比|比较|评估|审查|修订|修理|调整|完善|准备|处理|查阅|查找|提取|补齐|补全|保存|下载|导出|导入|提交|起草|归档|翻译|清点|盘点)\s*(?:一下)?\s*(.+)$/u);
    if (request && /[\p{L}\p{N}]/u.test(request[1]) && !/^(?:了|过|的|完了|一下[。！!\s]*$)/u.test(request[1])) return {intent:"create",basis:value};
    return prior;
  };
  const decision = decide(text);
  if (decision.intent !== "chat" || !hasLink) return decision;
  // In “读取 <链接>” the link is the direct object. Its address and label supply no verbs.
  const withObject = decide(requestText(authoredBody, true));
  return withObject.intent === "create" ? withObject : decision;
}

export function classifyGroupMessage(body, input = {}) {
  const text = body.trim().replace(polite, "");
  const linked = Boolean(input.continueTaskId || input.taskId || input.replyTo || input.threadId);
  if (/^(?:任务结束|结束任务|结束这项任务|这件事结束了)[。！!\s]*$/u.test(text)) return {intent:"close-thread",basis:text};
  if (stop.test(text)) return { intent: "stop", basis: text };
  if (review.test(text)) return { intent: "review", basis: text };
  const supplement = text.match(append);
  if (supplement && /[\p{L}\p{N}]/u.test(text.slice(supplement[0].length))) {
    return { intent: "append", basis: supplement[0].trim() };
  }
  if (input.continueTaskId || prior.test(text) || first.test(text) ||
      (linked && /^(?:继续|续做|恢复|接着做)[。！!\s]*$/u.test(text))) {
    return { intent: "resume", basis: text };
  }
  if (followOriginal.test(text)) return {intent:"progress", followOriginal:true, basis:text};
  if (roleStatement.test(text)) return {intent:"chat", roleStatement:true, basis:text};
  const count = text.match(relayCount);
  if (progress.test(text) || /^(?:完成|做完|交付).{0,28}了吗[？?]/u.test(text)) return {intent:"progress",basis:text};
  const ask = question.test(text) || /[？?]/u.test(text);
  const match = text.match(directive);
  // Persisted legacy rows keep their original treatment of spaces between a verb and its object.
  const action = match && (input.liveMessage || !match.groups.separator || /[:：]/u.test(match.groups.separator)) ? match.groups.target : undefined;
  const concreteTarget = target => /[\p{L}\p{N}]/u.test(target) &&
    !/^(?:任务|工作|一下|下|吧|它|这个|那个|要求|指令|命令|安排)[。！!\s]*$/u.test(target.trim());
  const toDeliver = text.match(deliver);
  if (!ask && !count && (toDeliver && concreteTarget(toDeliver[1]) ||
      action && concreteTarget(action) && (input.hasReference || !/^(?:这|那|上次|之前)(?:个|项|一项)?(?:事|内容|任务|方案)[。！!\s]*$/u.test(action)))) {
    return { intent: "create", basis: (toDeliver?.[0] ?? text).trim() };
  }
  if (!ask && (count || serialChat.test(text) || input.hasExplicitOrder && /顺序|先.+再|→|然后/u.test(text))) {
    return {
      intent: "ordered-chat",
      basis: text,
      ...count ? { countFrom: Number(count[1]), ...(count[2] ? { countTo: Number(count[2]) } : {}) } : {}
    };
  }
  return { intent: "chat", basis: text, ...(!ask && simpleChat.test(text) ? {each: true} : {}) };
}

export function requestMessageId(roomId, requestId) {
  if (requestId === undefined) return undefined;
  if (typeof requestId !== "string" || !/^[a-z0-9:_-]{8,128}$/iu.test(requestId)) {
    throw Error("消息请求标识无效");
  }
  return "request:" + digest({roomId, requestId});
}

export function isChatRun(run) {
  return !!run && run.runtime === "chat";
}

export function orderedChatMembers(explicit, configured, eligible, decision) {
  const available = new Set(eligible);
  const order = [...new Set([...explicit, ...configured, ...eligible])].filter(id => available.has(id));
  if (decision.countTo !== undefined) return order.slice(0, Math.max(0, decision.countTo - decision.countFrom));
  return order;
}

export function chatRunId(messageId, index) {
  return "chat:" + digest({messageId, index});
}

export function displayReply(text, verifiedFallback = "") {
  if (typeof text !== "string") return "";
  const trimmed = text.trim();
  const json = trimmed.match(/^\x60{3}json\s*([\s\S]*?)\s*\x60{3}$/iu)?.[1] ?? trimmed;
  if (!json.startsWith("{")) return text;
  let value;
  try { value = JSON.parse(json); } catch { return text; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return text;
  const structured = Object.hasOwn(value, "say") || (
    Object.keys(value).some(key => ["status", "diagnostic", "decision", "ticketId", "evidence", "handoffs"].includes(key)) &&
    Object.keys(value).every(key => ["type", "status", "diagnostic", "decision", "ticketId", "evidence", "handoffs", "reason", "result", "versionId", "taskId", "message", "tools", "process"].includes(key))
  );
  if (!structured) return text;
  return typeof value.say === "string" && value.say.trim() ? value.say : verifiedFallback;
}
