import { afterEach, expect, it, vi } from 'vitest';
import { Store } from '../src/server/store.js';
import { Runner } from '../src/server/runner.js';
afterEach(() => vi.unstubAllGlobals());
it('records generic scheduled runs without research wording', async () => {
  const store = new Store(':memory:');
  const prompt = 'Draft a welcome email.';
  const result = { text: 'A concise welcome email.' };
  const execute = vi.fn(async () => result);
  const runner = new Runner(store, execute);
  const task = store.createTask(prompt);

  try {
    await runner.tick();

    const detail = store.detail(task.id)!;
    expect(detail.task.prompt).toBe(prompt);
    expect(detail.runs[0].result).toEqual(result);
    expect(detail.events.map((event) => event.text)).toEqual([
      'Task added to the queue.',
      'Run started.',
      'Run completed.',
    ]);
    expect(execute).toHaveBeenCalledOnce();
  } finally {
    runner.stop();
    store.close();
  }
});
it('aborts active work when permissions are revoked outside the runner instance', async () => {
  const store = new Store(':memory:');
  let runSignal: AbortSignal | undefined;
  const runner = new Runner(store, (_claim, _memories, signal) => {
    runSignal = signal;
    return new Promise((_resolve, reject) =>
      signal.addEventListener('abort', () => reject(signal.reason), {
        once: true,
      }),
    );
  });
  store.createTask('Review the open pull request');
  const tick = runner.tick();
  await vi.waitFor(() => expect(runSignal).toBeDefined());
  store.updateSettings({ memoryAllowed: false });
  await tick;
  expect(runSignal?.aborted).toBe(true);
  expect(store.tasks()[0].status).toBe('interrupted');
  runner.stop();
  store.close();
});
it('holds active work for review on graceful shutdown', async () => {
  const store = new Store(':memory:');
  let runSignal: AbortSignal | undefined;
  const runner = new Runner(store, (_claim, _memories, signal) => {
    runSignal = signal;
    return new Promise((_resolve, reject) =>
      signal.addEventListener('abort', () => reject(signal.reason), {
        once: true,
      }),
    );
  });
  store.createTask('Review the open pull request');
  const pending = runner.tick();
  await vi.waitFor(() => expect(runSignal).toBeDefined());
  runner.stop();
  await pending;
  expect(store.tasks()[0].status).toBe('interrupted');
  expect(store.claim()).toBeNull();
  store.action(store.tasks()[0].id, 'run');
  expect(store.claim()).toBeTruthy();
  store.close();
});
it('survives a claim failure and runs work on the next tick', async () => {
  const store = new Store(':memory:');
  const runner = new Runner(store, async () => ({ text: 'Done.' }));
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  const claim = vi.spyOn(store, 'claim').mockImplementationOnce(() => {
    throw new Error('SQLITE_BUSY');
  });
  const task = store.createTask('Review the open pull request');
  try {
    await expect(runner.tick()).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledOnce();
    await runner.tick();
    expect(claim).toHaveBeenCalledTimes(2);
    expect(store.detail(task.id)?.runs[0].result).toBeTruthy();
  } finally {
    log.mockRestore();
    store.close();
  }
});
it('survives failure persistence errors and clears active work', async () => {
  const store = new Store(':memory:');
  const execute = vi
    .fn()
    .mockRejectedValueOnce(new Error('Provider failure'))
    .mockResolvedValueOnce({ text: 'Recovered' });
  const runner = new Runner(store, execute);
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  const fail = vi.spyOn(store, 'fail').mockImplementationOnce(() => {
    throw new Error('SQLITE_BUSY');
  });
  store.createTask('First');
  try {
    await expect(runner.tick()).resolves.toBeUndefined();
    expect(fail).toHaveBeenCalledOnce();
    store.createTask('Second');
    await runner.tick();
    expect(execute).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledOnce();
  } finally {
    log.mockRestore();
    store.close();
  }
});
it('aborts work instead of throwing from an ownership timer', async () => {
  const store = new Store(':memory:');
  store.createTask('First');
  const runner = new Runner(
    store,
    (_claim, _memories, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), {
          once: true,
        });
      }),
  );
  vi.spyOn(store, 'owns').mockImplementationOnce(() => {
    throw new Error('Database unavailable');
  });
  try {
    await expect(runner.tick()).resolves.toBeUndefined();
    expect(store.tasks()[0].status).toBe('failed');
  } finally {
    store.close();
  }
});
