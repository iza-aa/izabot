import { openPageLink } from './page-navigation';
import { SpaceNav } from './SpaceNav';
import { SpaceWorkspace } from './SpaceWorkspace';
import { ConnectedAppWorkspace } from './ConnectedAppWorkspace';
import { MacPermissionChecklist } from './MacPermissionChecklist';
import { useCallback, useEffect, useState, useRef } from 'react';
import { CopilotKitProvider } from '@copilotkit/react-core/v2';
import {
  ArrowUp,
  ArrowUpRight,
  BookOpen,
  Clock3,
  Menu,
  MessageCircle,
  Monitor,
  MoreHorizontal,
  Pause,
  PanelLeft,
  Play,
  Plus,
  Search,
  Settings2,
  Trash2,
  X,
} from 'lucide-react';
import type {
  Conversation,
  Detail,
  Dot,
  State,
  WorkspaceState,
} from '../shared/types';
import { api, ApiError, authHeaders, setToken } from './api';
import {
  applyRefreshResult,
  dismissNotice,
  visibleNotice,
  type Notices,
} from './poll-notice';
import { Mascot } from './Mascot';
import { Chat } from './Chat';
import { ThreadList } from './ThreadList';
import { TaskRow } from './TaskPresentation';
import { TaskActions } from './TaskActions';
import { WorkspaceDialog, type Dialog } from './WorkspaceDialog';
import { submitComposerOnEnter } from './chat-composer';

function describeFailure(error: unknown, fallback: string) {
  return {
    ok: false as const,
    status: error instanceof ApiError ? error.status : undefined,
    message: error instanceof Error ? error.message : fallback,
  };
}

