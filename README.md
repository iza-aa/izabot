# izabot

### Local-first AI coworkers for your Mac.

izabot is a desktop agent workspace built around **Spaces**, **Dots**, and a shared view of the apps you are working in. Each Space owns its Dots, bound apps, automations, and pages. Each Dot has a character, instructions, memory access, and a chat surface. The Dot editor stays deliberately small: name, character, role instructions, Space access, and memory.

## What is included

- **One navigation hierarchy: `SPACES ▸ Dots`.** No duplicate Dot sidebar.
- **Character creation.** Pick `Auto`, `Blue`, `Mint`, `Orange`, or `Purple`; `Auto` falls back to a deterministic color for older Dots.
- **Focused Dot editor.** Only name, character, role instructions, Space access, and memory are configurable. Automatic Learning and Connections/MCP are not part of the product surface.
- **Space Workplace.** Workers, bound Mac apps, scheduled tasks, and searchable pages in one view.
- **Desktop workspace.** A live window canvas, capture, cursor telemetry, and background input through the local desktop layer.
- **Text and voice.** Persistent chat plus optional realtime speech calls.
- **Scheduled activity.** Server-side turns that run in their original conversation.
- **Memories.** Explicit preferences plus learned app playbooks in one view.
- **Swarm delegation.** `delegate_to_dot` lets a parent Dot hand one objective to another Dot, with a hard depth limit and a bounded worker turn.
- **Owner-gated JIT scripting.** A Dot can request a script, but nothing runs until the owner reviews the exact code and approves it.

## Requirements

- macOS 14 or newer for desktop capture and input (the web workspace runs without them).
- Node.js 24 and npm.
- An OpenAI-compatible model endpoint for chat.
- Optional: voice provider credentials, desktop automation binaries, and local CUA/perception services.

## Get started

```sh
npm ci
cp .env.example .env
# Set OPENAI_API_KEY and OPENAI_MODEL in .env
npm run dev
```

Open **http://127.0.0.1:5173**. The API server runs on **http://127.0.0.1:4310** by default. `npm run dev` starts both the server and Vite.

For an external bind, set `HOST` and a 24+ character `OWNER_TOKEN`. The UI then requires the same owner token for API requests.

### Voice

Set `VOICE_API_KEY` and `VOICE_MODEL` to enable calls. Calls and text share the same Dot context and permissions.

### Desktop tools

The desktop layer uses macOS Accessibility and Screen Recording permissions. Configure the local CUA/perception paths in `.env.example` if the defaults do not match your install. The workspace shows a permission checklist with direct links to System Settings.

### JIT scripting

JIT is enabled by default and can be hidden with:

```sh
IZABOT_ENABLE_JIT=0
```

The approval flow is:

1. The Dot requests a script and the turn pauses with `approval_required`.
2. The owner runs `/jit-list` and reviews the exact code with `/jit-review <id>`.
3. The owner runs `/jit-approve <id>` or `/jit-deny <id>`.

Approvals are one-time, expire after one hour, and are scoped to the same owner, thread, Dot, and Space. The executor caps code at 20,000 characters, arguments at 4,000 characters, and runtime at 15 seconds. Scripts run as the macOS user and are **not** OS-sandboxed; exact-code review is the security boundary. Approvals are held in memory and are lost on server restart.

### Swarm delegation

A parent Dot can call `delegate_to_dot` with one objective. Workers are limited to depth 1, one delegation attempt per parent turn, four steps, a 55-second delegation budget, and a 45-second step timeout. Text-only workers do not inherit a desktop surface. Progress and the final delegated result appear in the parent transcript as a `Delegation Trace`.

## Quality checks

```sh
npm run typecheck
npm test
npm run build
```

`npm test` uses Vitest. The suite covers server boundaries, workspace persistence, delegation, JIT approvals, stream tickets, and client helpers.

## Architecture

- `src/server/` — Hono API, OMP ReAct adapter, swarm orchestrator, JIT approvals, workspace, voice, desktop tools, and window streaming.
- `src/client/` — React + TypeScript + Vite UI.
- `src-tauri/` — optional Tauri 2 desktop shell.
- `packages/perception-eye/` — Apple Vision OCR and window enumeration.
- `packages/mcp-bridge/` — MCP bridge for local tools.

See [ARCHITECTURE.md](ARCHITECTURE.md) for delegation, JIT, and stream security details, and [design.md](design.md) for the visual system.

## Data and privacy

The SQLite database stores Spaces, Dots, page metadata, thread bindings, app bindings, and preferences. App playbooks are stored under `data/app-memory/`. Conversation model calls go to the configured OpenAI-compatible provider. Voice receives data only when used. Do not put secrets in Memories or JIT scripts.

## License

MIT.
