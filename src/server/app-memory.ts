// SPDX-License-Identifier: MIT
// Hierarchical Graph & Action Macro (H-GAM) Persistent App Memory Engine

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

export type SafetyTier = 'SAFE_READONLY' | 'MUTATING_REVERSIBLE' | 'DESTRUCTIVE_OR_SENSITIVE';

export interface AppMetadata {
  bundle_id: string;
  app_name: string;
  surface_kind: 'native_app' | 'web_browser';
  framework_hint?: string;
  last_verified_version?: string;
  updated_at: number;
}

export interface SafetyPolicy {
  blocked_exploration_patterns: string[];
  require_confirmation_roles: string[];
  require_confirmation_keywords: string[];
}

export interface AnchorSelector {
  role?: string;
  subrole?: string;
  label_contains?: string[];
  index_in_zone?: number;
}

export interface Anchor {
  id: string;
  description: string;
  zone: 'TOP_HEADER' | 'LEFT_SIDEBAR' | 'MAIN_STAGE' | 'BOTTOM_COMPOSER' | 'MODAL_CENTER' | string;
  safety_tier: SafetyTier;
  ax_selectors?: AnchorSelector[];
  ocr_keywords?: string[];
  shortcut_fallback?: string[];
  norm_coords?: { u: number; v: number; radius_tolerance: number };
  confidence: number;
  stats: { success_count: number; fail_count: number; last_healed_at: number | null };
}

export interface AppState {
  id: string;
  description: string;
  detection_rules: {
    required_anchors?: string[];
    forbidden_anchors?: string[];
    focused_anchor?: string;
    ocr_signature_any?: string[];
  };
}

export interface AppTransition {
  from_state: string;
  to_state: string;
  action_type: string;
  target_anchor?: string;
  hotkey?: string[];
  submit_key?: string;
  cost?: number;
}

export interface PlaybookStep {
  step: number;
  op: string;
  zone?: string;
  dynamic_query?: string;
  anchor_id?: string;
  text?: string;
  submit_with_enter?: boolean;
  prefer_hotkey?: string[];
  expected_state?: string;
  on_miss_goto_step?: number;
  on_hit_goto_step?: number;
}

export interface Playbook {
  id: string;
  name: string;
  trigger_intents: string[];
  parameters: string[];
  precondition_states: string[];
  expected_final_state: string;
  steps: PlaybookStep[];
}

export interface AppMemoryDocument {
  schema_version: string;
  app_metadata: AppMetadata;
  safety_policy: SafetyPolicy;
  anchors: Record<string, Anchor>;
  states: Record<string, AppState>;
  transitions: AppTransition[];
  playbooks: Playbook[];
  reflexion_lessons?: string[];
}

export function getMemoryDir(): string {
  return path.resolve(process.env.APP_MEMORY_DIR ?? 'data/app-memory');
}

const APP_ALIAS_MAP: Record<string, string> = {
  whatsapp: 'net.whatsapp.WhatsApp',
  safari: 'com.apple.Safari',
  chrome: 'com.google.Chrome',
  spotify: 'com.spotify.client',
  telegram: 'ru.keepcoder.Telegram',
  slack: 'com.tinyspeck.slackmacgap',
};

export function resolveMemoryFilename(appNameOrBundle: string): string {
  const lower = appNameOrBundle.toLowerCase().trim();
  const bundleId = APP_ALIAS_MAP[lower] ?? appNameOrBundle;
  return path.join(getMemoryDir(), `${bundleId}.json`);
}

export function loadAppMemory(appNameOrBundle: string): AppMemoryDocument | null {
  try {
    const filePath = resolveMemoryFilename(appNameOrBundle);
    if (!existsSync(filePath)) {
      // Also try raw app name
      const altPath = path.join(getMemoryDir(), `${appNameOrBundle}.json`);
      if (!existsSync(altPath)) return null;
      const raw = readFileSync(altPath, 'utf-8');
      return JSON.parse(raw) as AppMemoryDocument;
    }
    const raw = readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as AppMemoryDocument;
  } catch (err: unknown) {
    console.error(`[AppMemory] Failed to load memory for ${appNameOrBundle}:`, err);
    return null;
  }
}

