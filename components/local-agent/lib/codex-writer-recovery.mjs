import {setTimeout as wait} from "node:timers/promises";

const resumeRetryDelayMs = 1200;
const writerReleaseStatuses = new Set(["unsubscribed", "notLoaded", "notSubscribed"]);

export function isActiveWriterError(error, threadId) {
  return String(error?.message ?? error) === "thread " + threadId + " already has an active writer";
}

export async function retryBusyResume(resume, checkedResumeError, signal) {
  await wait(resumeRetryDelayMs, undefined, {signal});
  if (signal?.aborted) throw signal.reason;
  try {
    return await resume();
  } catch (error) {
    if (checkedResumeError(error)) return undefined;
    throw error;
  }
}

export async function completedCheckpoint(peer, threadId, timeoutMs) {
  let cursor;
  do {
    const page = await peer.request("thread/turns/list", {
      threadId, limit: 16, itemsView: "notLoaded", sortDirection: "desc", ...(cursor ? {cursor} : {})
    }, {timeoutMs});
    if (!Array.isArray(page?.data)) throw Error("Codex 未返回可核对的历史回合");
    const turn = page.data.find(value => value.status === "completed" && typeof value.id === "string");
    if (turn) return turn.id;
    if (page.nextCursor === cursor) break;
    cursor = page.nextCursor;
  } while (typeof cursor === "string" && cursor.length > 0);
  throw Error("Codex 原线程没有可核对的已完成回合");
}

export async function unsubscribeThread(peer, threadId, timeoutMs) {
  const result = await peer.request("thread/unsubscribe", {threadId}, {timeoutMs});
  if (!writerReleaseStatuses.has(result?.status)) throw Error("Codex 未确认本连接的退订");
  return result.status;
}

export async function forkCompletedCodexHistory(peer, threadId, params, timeoutMs, assertCurrent) {
  assertCurrent();
  const original = (await peer.request("thread/read", {threadId, includeTurns: false}, {timeoutMs}))?.thread;
  if (original?.id !== threadId || typeof original.modelProvider !== "string") {
    throw Error("Codex 原线程身份未核对");
  }
  const checkpointTurnId = await completedCheckpoint(peer, threadId, timeoutMs);
  assertCurrent();
  const branch = (await peer.request("thread/fork", {
    ...params, threadId, lastTurnId: checkpointTurnId, excludeTurns: true, modelProvider: original.modelProvider
  }, {timeoutMs}))?.thread;
  if (!branch?.id || branch.id === threadId || branch.forkedFromId !== threadId ||
      branch.modelProvider !== original.modelProvider || branch.status?.type !== "idle") {
    throw Error("Codex 分支身份、来源或空闲状态未核对");
  }
  try {
    const last = (await peer.request("thread/turns/list", {
      threadId: branch.id, limit: 1, itemsView: "notLoaded", sortDirection: "desc"
    }, {timeoutMs}))?.data?.[0];
    if (last?.id !== checkpointTurnId || last.status !== "completed") {
      throw Error("Codex 分支没有停在已确认的回合");
    }
    assertCurrent();
    return {threadId: branch.id, previousThreadId: threadId, checkpointTurnId};
  } catch (error) {
    await unsubscribeThread(peer, branch.id, timeoutMs).catch(() => {});
    throw error;
  }
}

export function recoveryChain(record, from, to) {
  if (record?.route !== "codex-cli" || record.resumeId !== to || from === to) return;
  const history = record.writerRecoveries ?? [];
  for (let start = 0; start < history.length; start++) {
    if (history[start]?.previousThreadId !== from) continue;
    const result = [];
    let cursor = from;
    for (const relation of history.slice(start)) {
      if (relation.previousThreadId !== cursor || !relation.threadId || !relation.checkpointTurnId ||
          relation.threadId === relation.previousThreadId) break;
      result.push(relation);
      cursor = relation.threadId;
      if (cursor === to) return result;
    }
  }
}
