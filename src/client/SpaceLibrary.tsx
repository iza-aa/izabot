import { useMemo, useState } from 'react';
import {
  ArrowUpRight,
  Clock3,
  FileText,
  LayoutGrid,
  List,
  MessageCircle,
  MoreHorizontal,
  Plus,
  Search,
} from 'lucide-react';
import type { Page } from '../server/pages';
import type { Conversation, Dot, Space, Task } from '../shared/types';
import { Mascot } from './Mascot';

export function pageExcerpt(content: string) {
  return content
    .replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/^\s*(?:[-+*]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/gm, '')
    .replace(/```[\s\S]*?```/g, 'Code block')
    .replace(/!?\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[#>*_`|~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 150);
}

function scheduleLabel(seconds: number | null) {
  if (!seconds) return 'One-off';
  if (seconds >= 604800) return 'Weekly';
  if (seconds >= 86400) return `Every ${Math.round(seconds / 86400)}d`;
  if (seconds >= 3600) return `Every ${Math.round(seconds / 3600)}h`;
  return `Every ${Math.round(seconds / 60)}m`;
}

export function SpaceLibrary({
  space,
  pages,
  dots,
  tasks,
  taskThreads,
  conversations,
  onPage,
  onNew,
  onChat,
  onEditDot,
  onNewDot,
  onActivity,
}: {
  space: Space;
  pages: Page[];
  dots: Dot[];
  tasks: Task[];
  taskThreads: { taskId: string; threadId: string }[];
  conversations: Conversation[];
  onPage: (id: string) => void;
  onNew: () => void;
  onChat: (dotId: string) => void;
  onEditDot: (dot: Dot) => void;
  onNewDot: () => void;
  onActivity: () => void;
}) {
  const [query, setQuery] = useState('');
  const [layout, setLayout] = useState<'grid' | 'list'>('grid');
  const [sort, setSort] = useState('recent');
  const filtered = useMemo(
    () =>
      pages
        .filter((page) =>
          `${page.title} ${page.content}`
            .toLocaleLowerCase()
            .includes(query.toLocaleLowerCase()),
        )
        .sort((a, b) =>
          sort === 'name'
            ? a.title.localeCompare(b.title)
            : b.updatedAt - a.updatedAt || a.title.localeCompare(b.title),
        ),
    [pages, query, sort],
  );
  const spaceDotIds = new Set(dots.map((dot) => dot.id));
  const threadIds = new Set(
    conversations
      .filter((conversation) => spaceDotIds.has(conversation.dotId))
      .map((conversation) => conversation.id),
  );
  const automations = tasks.filter((task) =>
    taskThreads.some(
      (pair) => pair.taskId === task.id && threadIds.has(pair.threadId),
    ),
  );
  return (
    <section className="space-library" aria-label={`${space.name} workplace`}>
      <header className="library-heading">
        <div>
          <span className="library-eyebrow">SPACE WORKPLACE</span>
          <h1>{space.name}</h1>
          {space.description && <p>{space.description}</p>}
        </div>
        <button className="document-primary" onClick={onNew}>
          <Plus size={17} /> New page
        </button>
      </header>

      <div className="library-section-label">
        <h2>Workers</h2>
        <button className="text-button" onClick={onNewDot}>
          <Plus size={13} /> New Dot
        </button>
      </div>
      <div className="workplace-workers">
        {dots.map((dot) => (
          <article className="workplace-worker" key={dot.id}>
            <Mascot
              identity={dot.id}
              avatar={dot.avatar}
              name={dot.name}
              small
            />
            <div className="workplace-worker-body">
              <h3>{dot.name}</h3>
              <p>{dot.instructions}</p>
            </div>
            <div className="workplace-worker-actions">
              <button
                className="document-primary quiet"
                onClick={() => onChat(dot.id)}
              >
                <MessageCircle size={14} /> Chat
              </button>
              <button
                className="icon-button"
                aria-label={`Edit ${dot.name}`}
                onClick={() => onEditDot(dot)}
              >
                <MoreHorizontal size={15} />
              </button>
            </div>
          </article>
        ))}
        {!dots.length && (
          <div className="workplace-empty">
            No Dots work here yet.
            <button className="text-button" onClick={onNewDot}>
              Create the first one
            </button>
          </div>
        )}
      </div>

      <div className="library-section-label">
        <h2>Automations</h2>
        <span>
          {automations.length}{' '}
          {automations.length === 1 ? 'scheduled task' : 'scheduled tasks'}
        </span>
      </div>
      <div className="workplace-automations">
        {automations.slice(0, 4).map((task) => (
          <button
            className="workplace-automation"
            key={task.id}
            onClick={onActivity}
          >
            <Clock3 size={15} />
            <span>{task.prompt}</span>
            <small>
              {scheduleLabel(task.intervalSeconds)} · {task.status}
            </small>
          </button>
        ))}
        {!automations.length && (
          <div className="workplace-empty">
            Scheduled tasks started from this Space&apos;s chats appear here.
          </div>
        )}
        {automations.length > 0 && (
          <button className="text-button" onClick={onActivity}>
            View all activity <ArrowUpRight size={12} />
          </button>
        )}
      </div>

      <div className="library-section-label">
        <h2>Pages</h2>
        <span>
          {filtered.length} {filtered.length === 1 ? 'page' : 'pages'}
        </span>
      </div>
      <div className="library-tools">
        <label className="library-search">
          <Search size={17} />
          <input
            aria-label="Search pages"
            placeholder="Search pages"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <label className="library-sort">
          <span className="sr-only">Sort pages</span>
          <select
            aria-label="Sort pages"
            value={sort}
            onChange={(e) => setSort(e.target.value)}
          >
            <option value="recent">Recently edited</option>
            <option value="name">Name A–Z</option>
          </select>
        </label>
        <div
          className="library-view-toggle"
          role="group"
          aria-label="Library view"
        >
          <button
            aria-label="Grid view"
            aria-pressed={layout === 'grid'}
            onClick={() => setLayout('grid')}
          >
            <LayoutGrid size={17} />
          </button>
          <button
            aria-label="List view"
            aria-pressed={layout === 'list'}
            onClick={() => setLayout('list')}
          >
            <List size={18} />
          </button>
        </div>
      </div>
      {filtered.length ? (
        <div className={`library-pages ${layout}`}>
          {filtered.map((page) => (
            <button
              className="library-page-card"
              key={page.id}
              onClick={() => onPage(page.id)}
            >
              <span className="library-page-icon">
                <FileText size={20} strokeWidth={1.5} />
              </span>
              <div className="library-card-body">
                <h3>{page.title}</h3>
                <p>
                  {pageExcerpt(page.content) ||
                    'An empty page, ready to write.'}
                </p>
                <div className="library-page-meta">
                  <span title={new Date(page.updatedAt).toLocaleString()}>
                    Edited{' '}
                    {new Date(page.updatedAt).toLocaleDateString(undefined, {
                      month: 'short',
                      day: 'numeric',
                    })}
                  </span>
                  {page.parentId && (
                    <span className="library-parent">
                      {
                        pages.find((parent) => parent.id === page.parentId)
                          ?.title
                      }
                    </span>
                  )}
                </div>
              </div>
              <ArrowUpRight className="library-card-arrow" size={15} />
            </button>
          ))}
        </div>
      ) : (
        <div className="library-empty">
          <FileText size={30} strokeWidth={1.3} />
          <h2>{query ? 'No matching pages' : 'No pages yet'}</h2>
          <p>
            {query
              ? 'Try a different title or phrase.'
              : 'Create your first page to start organizing this Space.'}
          </p>
          {!query && (
            <button className="document-primary" onClick={onNew}>
              <Plus size={16} /> New page
            </button>
          )}
        </div>
      )}
    </section>
  );
}