export function saveAppMemory(memory: AppMemoryDocument): void {
  try {
    const memoryDir = getMemoryDir();
    if (!existsSync(memoryDir)) {
      mkdirSync(memoryDir, { recursive: true });
    }
    const filePath = path.join(memoryDir, `${memory.app_metadata.bundle_id}.json`);
    writeFileSync(filePath, JSON.stringify(memory, null, 2), 'utf-8');
  } catch (err: unknown) {
    console.error(`[AppMemory] Failed to save memory for ${memory.app_metadata.bundle_id}:`, err);
  }
}

export function detectCurrentAppState(
  memory: AppMemoryDocument,
  observedLabels: string[],
): string {
  const lowerLabels = observedLabels.map((l) => l.toLowerCase());

  for (const [stateId, stateDef] of Object.entries(memory.states)) {
    const rules = stateDef.detection_rules;

    // Check forbidden anchors/keywords
    if (rules.forbidden_anchors && rules.forbidden_anchors.length > 0) {
      const hasForbidden = rules.forbidden_anchors.some((anchorId) => {
        const anchor = memory.anchors[anchorId];
        if (!anchor) return false;
        return (anchor.ocr_keywords ?? []).some((kw) =>
          lowerLabels.some((l) => l.includes(kw.toLowerCase())),
        );
      });
      if (hasForbidden) continue;
    }

    // Check required anchors/keywords
    if (rules.ocr_signature_any && rules.ocr_signature_any.length > 0) {
      const matchesSignature = rules.ocr_signature_any.some((sig) =>
        lowerLabels.some((l) => l.includes(sig.toLowerCase())),
      );
      if (matchesSignature) return stateId;
    }

    if (rules.required_anchors && rules.required_anchors.length > 0) {
      const allRequiredPresent = rules.required_anchors.every((anchorId) => {
        const anchor = memory.anchors[anchorId];
        if (!anchor) return false;
        return (anchor.ocr_keywords ?? []).some((kw) =>
          lowerLabels.some((l) => l.includes(kw.toLowerCase())),
        );
      });
      if (allRequiredPresent) return stateId;
    }
  }

  // Default to first defined state or fallback
  return Object.keys(memory.states)[0] ?? 'default_idle';
}

export type HGamZone =
  | 'TOP_HEADER'
  | 'LEFT_SIDEBAR'
  | 'MAIN_STAGE'
  | 'BOTTOM_COMPOSER'
  | 'MODAL_CENTER';

export interface ObservedSpatialNode {
  displayIndex?: number;
  role?: string;
  label: string;
  normX: number; // u in [0, 1]
  normY: number; // v in [0, 1]
  zone: HGamZone;
  matchedAnchorId?: string;
}

export interface HGamRuntimeEvaluation {
  stateId: string;
  stateDescription: string;
  activeHeaderTitle: string | null;
  isTargetContactAlreadyOpen: boolean;
  matchedContactName: string | null;
  composerDisplayIndex: number | null;
  searchBarDisplayIndex: number | null;
  recommendedPlaybook: Playbook | null;
  dynamicDirective: string;
}

export function classifyHGamZone(u: number, v: number): HGamZone {
  if (u < 0.285) return 'LEFT_SIDEBAR';
  if (v <= 0.105) return 'TOP_HEADER';
  if (v >= 0.890) return 'BOTTOM_COMPOSER';
  return 'MAIN_STAGE';
}

export function matchNodeToHGamAnchor(
  node: ObservedSpatialNode,
  memory: AppMemoryDocument,
): string | undefined {
  const labelLower = node.label.toLowerCase();
  const roleLower = (node.role ?? '').toLowerCase();

  for (const [anchorId, anchor] of Object.entries(memory.anchors)) {
    if (anchor.zone !== node.zone) continue;

    const kwMatch = (anchor.ocr_keywords ?? []).some((kw) =>
      labelLower.includes(kw.toLowerCase()),
    );
    const axMatch = (anchor.ax_selectors ?? []).some((sel) => {
      const rMatch = sel.role ? roleLower.includes(sel.role.toLowerCase()) : false;
      const lMatch = sel.label_contains
        ? sel.label_contains.some((lc) => labelLower.includes(lc.toLowerCase()))
        : true;
      return rMatch && lMatch;
    });
    const coordMatch = anchor.norm_coords
      ? Math.hypot(node.normX - anchor.norm_coords.u, node.normY - anchor.norm_coords.v) <=
        anchor.norm_coords.radius_tolerance * 1.5
      : false;

    if (kwMatch || axMatch || coordMatch) {
      return anchorId;
    }
  }
  return undefined;
}

