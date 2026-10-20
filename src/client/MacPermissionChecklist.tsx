// SPDX-License-Identifier: MIT
// macOS Readiness & TCC Permission Checklist — Conforming strictly to DESIGN.md

import { useState, useEffect, useCallback } from 'react';
import { authHeaders } from './api';
import {
  ShieldCheck,
  ShieldAlert,
  ExternalLink,
  FolderOpen,
  RefreshCw,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';

interface PermissionsState {
  accessibility: boolean;
  screen_recording: boolean;
  cua_daemon: boolean;
  perception_engine: boolean;
  binary_path?: string;
}

export function MacPermissionChecklist() {
  const [perms, setPerms] = useState<PermissionsState | null>(null);
  const [loading, setLoading] = useState(false);
  const [collapsed, setCollapsed] = useState(false);

  const fetchPermissions = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/system/permissions', {
        headers: authHeaders(),
      });
      if (res.ok) {
        const data = (await res.json()) as PermissionsState;
        setPerms(data);
        if (
          data.accessibility &&
          data.screen_recording &&
          data.cua_daemon &&
          data.perception_engine
        ) {
          setCollapsed(true);
        }
      }
    } catch {
      // Ignore network error during boot
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchPermissions();
  }, [fetchPermissions]);

  const openSettings = async (
    pane: 'accessibility' | 'screen-recording' | 'reveal-binary',
    target?: 'bcu' | 'cua' | 'app',
  ) => {
    try {
      await fetch('/api/system/open-settings', {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ pane, target }),
      });
      setTimeout(() => void fetchPermissions(), 2500);
    } catch {
      // Handled
    }
  };

  if (!perms) return null;

  const isAllReady =
    perms.accessibility &&
    perms.screen_recording &&
    perms.cua_daemon &&
    perms.perception_engine;

  if (collapsed && isAllReady) {
    return (
      <div className="permission-pill-bar">
        <div className="permission-pill-status">
          <span className="online-dot-inline" />
          <span>
            Mac automation ready — Background CUA and perception active
          </span>
        </div>
        <button
          type="button"
          className="text-button"
          onClick={() => setCollapsed(false)}
        >
          Details <ChevronDown size={12} />
        </button>
      </div>
    );
  }

  return (
    <section
      className="permission-card"
      aria-label="macOS permission readiness"
    >
      <div className="permission-card-header">
        <div className="permission-card-title">
          <span
            className={`permission-badge-icon ${isAllReady ? 'ready' : 'warn'}`}
          >
            {isAllReady ? <ShieldCheck size={15} /> : <ShieldAlert size={15} />}
          </span>
          <div>
            <strong>macOS automation permissions</strong>
            <p>
              Required so a Dot can read windows and send input in the
              background.
            </p>
          </div>
        </div>

        <div className="permission-card-actions">
          <button
            type="button"
            className="text-button"
            onClick={() => void fetchPermissions()}
          >
            <RefreshCw size={11} className={loading ? 'spin' : ''} />
            Recheck
          </button>
          {isAllReady && (
            <button
              type="button"
              className="icon-button"
              onClick={() => setCollapsed(true)}
              aria-label="Collapse permission list"
            >
              <ChevronUp size={14} />
            </button>
          )}
        </div>
      </div>

      <div className="permission-list">
        <div className="permission-row">
          <div>
            <strong>1. Accessibility (input control)</strong>
            <span>
              Lets a Dot send clicks and keystrokes to bound app windows.
            </span>
          </div>
          <span
            className={`status ${perms.accessibility ? 'completed' : 'failed'}`}
          >
            <span />
            {perms.accessibility ? 'Granted' : 'Required'}
          </span>
        </div>

        {!perms.accessibility && (
          <div className="permission-callout">
            <p>
              Drag the app files below directly into{' '}
              <strong>System Settings &gt; Accessibility</strong> to grant
              permission:
            </p>
            <div
              className="permission-callout-actions"
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: '8px',
                marginTop: '8px',
              }}
            >
              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                <button
                  type="button"
                  className="primary"
                  onClick={() => void openSettings('accessibility')}
                >
                  <ExternalLink size={12} />
                  Open macOS Accessibility settings
                </button>
              </div>
              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                <button
                  type="button"
                  onClick={() => void openSettings('reveal-binary', 'bcu')}
                  title="Reveal BackgroundComputerUse.app in Finder to drag into Accessibility"
                >
                  <FolderOpen size={12} />
                  Drag 1: BackgroundComputerUse.app
                </button>
                <button
                  type="button"
                  onClick={() => void openSettings('reveal-binary', 'cua')}
                  title="Reveal cua-spacesd in Finder to drag into Accessibility"
                >
                  <FolderOpen size={12} />
                  Drag 2: cua-spacesd
                </button>
                <button
                  type="button"
                  onClick={() => void openSettings('reveal-binary', 'app')}
                  title="Reveal OpenDots.app in Finder to drag into Accessibility"
                >
                  <FolderOpen size={12} />
                  Drag 3: OpenDots.app
                </button>
              </div>
            </div>
          </div>
        )}

        <div className="permission-row">
          <div>
            <strong>2. Screen Recording (window capture)</strong>
            <span>
              Required by Apple Vision OCR and the right-hand canvas preview.
            </span>
          </div>
          {perms.screen_recording ? (
            <span className="status completed">
              <span />
              Granted
            </span>
          ) : (
            <button
              type="button"
              className="text-button"
              onClick={() => void openSettings('screen-recording')}
            >
              Allow <ExternalLink size={11} />
            </button>
          )}
        </div>

        <div className="permission-row">
          <div>
            <strong>3. Background CUA service</strong>
            <span>
              Local service that sends background clicks and keystrokes.
            </span>
          </div>
          <span
            className={`status ${perms.cua_daemon ? 'completed' : 'paused'}`}
          >
            <span />
            {perms.cua_daemon ? 'Online' : 'Offline'}
          </span>
        </div>

        <div className="permission-row">
          <div>
            <strong>4. Perception Eye engine</strong>
            <span>Fast OCR binary and Logical Point coordinate mapping.</span>
          </div>
          <span
            className={`status ${perms.perception_engine ? 'completed' : 'failed'}`}
          >
            <span />
            {perms.perception_engine ? 'Ready' : 'Missing'}
          </span>
        </div>
      </div>
    </section>
  );
}
