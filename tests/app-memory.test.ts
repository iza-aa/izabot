import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  deleteAppMemory,
  listAppMemories,
} from '../src/server/app-memory.js';

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

it('lists learned app playbooks and forgets them one at a time', () => {
  const dir = mkdtempSync(join(tmpdir(), 'izabot-app-memory-'));
  dirs.push(dir);
  vi.stubEnv('APP_MEMORY_DIR', dir);
  writeFileSync(
    join(dir, 'com.apple.Safari.json'),
    JSON.stringify({
      app_metadata: { app_name: 'Safari', bundle_id: 'com.apple.Safari' },
      playbooks: [{ id: 'open' }, { id: 'search' }],
      reflexion_lessons: ['Reopen the window before typing.'],
    }),
  );
  writeFileSync(join(dir, 'broken.json'), 'not json');

  expect(listAppMemories()).toMatchObject([
    {
      key: 'com.apple.Safari',
      appName: 'Safari',
      bundleId: 'com.apple.Safari',
      playbooks: 2,
      lessons: 1,
    },
  ]);
  expect(deleteAppMemory('../escape')).toBe(false);
  expect(deleteAppMemory('com.apple.Safari')).toBe(true);
  expect(listAppMemories()).toEqual([]);
});