export function evaluateHGamWorkspaceState(
  memory: AppMemoryDocument,
  nodes: ObservedSpatialNode[],
  userPrompt: string,
): HGamRuntimeEvaluation {
  const observedLabels = nodes.map((n) => n.label).filter(Boolean);
  const presentAnchorIds = new Set<string>();

  let composerDisplayIndex: number | null = null;
  let searchBarDisplayIndex: number | null = null;
  const headerTitles: string[] = [];

  for (const node of nodes) {
    const anchorId = matchNodeToHGamAnchor(node, memory);
    if (anchorId) {
      node.matchedAnchorId = anchorId;
      presentAnchorIds.add(anchorId);
    }

    if (node.zone === 'BOTTOM_COMPOSER') {
      const r = (node.role ?? '').toLowerCase();
      const l = node.label.toLowerCase();
      if (
        anchorId === 'message_composer_box' ||
        r.includes('textarea') ||
        r.includes('textfield') ||
        l.includes('pesan') ||
        l.includes('message')
      ) {
        presentAnchorIds.add('message_composer_box');
        if (typeof node.displayIndex === 'number' && composerDisplayIndex === null) {
          composerDisplayIndex = node.displayIndex;
        }
      }
    }

    if (node.zone === 'LEFT_SIDEBAR' && anchorId === 'search_bar_input') {
      if (typeof node.displayIndex === 'number' && searchBarDisplayIndex === null) {
        searchBarDisplayIndex = node.displayIndex;
      }
    }

    if (node.zone === 'TOP_HEADER' && node.label.trim().length > 1) {
      const l = node.label.trim().toLowerCase();
      const isUtilityButton = [
        'voice call',
        'video call',
        'panggilan',
        'search',
        'cari',
        'menu',
        'info',
      ].some((kw) => l === kw || l.startsWith(kw));
      if (!isUtilityButton) {
        headerTitles.push(node.label.trim());
      }
    }
  }

  let stateId = detectCurrentAppState(memory, observedLabels);
  if (presentAnchorIds.has('message_composer_box')) {
    stateId = 'conversation_open';
  }

  const activeHeaderTitle =
    headerTitles.length > 0 ? Array.from(new Set(headerTitles)).slice(0, 2).join(' | ') : null;

  const promptLower = userPrompt.toLowerCase();
  let matchedContactName: string | null = null;
  for (const title of headerTitles) {
    const cleanTitle = title.toLowerCase().trim();
    if (cleanTitle.length >= 2 && promptLower.includes(cleanTitle)) {
      matchedContactName = title;
      break;
    }
  }

  const isTargetContactAlreadyOpen =
    stateId === 'conversation_open' && matchedContactName !== null;

  let recommendedPlaybook: Playbook | null = null;
  let dynamicDirective = '';

  if (isTargetContactAlreadyOpen) {
    recommendedPlaybook =
      memory.playbooks.find((pb) => pb.id === 'playbook_send_whatsapp_message') ?? null;
    dynamicDirective = [
      `[H-GAM SHORT-CIRCUIT AKTIF]: State layar adalah "conversation_open" dan kontak target "${matchedContactName}" SUDAH TERBUKA di TOP_HEADER!`,
      `- DILARANG KERAS menjalankan "playbook_open_chat_by_contact" (jangan tekan Command+F dan jangan klik nama "${matchedContactName}" di TOP_HEADER maupun LEFT_SIDEBAR).`,
      `- LANGSUNG jalankan "playbook_send_whatsapp_message": ketik pesan menggunakan "bcu_type_text"${
        composerDisplayIndex !== null
          ? ` (atau klik anchor [message_composer_box] pada display_index=${composerDisplayIndex} di BOTTOM_COMPOSER)`
          : ''
      } lalu kirim dengan Return.`,
    ].join('\n');
  } else {
    recommendedPlaybook =
      memory.playbooks.find((pb) =>
        pb.trigger_intents.some((intent) => promptLower.includes(intent.toLowerCase())),
      ) ?? null;
    dynamicDirective = activeHeaderTitle
      ? `[H-GAM STATE INFO]: Saat ini obrolan yang terbuka di TOP_HEADER adalah "${activeHeaderTitle}". Untuk berpindah ke kontak lain, Anda WAJIB memilih baris di zona LEFT_SIDEBAR (atau gunakan Search Bar di LEFT_SIDEBAR). DILARANG mengeklik elemen di TOP_HEADER.`
      : `[H-GAM STATE INFO]: Belum ada obrolan aktif yang terbuka (state="${stateId}"). Gunakan zona LEFT_SIDEBAR untuk mencari dan memilih kontak.`;
  }

  const stateDef = memory.states[stateId] ?? {
    id: stateId,
    description: 'Tampilan aktif aplikasi',
  };

  return {
    stateId,
    stateDescription: stateDef.description,
    activeHeaderTitle,
    isTargetContactAlreadyOpen,
    matchedContactName,
    composerDisplayIndex,
    searchBarDisplayIndex,
    recommendedPlaybook,
    dynamicDirective,
  };
}

