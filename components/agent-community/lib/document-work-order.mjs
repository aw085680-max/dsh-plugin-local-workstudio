import {managedGroup} from './group-routing.mjs';

// Each permission refers to an authenticated work order, one live dispatch, and its current role.
export function documentOperations(state, run, room, activeMembers) {
  if (!managedGroup(room) || room?.paused || !state || state.roomId !== room.id || state.taskId !== run?.teamTaskId ||
      run.roomId !== room.id || run.status !== 'running' || state.stop || ['stopping','stopped','completed'].includes(state.status)) return [];
  const step=state.steps[state.currentStepId], dispatch=state.dispatches[run.dispatchId];
  if (!step || !dispatch || step.stepId!==run.teamStepId || dispatch.stepId!==step.stepId ||
      dispatch.attemptId!==step.currentAttemptId || (run.attemptId && run.attemptId!==dispatch.attemptId) || dispatch.runId!==run.id || dispatch.targetId!==run.botId ||
      ['terminal','revoked'].includes(dispatch.status) || !activeMembers.includes(run.botId)) return [];
  const grant=Object.values(state.authSnapshots).find(auth=>auth.documentWorkOrder?.taskId===state.taskId &&
    auth.documentWorkOrder.roomId===room.id && auth.documentWorkOrder.origin===auth.messageId);
  if (!grant || !grant.members.includes(run.botId) || !state.authSnapshots[dispatch.authorizationId]?.members.includes(run.botId)) return [];
  const order=grant.documentWorkOrder, actor=run.botId;
  if (order.kind==="single-file") {
    const member=state.roles.assignment;
    return member?.singleFile && member.sourceMessageId===order.origin && member.botId===actor &&
      order.writer===actor && order.deliverer===actor && grant.members.length===1 &&
      run.originMessageId===order.origin ? ["deliver"] : [];
  }
  if (step.purpose==='final-delivery') return actor===order.deliverer && actor===(state.roles.delivererId??state.roles.reviewer) ? ['deliver'] : [];
  if (actor===order.writer && actor===state.roles.first) return ['receive','revise','approve'];
  return actor===order.reviewer && actor===state.roles.reviewer ? ['receive','changes','approve'] : [];
}
export function hasDocumentOrder(state) {
  return Object.values(state?.authSnapshots??{}).some(auth=>auth.documentWorkOrder?.taskId===state.taskId);
}
