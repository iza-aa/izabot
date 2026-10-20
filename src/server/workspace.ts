import { ComputerStore } from './computer-store.js';
import { Pages } from './pages.js';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  CallReceipt,
  Conversation,
  Dot,
  DotAvatar,
  Space,
  SpaceApp,
} from '../shared/types.js';
export class WorkspaceStore {
  private db: DatabaseSync;
  readonly pages: Pages;
  readonly computers: ComputerStore;
  constructor(
    path: string,
    readonly ownerId: string,
  ) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS spaces(id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, createdAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS space_apps(spaceId TEXT NOT NULL, appName TEXT NOT NULL, bundleId TEXT, createdAt INTEGER NOT NULL, PRIMARY KEY(spaceId, appName));
      CREATE TABLE IF NOT EXISTS dots(id TEXT PRIMARY KEY, spaceId TEXT NOT NULL, name TEXT NOT NULL, instructions TEXT NOT NULL, memoryAllowed INTEGER NOT NULL, createdAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS thread_bindings(id TEXT PRIMARY KEY, dotId TEXT NOT NULL, ownerId TEXT NOT NULL, title TEXT NOT NULL, createdAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS task_threads(taskId TEXT PRIMARY KEY, threadId TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS calls(id TEXT PRIMARY KEY, threadId TEXT NOT NULL, startedAt INTEGER NOT NULL, endedAt INTEGER, status TEXT NOT NULL, transcript TEXT NOT NULL, error TEXT);`);
    for (const [table, column, definition] of [['dots', 'avatar', 'TEXT']]) {
      if (
        !this.db
          .prepare(`PRAGMA table_info(${table})`)
          .all()
          .some((field) => field.name === column)
      )
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
    // Research was removed; drop its leftovers from databases created earlier.
    if (
      this.db
        .prepare('PRAGMA table_info(dots)')
        .all()
        .some((field) => field.name === 'researchAllowed')
    )
      this.db.exec('ALTER TABLE dots DROP COLUMN researchAllowed');
    this.db.exec('DROP TABLE IF EXISTS captures');
    // Migrate only once: restarting must never restore a revoked grant.
    if (
      !this.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='dot_spaces'",
        )
        .get()
    ) {
      this.db.exec(`BEGIN;
        CREATE TABLE dot_spaces(dotId TEXT NOT NULL, spaceId TEXT NOT NULL, PRIMARY KEY(dotId, spaceId));
        INSERT INTO dot_spaces SELECT id, spaceId FROM dots;
        COMMIT;`);
    }
    this.computers = new ComputerStore(this.db);
    this.pages = new Pages(this.db, (id) =>
      this.spaces().some((space) => space.id === id),
    );
    if (
      !this.db
        .prepare('PRAGMA table_info(calls)')
        .all()
        .some((column) => column.name === 'anchorMessageId')
    )
      this.db.exec('ALTER TABLE calls ADD COLUMN anchorMessageId TEXT');
    if (!this.spaces().length) {
      const space = this.createSpace(
        'Everyday',
        'A little space for your day.',
      );
      this.createDot(
        space.id,
        'Dot',
        'Be thoughtful, practical, and concise. Help the user think clearly and follow through.',
        true,
      );
    }
  }
  close() {
    this.db.close();
  }
  spaces(): Space[] {
    return this.db
      .prepare('SELECT * FROM spaces ORDER BY createdAt')
      .all() as unknown as Space[];
  }
  spaceApps(spaceId?: string): SpaceApp[] {
    return this.db
      .prepare(
        `SELECT * FROM space_apps ${spaceId ? 'WHERE spaceId=?' : ''} ORDER BY createdAt, appName`,
      )
      .all(...(spaceId ? [spaceId] : [])) as unknown as SpaceApp[];
  }
  bindSpaceApp(spaceId: string, appName: string, bundleId?: string | null) {
    if (!this.spaces().some((space) => space.id === spaceId))
      throw new Error('Space not found.');
    this.db
      .prepare('INSERT OR REPLACE INTO space_apps VALUES (?, ?, ?, ?)')
      .run(spaceId, appName, bundleId ?? null, Date.now());
    return this.spaceApps(spaceId).find((app) => app.appName === appName)!;
  }
  unbindSpaceApp(spaceId: string, appName: string) {
    return (
      this.db
        .prepare('DELETE FROM space_apps WHERE spaceId=? AND appName=?')
        .run(spaceId, appName).changes > 0
    );
  }
  createSpace(name: string, description: string): Space {
    const space = {
      id: randomUUID(),
      name,
      description,
      createdAt: Date.now(),
    };
    this.db
      .prepare('INSERT INTO spaces VALUES (?, ?, ?, ?)')
      .run(space.id, name, description, space.createdAt);
    return space;
  }
  dots(): Dot[] {
    return this.db
      .prepare('SELECT * FROM dots ORDER BY createdAt')
      .all()
      .map((row) => ({
        ...row,
        spaceIds: this.db
          .prepare(
            'SELECT spaceId FROM dot_spaces WHERE dotId=? ORDER BY spaceId',
          )
          .all(String(row.id))
          .map((grant) => String(grant.spaceId)),
        memoryAllowed: !!row.memoryAllowed,
      })) as unknown as Dot[];
  }
  dot(id: string) {
    return this.dots().find((dot) => dot.id === id);
  }
  createDot(
    spaceId: string,
    name: string,
    instructions: string,
    memoryAllowed: boolean,
    spaceIds: string[] = [spaceId],
    avatar: DotAvatar | null = null,
  ): Dot {
    this.validateSpaceAccess(spaceId, spaceIds);
    const dot: Dot = {
      id: randomUUID(),
      spaceId,
      spaceIds: [...new Set(spaceIds)].sort(),
      name,
      instructions,
      memoryAllowed,
      avatar,
      createdAt: Date.now(),
    };
    this.db.exec('BEGIN');
    try {
      this.db
        .prepare(
          'INSERT INTO dots (id, spaceId, name, instructions, memoryAllowed, createdAt, avatar) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          dot.id,
          spaceId,
          name,
          instructions,
          +memoryAllowed,
          dot.createdAt,
          avatar,
        );
      for (const id of dot.spaceIds)
        this.db.prepare('INSERT INTO dot_spaces VALUES (?, ?)').run(dot.id, id);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return dot;
  }
  canAccessSpace(dotId: string, spaceId: string) {
    return !!this.db
      .prepare('SELECT 1 FROM dot_spaces WHERE dotId=? AND spaceId=?')
      .get(dotId, spaceId);
  }
  private validateSpaceAccess(defaultSpace: string, spaceIds: string[]) {
    if (
      !spaceIds.includes(defaultSpace) ||
      spaceIds.some((id) => !this.spaces().some((space) => space.id === id))
    )
      throw new Error('Space access must include a valid default destination.');
  }
  updateDot(
    id: string,
    patch: Pick<Dot, 'name' | 'instructions' | 'memoryAllowed'> & {
      spaceId?: string;
      spaceIds?: string[];
      avatar?: DotAvatar | null;
    },
  ): Dot {
    const current = this.dot(id);
    if (!current) throw new Error('Dot not found.');
    const defaultSpace = patch.spaceId ?? current.spaceId;
    const spaceIds = patch.spaceIds ?? current.spaceIds;
    this.validateSpaceAccess(defaultSpace, spaceIds);
    const avatar =
      patch.avatar === undefined ? (current.avatar ?? null) : patch.avatar;
    this.db.exec('BEGIN');
    try {
      this.db
        .prepare(
          'UPDATE dots SET name=?, instructions=?, memoryAllowed=?, avatar=? WHERE id=?',
        )
        .run(patch.name, patch.instructions, +patch.memoryAllowed, avatar, id);
      this.db
        .prepare('UPDATE dots SET spaceId=? WHERE id=?')
        .run(defaultSpace, id);
      this.db.prepare('DELETE FROM dot_spaces WHERE dotId=?').run(id);
      for (const space of new Set(spaceIds))
        this.db.prepare('INSERT INTO dot_spaces VALUES (?, ?)').run(id, space);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return this.dot(id)!;
  }
  conversations(): Conversation[] {
    return this.db
      .prepare(
        'SELECT * FROM thread_bindings WHERE ownerId=? ORDER BY createdAt DESC',
      )
      .all(this.ownerId) as unknown as Conversation[];
  }
  bindThread(id: string, dotId: string, title: string): Conversation {
    const dot = this.dot(dotId);
    if (!dot) throw new Error('Dot not found.');
    const value: Conversation = {
      id,
      dotId,
      ownerId: this.ownerId,
      title,
      createdAt: Date.now(),
    };
    this.db
      .prepare(
        'INSERT INTO thread_bindings (id, dotId, ownerId, title, createdAt) VALUES (?, ?, ?, ?, ?)',
      )
      .run(id, dotId, this.ownerId, title, value.createdAt);
    return value;
  }
  requireThread(id: string, dotId?: string): Conversation {
    const thread = this.conversations().find((thread) => thread.id === id);
    if (!thread || (dotId && thread.dotId !== dotId))
      throw new Error('Conversation does not belong to this Dot and owner.');
    return thread;
  }
  bindTask(taskId: string, threadId: string) {
    this.requireThread(threadId);
    this.db
      .prepare('INSERT INTO task_threads VALUES (?, ?)')
      .run(taskId, threadId);
  }
  taskThread(taskId: string): string | undefined {
    const row = this.db
      .prepare('SELECT threadId FROM task_threads WHERE taskId=?')
      .get(taskId);
    return typeof row?.threadId === 'string' ? row.threadId : undefined;
  }
  taskThreads(): { taskId: string; threadId: string }[] {
    return this.db
      .prepare('SELECT taskId, threadId FROM task_threads')
      .all() as unknown as { taskId: string; threadId: string }[];
  }
  calls(threadId?: string): CallReceipt[] {
    if (threadId) this.requireThread(threadId);
    return this.db
      .prepare(
        `SELECT * FROM calls ${threadId ? 'WHERE threadId=?' : ''} ORDER BY startedAt DESC`,
      )
      .all(...(threadId ? [threadId] : [])) as unknown as CallReceipt[];
  }
  createCall(threadId: string): CallReceipt {
    this.requireThread(threadId);
    const call: CallReceipt = {
      id: randomUUID(),
      threadId,
      startedAt: Date.now(),
      endedAt: null,
      status: 'connecting',
      transcript: '',
      error: null,
    };
    this.db
      .prepare(
        'INSERT INTO calls(id, threadId, startedAt, endedAt, status, transcript, error) VALUES (?, ?, ?, NULL, ?, ?, NULL)',
      )
      .run(call.id, threadId, call.startedAt, call.status, '');
    return call;
  }
  call(id: string): CallReceipt {
    const call = this.calls().find((call) => call.id === id);
    if (!call) throw new Error('Call not found.');
    this.requireThread(call.threadId);
    return call;
  }
  setCall(
    id: string,
    status: CallReceipt['status'],
    transcript: string,
    error: string | null = null,
  ) {
    const call = this.call(id);
    if (call.endedAt) return call;
    this.db
      .prepare(
        'UPDATE calls SET status=?, transcript=?, error=?, endedAt=? WHERE id=?',
      )
      .run(
        status,
        transcript,
        error,
        status === 'ended' || status === 'failed' ? Date.now() : null,
        id,
      );
    return this.call(id);
  }
  saveLateTranscript(id: string, transcript: string) {
    this.call(id);
    return (
      this.db
        .prepare(
          "UPDATE calls SET transcript=? WHERE id=? AND transcript='' AND endedAt IS NOT NULL",
        )
        .run(transcript, id).changes > 0
    );
  }
  anchorCall(id: string, anchor: string | undefined) {
    this.call(id);
    this.db
      .prepare('UPDATE calls SET anchorMessageId=? WHERE id=?')
      .run(anchor ?? null, id);
  }
  setCallError(id: string, error: string | null) {
    this.call(id);
    this.db.prepare('UPDATE calls SET error=? WHERE id=?').run(error, id);
  }
}
