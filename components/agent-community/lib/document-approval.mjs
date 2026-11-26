const documentTools = new Map([
  ['agent_community_review', '送审或复核'],
  ['agent_community_deliver', '交付终稿']
]);
const prerequisites = new Map([
  ['The agent asks to run a command','command'],
  ['The agent asks to change files','file-change']
]);

// The source dispatch, host request id, decision, and turn boundary must all agree.
export function documentApproval(events, dispatchId, includePrerequisites = false) {
  const message = events.find(event => event.type === 'user/message' && event.data?.source?.dispatchId === dispatchId);
  if (!message) return null;
  const next = events.find(event => event.seq > message.seq && (
    event.type === 'turn/end' || event.type === 'user/message' && event.data?.source?.dispatchId && event.data.source.dispatchId !== dispatchId
  ));
  const asked = new Map();
  const decisions = new Map();
  for (const event of events) {
    if (event.seq <= message.seq || next && event.seq >= next.seq) continue;
    const data = event.data;
    if (event.type === 'approval/asked' && data?.id && data.toolName === 'approve_agent_action') {
      const firstLine = typeof data.reason === 'string' ? data.reason.split('\n', 1)[0].trim() : '';
      for (const name of documentTools.keys()) {
        if (firstLine === 'Allow the dshbot MCP server to run tool "' + name + '"?') asked.set(data.id, name);
      }
      if (includePrerequisites && prerequisites.has(firstLine)) asked.set(data.id,prerequisites.get(firstLine));
    }
    if (event.type === 'approval/decided' && asked.has(data?.id)) {
      const name = asked.get(data.id);
      asked.delete(data.id);
      if (['rejected', 'cancelled', 'unavailable', 'allowed-once'].includes(data.outcome)) {
        decisions.set(name, {tool:name, outcome:data.outcome, seq:event.seq});
      }
    }
  }
  const refused = [...decisions.values()].filter(value=>value.outcome !== 'allowed-once').sort((x,y)=>y.seq-x.seq);
  return refused.find(value=>documentTools.has(value.tool)) ?? refused[0] ?? null;
}

export function approvalBlockReason(result) {
  if (!result) return null;
  const label = {rejected:'拒绝', cancelled:'已撤销', unavailable:'无可用审批应答'}[result.outcome];
  if (!label) return null;
  if (['command','file-change'].includes(result.tool)) {
    const action = result.tool === 'command' ? '命令执行' : '文件修改';
    return '宿主审批阻塞（'+action+'）：'+label+'。本棒结束时仍缺少正式文稿操作回执，已保留原消息和附件，暂停重复派单。';
  }
  const action = documentTools.get(result.tool);
  return action ? '宿主审批阻塞（' + action + '）：' + label + '。原稿和已有回执按当前登记版本保留；获得新的有效授权后可从原任务续办。' : null;
}
