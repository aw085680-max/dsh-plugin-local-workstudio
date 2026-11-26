// Host carrier events and model turn receipts describe different processes.
export function recoveredCodexResult(run, dispatch, carrier) {
  const check = run.upstreamVerification, receipt = run.upstream?.terminal;
  if (run.dispatchId !== dispatch.dispatchId || !dispatch.turn?.threadId || !dispatch.turn.turnId ||
      !receipt || !check || check.threadId !== dispatch.turn.threadId || check.turnId !== dispatch.turn.turnId ||
      receipt.threadId !== check.threadId || receipt.turnId !== check.turnId || receipt.status !== check.status) return;
  if (receipt.status === "completed") {
    if (carrier.kind !== "terminal" || carrier.terminal?.status !== "completed" ||
        !dispatch.receipt || carrier.receipt?.messageId !== dispatch.receipt.messageId ||
        carrier.receipt.sessionId !== run.sessionId) return;
    return {status:"completed", terminalReceipt:receipt, reply:{text:carrier.output}};
  }
  if (receipt.status !== "failed" && receipt.status !== "interrupted") return;
  const cancelled = receipt.status === "interrupted" && run.stop?.kind === "user";
  return {status:cancelled ? "cancelled" : "failed", terminalReceipt:receipt,
    error:receipt.status === "interrupted" ? "原模型回合已中断，未收到本次交付。" : "原模型回合已失败，请查看原消息。"};
}
