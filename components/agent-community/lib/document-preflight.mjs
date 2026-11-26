// The dshbot transport is attached at thread/start. Unset rules are decided by the host at call time.
export function missingNativeDocumentTools(config, required, previouslyRefused = false) {
  const server = config?.mcp_servers?.dshbot;
  return required.filter(name => {
    if (server?.enabled === false || server?.disabled_tools?.includes(name) ||
        Array.isArray(server?.enabled_tools) && !server.enabled_tools.includes(name)) return true;
    const mode = server?.tools?.[name]?.approval_mode ?? server?.default_tools_approval_mode;
    if (mode && mode !== 'approve' && mode !== 'auto') return true;
    return previouslyRefused && mode !== 'approve';
  });
}

export const preflightPrefix = '建单权限核对：';
export async function documentPreflight(service, state, previouslyRefused = false) {
  const {first, reviewer, delivererId} = state.roles;
  const assignments = new Map();
  for (const [id, tool] of [[first,'agent_community_review'],[reviewer,'agent_community_review'],
      [delivererId ?? reviewer,'agent_community_deliver']]) {
    if (!assignments.has(id)) assignments.set(id,new Set());
    assignments.get(id).add(tool);
  }
  const missing = [];
  for (const [id,tools] of assignments) {
    const bot = service.getBot(id);
    if (!bot || !state.permissions.includes(id) || !state.authSnapshots[state.activeAuthorizationId]?.members?.includes(id)) {
      missing.push(preflightPrefix+'本单角色已不在当前授权成员中。');
      continue;
    }
    if (bot.provider !== 'codex-cli') continue;
    const local = service.ctx.get?.('localAgent');
    let result;
    try { result = await local?.documentToolReadiness?.([...tools],previouslyRefused); } catch { result = undefined; }
    if (!result?.verified) {
      missing.push(preflightPrefix+bot.name+'的本机宿主暂时无法核对工具权限。');
      continue;
    }
    if (result.missing.length) missing.push(preflightPrefix+bot.name+'的宿主当前需要处理文稿工具授权（'+
      result.missing.map(tool=>tool==='agent_community_review'?'送审与复核':'交付已签核文件').join('、')+'）。');
  }
  return missing;
}