export function App() {
  const [state, setState] = useState<State>();
  const [workspace, setWorkspace] = useState<WorkspaceState>();
  const [selectedDot, setSelectedDot] = useState('');
  const [selectedThread, setSelectedThread] = useState<string>();
  const [view, rawSetView] = useState<'chat' | 'tasks' | 'memories' | 'space'>(
    'chat',
  );
  const dirtyPage = useRef(false);
  const [spaceId, setSpaceId] = useState('');
  const [pageId, setPageId] = useState<string>();
  const setDirtyPage = useCallback((value: boolean) => {
    dirtyPage.current = value;
  }, []);
  const setView = (next: typeof view) => {
    if (dirtyPage.current && !window.confirm('Leave your unsaved page draft?'))
      return;
    dirtyPage.current = false;
    if (next !== 'space')
      history.replaceState(null, '', location.pathname + location.search);
    rawSetView(next);
  };
  useEffect(() => {
    let acceptedHash = location.hash;
    const navigate = () => {
      const match = location.hash.match(
        /^#\/spaces\/([^/]+)(?:\/pages\/([^/]+))?$/,
      );
      if (!match) return;
      if (dirtyPage.current && location.hash === acceptedHash) return;
      if (
        dirtyPage.current &&
        !window.confirm('Leave your unsaved page draft?')
      ) {
        history.replaceState(null, '', acceptedHash || location.pathname);
        return;
      }
      acceptedHash = location.hash;
      dirtyPage.current = false;
      setSpaceId(match[1]);
      setPageId(match[2]);
      rawSetView('space');
      setMobile(false);
    };
    navigate();
    window.addEventListener('hashchange', navigate);
    return () => window.removeEventListener('hashchange', navigate);
  }, []);
  const openPage = (space: string, page?: string) => {
    openPageLink(`#/spaces/${space}${page ? `/pages/${page}` : ''}`);
  };

  const [notices, setNotices] = useState<Notices>({
    refresh: '',
    action: '',
  });
  const error = visibleNotice(notices);
  const setError = (action: string) =>
    setNotices((current) =>
      current.action === action ? current : { ...current, action },
    );
  const [auth, setAuth] = useState('');
  const [needsAuth, setNeedsAuth] = useState(false);
  const [dialog, setDialog] = useState<Dialog>();
  const [mobile, setMobile] = useState(false);
  const [navCollapsed, setNavCollapsed] = useState(false);
  const [pane, setPane] = useState(true);
  const [prompt, setPrompt] = useState('');
  const [pendingPrompt, setPendingPrompt] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState('');
  const [taskDetail, setTaskDetail] = useState<Detail>();
  const [scheduleDraft, setScheduleDraft] = useState<string>();
  const refresh = useCallback(async () => {
    try {
      const [s, w] = await Promise.all([
        api<State>('/state'),
        api<WorkspaceState>('/workspace'),
      ]);
      setState(s);
      setWorkspace(w);
      setNeedsAuth(false);
      setSelectedDot((previous) => previous || w.dots[0]?.id || '');
      setNotices((current) => applyRefreshResult(current, { ok: true }));
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setNeedsAuth(true);
      setNotices((current) =>
        applyRefreshResult(
          current,
          describeFailure(e, 'Could not connect to the server.'),
        ),
      );
    }
  }, []);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 3000);
    return () => clearInterval(timer);
  }, [refresh]);
  useEffect(() => {
    setTaskDetail(undefined);
    setScheduleDraft(undefined);
  }, [view]);
  const mutate = async (path: string, method: string, body?: unknown) => {
    setError('');
    try {
      await api(path, method, body);
      await refresh();
      if (taskDetail)
        setTaskDetail(await api<Detail>(`/tasks/${taskDetail.task.id}`));
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save.');
      return false;
    }
  };
  const dot =
    workspace?.dots.find((item) => item.id === selectedDot) ??
    workspace?.dots[0];
  const thread = workspace?.conversations.find(
    (item) => item.id === selectedThread && item.dotId === dot?.id,
  );
  const configured = !!workspace && workspace.setup.missing.length === 0;
  const chooseDot = (next: Dot) => {
    setSelectedDot(next.id);
    setSelectedThread(
      workspace?.conversations.find((item) => item.dotId === next.id)?.id,
    );
    setView('chat');
    setMobile(false);
    setPendingPrompt(undefined);
  };
  const newConversation = async (text?: string) => {
    if (!dot || !configured || busy) return;
    setBusy(true);
    setError('');
    try {
      const next = await api<Conversation>('/conversations', 'POST', {
        dotId: dot.id,
        title: text?.slice(0, 80) || 'A new thought',
      });
      await refresh();
      setSelectedThread(next.id);
      setPendingPrompt(text);
      setPrompt('');
      setView('chat');
      setMobile(false);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : 'Could not create the conversation.',
      );
    } finally {
      setBusy(false);
    }
  };
  if (needsAuth)
    return (
      <main className="unlock">
        <Mascot />
        <h1>Your own little corner.</h1>
        <p>Enter the owner access token for this server.</p>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setToken(auth);
            try {
              await api('/state');
              setError('');
              await refresh();
            } catch (err) {
              setError(
                err instanceof Error
                  ? err.message
                  : 'Access token was not accepted.',
              );
            }
          }}
        >
          <input
            type="password"
            aria-label="Owner access token"
            autoComplete="current-password"
            value={auth}
            onChange={(e) => setAuth(e.target.value)}
            required
          />
          <button className="primary">Unlock OpenDots</button>
        </form>
        {error && (
          <p className="chat-error" role="alert">
            {error}
          </p>
        )}
        <p className="muted">The token stays in this tab’s session storage.</p>
      </main>
    );
  if (!state || !workspace || !dot)
    return (
      <main className="unlock">
        <Mascot state="working" />
        <h1>Finding your dots…</h1>
        {error && (
          <>
            <p className="chat-error">{error}</p>
            <button onClick={() => void refresh()}>Retry</button>
          </>
        )}
      </main>
    );
  const content = (
    <div className={`app template-app ${navCollapsed ? 'nav-collapsed' : ''}`}>
      <button
        className="mobile-menu icon-button"
        aria-label="Open navigation"
        aria-expanded={mobile}
        aria-controls="workspace-sidebar"
        onClick={() => setMobile(true)}
      >
        <Menu size={21} />
      </button>
      {mobile && (
        <button
          className="nav-scrim"
          aria-label="Close navigation"
          onClick={() => setMobile(false)}
        />
      )}
      <aside
        id="workspace-sidebar"
        className={`sidebar ${mobile ? 'open' : ''}`}
      >
        <button
          className="wordmark"
          onClick={() => {
            setView('chat');
            setSelectedThread(undefined);
          }}
        >
          <span className="dotted-logo">
            <i />
            <i />
            <i />
            <i />
          </span>
          OpenDots<span className="wordmark-dot">•</span>
        </button>
        <button
          className="new-chat nav-item"
          disabled={!configured}
          onClick={() => void newConversation()}
        >
          <Plus size={17} />
          <span>New chat</span>
        </button>
        <div className="spaces-heading nav-label">
          SPACES
          <button
            className="icon-button"
            aria-label="Create Space"
            onClick={() => setDialog({ type: 'space' })}
          >
            <Plus size={14} />
          </button>
        </div>
        <nav className="spaces-nav" aria-label="Spaces">
          {workspace.spaces.map((space) => (
            <SpaceNav
              key={space.id}
              space={space}
              dots={workspace.dots.filter((item) =>
                item.spaceIds.includes(space.id),
              )}
              active={view === 'space' && spaceId === space.id}
              selectedDot={view === 'chat' ? dot.id : undefined}
              onOpen={() => openPage(space.id)}
              onDot={chooseDot}
              onEditDot={(item) =>
                setDialog({ type: 'dot', dot: item, spaceId: item.spaceId })
              }
              onNewDot={() => setDialog({ type: 'dot', spaceId: space.id })}
            />
          ))}
        </nav>
        {configured ? (
          <ThreadList
            dotId={dot.id}
            dots={workspace.dots}
            local={workspace.conversations}
            selected={view === 'chat' ? selectedThread : undefined}
            onSelect={(id) => {
              const conversation = workspace.conversations.find(
                (item) => item.id === id,
              );
              if (conversation) setSelectedDot(conversation.dotId);
              setSelectedThread(id);
              setView('chat');
              setMobile(false);
            }}
            onNew={() => void newConversation()}
          />
        ) : (
          <div className="sidebar-empty">
            Set up text chat to begin a persistent conversation.
          </div>
        )}
        <div className="sidebar-bottom">
          <button
            className={`nav-item ${view === 'tasks' ? 'active' : ''}`}
            onClick={() => {
              setView('tasks');
              setMobile(false);
            }}
          >
            <Clock3 size={17} />
            <span>Scheduled & activity</span>
            {state.tasks.length > 0 && <small>{state.tasks.length}</small>}
          </button>
          <button
            className={`nav-item ${view === 'memories' ? 'active' : ''}`}
            onClick={() => {
              setView('memories');
              setMobile(false);
            }}
          >
            <BookOpen size={17} />
            <span>Memories</span>
            {state.memories.length > 0 && (
              <small>{state.memories.length}</small>
            )}
          </button>
          <button
            className="nav-item"
            onClick={() => setDialog({ type: 'settings' })}
          >
            <Settings2 size={17} />
            <span>Settings</span>
          </button>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <button
            className="desktop-nav-toggle document-icon"
            aria-label={navCollapsed ? 'Show navigation' : 'Hide navigation'}
            onClick={() => setNavCollapsed(!navCollapsed)}
          >
            <PanelLeft size={18} />
          </button>
          <div className="breadcrumbs">
            <span>
              {view === 'space'
                ? (workspace.spaces.find((space) => space.id === spaceId)
                    ?.name ?? 'Spaces')
                : view === 'chat'
                  ? (workspace.spaces.find((space) => space.id === dot.spaceId)
                      ?.name ?? 'Spaces')
                  : 'Workspace'}
            </span>
            <span>/</span>
            <strong>
              {view === 'chat'
                ? dot.name
                : view === 'tasks'
                  ? 'Activity'
                  : view === 'space'
                    ? 'Workplace'
                    : 'Memories'}
            </strong>
          </div>
          <div className="top-actions">
            <button
              className="pause-button"
              aria-label={
                state.settings.paused ? 'Resume all Dots' : 'Pause all Dots'
              }
              onClick={() =>
                void mutate('/settings', 'PATCH', {
                  paused: !state.settings.paused,
                })
              }
            >
              {state.settings.paused ? <Play size={14} /> : <Pause size={14} />}
              <span>{state.settings.paused ? 'Resume' : 'Pause'}</span>
            </button>
            {view === 'chat' && (
              <button
                className="icon-button"
                aria-label={
                  pane ? 'Hide desktop workspace' : 'Show desktop workspace'
                }
                aria-expanded={pane}
                onClick={() => setPane(!pane)}
              >
                <Monitor size={18} />
              </button>
            )}
          </div>
        </header>
        {error && (
          <div className="error-banner" role="alert">
            <span>{error}</span>
            <button
              className="icon-button"
              aria-label="Dismiss error"
              onClick={() => setNotices((current) => dismissNotice(current))}
            >
              <X size={16} />
            </button>
          </div>
        )}
        {state.settings.paused && (
          <div className="notice">
            All Dots are paused. Active compute stops and scheduled tasks wait.
          </div>
        )}
        {view === 'space' ? (
          <SpaceWorkspace
            key={spaceId}
            space={
              workspace.spaces.find((s) => s.id === spaceId) ??
              workspace.spaces[0]
            }
            pageId={pageId}
            workspace={workspace}
            tasks={state.tasks}
            paused={state.settings.paused}
            onPage={(id) => openPage(spaceId, id)}
            onSettings={() => setDialog({ type: 'settings' })}
            onCreateDot={() => setDialog({ type: 'dot', spaceId })}
            onChat={(dotId) => {
              const target = workspace.dots.find((item) => item.id === dotId);
              if (target) chooseDot(target);
            }}
            onEditDot={(item) =>
              setDialog({ type: 'dot', dot: item, spaceId: item.spaceId })
            }
            onActivity={() => setView('tasks')}
            onDirty={setDirtyPage}
            onRefresh={refresh}
            onSchedule={(threadId) => setDialog({ type: 'schedule', threadId })}
            onThread={(id) => {
              const target = workspace.conversations.find((t) => t.id === id);
              if (target) {
                setView('chat');
                setSelectedDot(target.dotId);
                setSelectedThread(id);
              }
            }}
          />
        ) : view === 'chat' ? (
          <div className={`chat-workspace ${pane ? 'split' : ''}`}>
            <div className="chat-column">
              {thread && configured ? (
                <Chat
                  key={thread.id}
                  thread={thread}
                  dot={dot}
                  initialPrompt={pendingPrompt}
                  onConsumed={() => setPendingPrompt(undefined)}
                  voiceReady={workspace.setup.voice}
                  calls={workspace.calls.filter(
                    (call) => call.threadId === thread.id,
                  )}
                  paused={state.settings.paused}
                  onSaved={refresh}
                  onComputer={() => setPane(true)}
                  onSchedule={() =>
                    setDialog({ type: 'schedule', threadId: thread.id })
                  }
                />
              ) : (
                <div className="new-conversation">
                  <div className="empty-chat-persona">
                    <Mascot
                      identity={dot.id}
                      avatar={dot.avatar}
                      name={dot.name}
                      state={state.settings.paused ? 'paused' : 'idle'}
                    />
                    <h2>{dot.name}</h2>
                    <p>{dot.instructions}</p>
                    <button
                      className="text-button"
                      onClick={() =>
                        setDialog({ type: 'dot', dot, spaceId: dot.spaceId })
                      }
                    >
                      Edit Dot <MoreHorizontal size={14} />
                    </button>
                  </div>
                  <MacPermissionChecklist />
                  {!configured && (
                    <div className="setup-card">
                      <span className="setup-icon">
                        <Settings2 size={20} />
                      </span>
                      <div>
                        <strong>Connect your model</strong>
                        <p>
                          Add your model configuration in Settings to start
                          chatting. Spaces, Dots, and desktop control are ready
                          to use.
                        </p>
                        <button
                          className="text-button"
                          onClick={() => setDialog({ type: 'settings' })}
                        >
                          Open settings <ArrowUpRight size={12} />
                        </button>
                      </div>
                    </div>
                  )}
                  <form
                    className="composer"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void newConversation(prompt);
                    }}
                  >
                    <textarea
                      aria-label="Start a conversation"
                      placeholder={
                        configured
                          ? `Message ${dot.name}…`
                          : 'Your first conversation starts after setup.'
                      }
                      value={prompt}
                      maxLength={4000}
                      onChange={(e) => setPrompt(e.target.value)}
                      onKeyDown={(e) =>
                        submitComposerOnEnter(
                          e,
                          configured && !busy && !!prompt.trim(),
                        )
                      }
                      disabled={!configured}
                    />
                    <div className="composer-bottom">
                      <span>
                        <MessageCircle size={14} />
                        Text and calls, one continuing conversation
                      </span>
                      <button
                        className="send-button"
                        aria-label="Start conversation"
                        disabled={!configured || busy || !prompt.trim()}
                      >
                        <ArrowUp size={19} />
                      </button>
                    </div>
                  </form>
                  <div className="starter-suggestions">
                    {[
                      'Summarize what is on my screen',
                      'Organize the files on my Desktop',
                      'Draft a reply in Mail',
                    ].map((text) => (
                      <button
                        key={text}
                        disabled={!configured}
                        onClick={() => setPrompt(text)}
                      >
                        {text}
                        <ArrowUpRight size={12} />
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
            {pane && (
              <ConnectedAppWorkspace
                onClose={() => setPane(false)}
                boundApps={workspace.spaceApps
                  .filter((app) => app.spaceId === dot.spaceId)
                  .map((app) => app.appName)}
              />
            )}
          </div>
        ) : (
          <main className="main-content">
            <div className="page-heading">
              <div>
                <span className="eyebrow">YOUR WORKSPACE</span>
                <h1>
                  {view === 'memories'
                    ? 'Memories'
                    : 'A little follow-through.'}
                </h1>
                <p>
                  {view === 'memories'
                    ? 'Preferences you choose to share with your Dots.'
                    : 'Scheduled turns run on the server in their original conversation.'}
                </p>
              </div>
              {view === 'memories' && (
                <button
                  className="primary"
                  onClick={() => setDialog({ type: 'memory' })}
                >
                  <Plus size={15} />
                  Add memory
                </button>
              )}
            </div>
            {view === 'memories' ? (
              <>
                <div className="memory-grid">
                  {state.memories.map((memory) => (
                    <article className="memory-card" key={memory.id}>
                      <BookOpen size={18} />
                      <p>{memory.text}</p>
                      <div>
                        <small>
                          {state.settings.memoryAllowed
                            ? 'Available to permitted Dots'
                            : 'Memory use disabled'}
                        </small>
                        <button
                          className="icon-button"
                          aria-label="Edit memory"
                          onClick={() => setDialog({ type: 'memory', memory })}
                        >
                          <MoreHorizontal size={17} />
                        </button>
                        <button
                          className="icon-button"
                          aria-label="Delete memory"
                          onClick={() =>
                            void mutate(`/memories/${memory.id}`, 'DELETE', {})
                          }
                        >
                          <Trash2 size={15} />
                        </button>
                      </div>
                    </article>
                  ))}
                </div>
                {!state.memories.length && (
                  <div className="large-empty">
                    <Mascot />
                    <h2>A little context goes a long way.</h2>
                    <p>
                      Add a preference like “Keep replies short and concrete.”
                      You can change or remove it anytime.
                    </p>
                  </div>
                )}
              </>
            ) : (
              <>
                <label className="search-box">
                  <Search size={16} />
                  <input
                    aria-label="Search tasks"
                    placeholder="Find a task…"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </label>
                <div className="task-list">
                  {state.tasks
                    .filter((task) =>
                      task.prompt.toLowerCase().includes(search.toLowerCase()),
                    )
                    .map((task) => (
                      <TaskRow
                        key={task.id}
                        task={task}
                        onClick={() =>
                          void api<Detail>(`/tasks/${task.id}`)
                            .then(setTaskDetail)
                            .catch((e) => setError(e.message))
                        }
                      />
                    ))}
                </div>
                {!state.tasks.length && (
                  <div className="large-empty">
                    <Clock3 size={32} />
                    <h2>Let a thought come back around.</h2>
                    <p>
                      Open a conversation and use the clock button to schedule a
                      server-side task.
                    </p>
                  </div>
                )}
                {taskDetail && (
                  <section className="task-detail-card">
                    <h2>{taskDetail.task.prompt}</h2>
                    <TaskActions
                      task={taskDetail.task}
                      busy={busy}
                      settings={state.settings}
                      onAction={(action) =>
                        void mutate(
                          `/tasks/${taskDetail.task.id}/actions`,
                          'POST',
                          { action },
                        )
                      }
                      onSchedule={() =>
                        setScheduleDraft(
                          String((taskDetail.task.intervalSeconds ?? 0) / 60),
                        )
                      }
                    />
                    {scheduleDraft !== undefined && (
                      <div className="schedule-inline">
                        <label htmlFor="task-interval">
                          Repeat interval (minutes, 0 removes the schedule)
                        </label>
                        <input
                          id="task-interval"
                          type="number"
                          min={0}
                          value={scheduleDraft}
                          onChange={(e) => setScheduleDraft(e.target.value)}
                        />
                        <button
                          className="primary"
                          onClick={async () => {
                            const value = Number(scheduleDraft);
                            if (!Number.isFinite(value) || value < 0) {
                              setError('Enter a valid number of minutes.');
                              return;
                            }
                            const saved = await mutate(
                              `/tasks/${taskDetail.task.id}/schedule`,
                              'PUT',
                              {
                                intervalSeconds: value
                                  ? Math.round(value * 60)
                                  : null,
                              },
                            );
                            if (saved) setScheduleDraft(undefined);
                          }}
                        >
                          Save schedule
                        </button>
                        <button onClick={() => setScheduleDraft(undefined)}>
                          Cancel
                        </button>
                      </div>
                    )}
                    {taskDetail.task.error && (
                      <p className="chat-error">{taskDetail.task.error}</p>
                    )}
                    {taskDetail.events.slice(-6).map((event) => (
                      <p className="muted" key={event.id}>
                        {event.text}
                      </p>
                    ))}
                    <small>{taskDetail.runs.length} saved runs</small>
                  </section>
                )}
              </>
            )}
          </main>
        )}
      </div>
      {dialog && (
        <WorkspaceDialog
          dialog={dialog}
          state={state}
          workspace={workspace}
          onClose={() => setDialog(undefined)}
          mutate={mutate}
        />
      )}
    </div>
  );
  return configured ? (
    <CopilotKitProvider
      runtimeUrl="/api/copilotkit"
      headers={authHeaders()}
      showDevConsole={false}
    >
      {content}
    </CopilotKitProvider>
  ) : (
    content
  );
}