export function formatCompactMemoryForPrompt(
  memory: AppMemoryDocument,
  currentStateId: string,
  userPrompt: string,
  runtimeEval?: HGamRuntimeEvaluation | null,
): string {
  const effectiveStateId = runtimeEval?.stateId ?? currentStateId;
  const currentState = memory.states[effectiveStateId] ?? {
    id: effectiveStateId,
    description: 'Tampilan aktif aplikasi',
  };

  const promptLower = userPrompt.toLowerCase();
  const matchedPlaybook =
    runtimeEval !== undefined
      ? runtimeEval?.recommendedPlaybook
      : memory.playbooks.find((pb) =>
          pb.trigger_intents.some((intent) => promptLower.includes(intent.toLowerCase())),
        );

  const anchorSummaries = Object.values(memory.anchors).map((a) => {
    const coords = a.norm_coords ? `(u: ${a.norm_coords.u}, v: ${a.norm_coords.v})` : 'dynamic';
    return `- [${a.id}] (zone: ${a.zone}, tier: ${a.safety_tier}): ${a.description}. Posisi: ${coords}`;
  });

  const playbookBlock = matchedPlaybook
    ? [
        `REKOMENDASI WORKFLOW PLAYBOOK AKTIF (${matchedPlaybook.name}):`,
        ...matchedPlaybook.steps.map(
          (s) => `  Langkah ${s.step}: ${s.op} -> ${s.anchor_id ?? s.dynamic_query ?? s.text ?? ''}`,
        ),
      ].join('\n')
    : '';

  const directiveBlock = runtimeEval?.dynamicDirective ? `\n${runtimeEval.dynamicDirective}\n` : '';

  const lessonsBlock =
    memory.reflexion_lessons && memory.reflexion_lessons.length > 0
      ? [
          `PELAJARAN OPERASIONAL SEBELUMNYA (REFLEXION LESSONS):`,
          ...memory.reflexion_lessons.slice(-3).map((l, i) => `  ${i + 1}. ${l}`),
        ].join('\n')
      : '';

  return [
    `APP MENTAL MODEL (H-GAM PERSISTENT MEMORY):`,
    `- Aplikasi: ${memory.app_metadata.app_name} (${memory.app_metadata.bundle_id})`,
    `- State Layar Terdeteksi: "${currentState.id}" (${currentState.description})`,
    runtimeEval?.activeHeaderTitle
      ? `- Obrolan Aktif di TOP_HEADER: "${runtimeEval.activeHeaderTitle}"`
      : `- Obrolan Aktif di TOP_HEADER: (Belum ada / belum diobservasi)`,
    directiveBlock,
    `- Anchor Spasial Terverifikasi:`,
    anchorSummaries.join('\n'),
    playbookBlock,
    lessonsBlock,
  ]
    .filter(Boolean)
    .join('\n');
}

export function recordReflexionLesson(appNameOrBundle: string, lesson: string): void {
  const memory = loadAppMemory(appNameOrBundle);
  if (!memory) return;
  if (!memory.reflexion_lessons) {
    memory.reflexion_lessons = [];
  }
  if (!memory.reflexion_lessons.includes(lesson)) {
    memory.reflexion_lessons.push(lesson);
    if (memory.reflexion_lessons.length > 10) {
      memory.reflexion_lessons = memory.reflexion_lessons.slice(-10);
    }
    saveAppMemory(memory);
  }
}

export function checkSafetyGate(
  memory: AppMemoryDocument,
  actionText: string,
): { requiresTakeover: boolean; reason?: string } {
  const lower = actionText.toLowerCase();

  for (const pattern of memory.safety_policy.blocked_exploration_patterns) {
    if (lower.includes(pattern.toLowerCase())) {
      return {
        requiresTakeover: true,
        reason: `Tindakan terdeteksi berisiko tinggi (${pattern}). Mengharuskan konfirmasi manual dari pengguna.`,
      };
    }
  }

  return { requiresTakeover: false };
}
