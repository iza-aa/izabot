export interface Notices {
  refresh: string;
  action: string;
}

export interface PollFailure {
  ok: false;
  status?: number;
  message: string;
}

export function visibleNotice(notices: Notices): string {
  return notices.action || notices.refresh;
}

export function dismissNotice(notices: Notices): Notices {
  if (notices.action) return { ...notices, action: '' };
  if (notices.refresh) return { ...notices, refresh: '' };
  return notices;
}

export function applyRefreshResult(
  current: Notices,
  result: { ok: true } | PollFailure,
): Notices {
  if (result.ok) return current.refresh ? { ...current, refresh: '' } : current;
  if (result.status === 401) return current;
  if (current.refresh === result.message) return current;
  return { ...current, refresh: result.message };
}
