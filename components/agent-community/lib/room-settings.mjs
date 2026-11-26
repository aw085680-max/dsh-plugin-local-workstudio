export function roomSettingsValues(room, defaultAdmission = "legacy") {
  const flow = room.teamWorkflow;
  const compression = room.compression;
  return {
    basic: { name: room.name, members: [...room.memberIds] },
    reply: { paused: !!room.paused, admission: room.admission?.mode ?? defaultAdmission, speculation: room.speculation?.mode ?? "off" },
    roles: { leader: room.team?.leader?.botId ?? "", first: flow?.firstBotId ?? flow?.memberIds?.[0] ?? "", reviewer: flow?.reviewerId ?? "", delivery: flow?.delivererId ?? "" },
    compression: {
      inherit: compression?.inherit !== false, ratio: String(compression?.thresholdRatio ?? 0.8),
      tokens: String(compression?.tokenThreshold ?? ""), keep: String(compression?.keepLast ?? 4),
      history: String(compression?.historyMessages ?? "")
    }
  };
}

export function roomSettingsRevision(room) {
  return JSON.stringify([roomSettingsValues(room), room.speculation?.dailyLimit ?? null, room.revokedMemberIds ?? []]);
}

