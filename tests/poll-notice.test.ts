import { expect, it } from 'vitest';
import {
  applyRefreshResult,
  dismissNotice,
  visibleNotice,
  type Notices,
} from '../src/client/poll-notice';

const none: Notices = { refresh: '', action: '' };
const saved: Notices = { ...none, action: 'Could not save.' };

it('clears a recovered refresh error without wiping an action error', () => {
  const lost = applyRefreshResult(saved, {
    ok: false,
    message: 'Server returned an unreadable response.',
    status: 502,
  });
  expect(lost).toEqual({
    refresh: 'Server returned an unreadable response.',
    action: 'Could not save.',
  });
  expect(visibleNotice(lost)).toBe('Could not save.');
  expect(applyRefreshResult(lost, { ok: true })).toEqual(saved);
  expect(
    visibleNotice(
      applyRefreshResult({ ...none, refresh: 'Failed to fetch' }, { ok: true }),
    ),
  ).toBe('');
});

it('keeps an unauthorized poll from replacing the connection notice', () => {
  const current: Notices = { ...none, refresh: 'Failed to fetch' };
  expect(
    applyRefreshResult(current, {
      ok: false,
      status: 401,
      message: 'Enter your owner access token to unlock OpenDots.',
    }),
  ).toBe(current);
});

it('dismisses the visible notice and leaves the other', () => {
  const all: Notices = {
    refresh: 'Service unavailable.',
    action: 'Could not save.',
  };
  const first = dismissNotice(all);
  expect(first).toEqual({ ...all, action: '' });
  const second = dismissNotice(first);
  expect(second).toEqual(none);
  expect(dismissNotice(second)).toEqual(none);
});
