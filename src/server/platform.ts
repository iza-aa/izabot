import { ComputerService } from './computer-service.js';
import { PageService } from './page-service.js';
import { randomUUID } from 'node:crypto';
import {
  CopilotKitIntelligence,
  CopilotRuntime,
  createCopilotHonoHandler,
  type CopilotHonoApp,
} from '@copilotkit/runtime/v2';
import { Store } from './store.js';
import { WorkspaceStore } from './workspace.js';
import { DotAgent } from './dot-agent.js';
import { runThreadTurn } from './headless.js';
import { setupStatus, type PlatformConfig } from './platform-config.js';
import { validateRuntimeScope } from './runtime-scope.js';
export class Platform {
  readonly pages: PageService;
  readonly computers: ComputerService;
  readonly intelligence?: CopilotKitIntelligence;
  readonly handler?: CopilotHonoApp;
  constructor(
    readonly store: Store,
    readonly workspace: WorkspaceStore,
    readonly config: PlatformConfig,
  ) {
    this.computers = new ComputerService(
      workspace,
      config,
      () => store.settings().paused,
    );
    this.pages = new PageService(workspace, () => {
      this.requireReady();
      return this.intelligence!;
    });
    if (!config.intelligenceKey) return;
    this.intelligence = new CopilotKitIntelligence({
      apiKey: config.intelligenceKey,
      apiUrl: config.intelligenceApiUrl,
      wsUrl: config.intelligenceWsUrl,
    });
    const runtime = new CopilotRuntime({
      intelligence: this.intelligence,
      identifyUser: async () => ({
        id: workspace.ownerId,
        name: 'izabot owner',
      }),
      agents: async (_ctx: any) =>
        Object.fromEntries(
          workspace
            .dots()
            .map((dot) => [
              dot.id,
              new DotAgent(store, workspace, config, dot.id),
            ]),
        ) as any,
      generateThreadNames: true,
    });
    this.handler = createCopilotHonoHandler({
      runtime,
      basePath: '/api/copilotkit',
      cors: { origin: [] },
    });
  }
  setup() {
    return setupStatus(this.config);
  }
  requireReady() {
    if (!this.config.intelligenceKey && this.config.apiKey) return;
    const missing = this.setup().missing;
    if (missing.length)
      throw new Error(
        `Setup required: ${missing.join(', ')}. Conversations require CopilotKit Intelligence.`,
      );
  }
  async start() {
    // No external channels are configured.
  }
  async stop() {
    // No external channels are configured.
  }
  async createConversation(dotId: string, title: string) {
    this.requireReady();
    if (!this.workspace.dot(dotId)) throw new Error('Dot not found.');
    const id = randomUUID();
    if (this.intelligence) {
      try {
        await this.intelligence.createThread({
          threadId: id,
          userId: this.workspace.ownerId,
          agentId: dotId,
          name: title,
        });
      } catch {
        throw new Error(
          'Intelligence could not create this conversation. Check the runtime key and connection.',
        );
      }
    }
    return this.workspace.bindThread(id, dotId, title);
  }
  async history(threadId: string): Promise<string> {
    this.requireReady();
    this.workspace.requireThread(threadId);
    if (!this.intelligence) return '';
    const history = await this.intelligence.getThreadMessages({
      threadId,
      userId: this.workspace.ownerId,
    });
    return history.messages
      .filter((message) => ['user', 'assistant'].includes(message.role))
      .slice(-12)
      .map(
        (message) =>
          `${message.role}: ${typeof message.content === 'string' ? message.content : ''}`,
      )
      .join('\n')
      .slice(-12000);
  }
  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.endsWith('/info')) {
      const agents = Object.fromEntries(
        this.workspace.dots().map((d) => [
          d.id,
          {
            name: d.name,
            description: d.instructions,
            className: 'DotAgent',
          },
        ]),
      );
      return Response.json({
        version: '1.78.0',
        agents,
        audioFileTranscriptionEnabled: false,
        mode: 'live',
        threadEndpoints: {
          list: Boolean(this.handler),
          inspect: Boolean(this.handler),
          mutations: false,
          realtimeMetadata: false,
        },
        suggestions: true,
        a2uiEnabled: false,
        openGenerativeUIEnabled: false,
        telemetryDisabled: true,
      });
    }
    if (!this.handler) {
      // The SDK still probes the thread list even when no remote runtime is
      // configured. Return the empty shape so its reducer does not receive an
      // object where it expects an array.
      if (url.pathname.endsWith('/threads')) {
        return Response.json({
          threads: [],
          nextCursor: null,
          hasMore: false,
        });
      }
      return Response.json({ ok: true });
    }
    let body: unknown;
    if (request.method !== 'GET' && request.method !== 'HEAD')
      body = await request
        .clone()
        .json()
        .catch(() => null);
    try {
      validateRuntimeScope(request, this.workspace, body);
    } catch (error) {
      return Response.json(
        {
          error:
            error instanceof Error
              ? error.message
              : 'Conversation scope denied.',
        },
        { status: 403 },
      );
    }
    return this.handler.fetch(request);
  }
  async turn(
    threadId: string,
    prompt: string,
    signal: AbortSignal,
    metadata?: Record<string, unknown>,
  ): Promise<string> {
    this.requireReady();
    const thread = this.workspace.requireThread(threadId);
    return runThreadTurn(
      this.config.runtimeUrl,
      this.config.ownerToken
        ? { Authorization: `Bearer ${this.config.ownerToken}` }
        : {},
      thread.dotId,
      threadId,
      prompt,
      signal,
      metadata,
    );
  }
}
