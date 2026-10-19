// SPDX-License-Identifier: MIT
// macOS Readiness & TCC Permission Checklist — Conforming strictly to DESIGN.md

import { useState, useEffect, useCallback } from 'react';
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
      const res = await fetch('/api/system/permissions');
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
        headers: { 'Content-Type': 'application/json' },
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
          <span>Sistem Otomasi Mac Siap - Background CUA & Persepsi Aktif</span>
        </div>
        <button
          type="button"
          className="text-button"
          onClick={() => setCollapsed(false)}
        >
          Detail <ChevronDown size={12} />
        </button>
      </div>
    );
  }

  return (
    <section className="permission-card" aria-label="Kesiapan izin macOS">
      <div className="permission-card-header">
        <div className="permission-card-title">
          <span className={`permission-badge-icon ${isAllReady ? 'ready' : 'warn'}`}>
            {isAllReady ? <ShieldCheck size={15} /> : <ShieldAlert size={15} />}
          </span>
          <div>
            <strong>Kesiapan Izin Otomasi macOS</strong>
            <p>Diperlukan agar Dot dapat membaca jendela dan mengirim input di belakang layar.</p>
          </div>
        </div>

        <div className="permission-card-actions">
          <button
            type="button"
            className="text-button"
            onClick={() => void fetchPermissions()}
          >
            <RefreshCw size={11} className={loading ? 'spin' : ''} />
            Cek ulang
          </button>
          {isAllReady && (
            <button
              type="button"
              className="icon-button"
              onClick={() => setCollapsed(true)}
              aria-label="Ringkas daftar izin"
            >
              <ChevronUp size={14} />
            </button>
          )}
        </div>
      </div>

      <div className="permission-list">
        <div className="permission-row">
          <div>
            <strong>1. Accessibility (Kontrol Input)</strong>
            <span>Mengizinkan injeksi klik dan ketikan ke jendela aplikasi terikat.</span>
          </div>
          <span className={`status ${perms.accessibility ? 'completed' : 'failed'}`}>
            <span />
            {perms.accessibility ? 'Granted' : 'Required'}
          </span>
        </div>

        {!perms.accessibility && (
          <div className="permission-callout">
            <p>
              Tarik (drag) file aplikasi di bawah ini langsung ke daftar <strong>System Settings &gt; Accessibility</strong> untuk mengaktifkan izin:
            </p>
            <div className="permission-callout-actions" style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '8px' }}>
              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                <button
                  type="button"
                  className="primary"
                  onClick={() => void openSettings('accessibility')}
                >
                  <ExternalLink size={12} />
                  Buka Settings Accessibility macOS
                </button>
              </div>
              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                <button
                  type="button"
                  onClick={() => void openSettings('reveal-binary', 'bcu')}
                  title="Buka BackgroundComputerUse.app di Finder untuk di-drag ke Accessibility"
                >
                  <FolderOpen size={12} />
                  Drag 1: BackgroundComputerUse.app
                </button>
                <button
                  type="button"
                  onClick={() => void openSettings('reveal-binary', 'cua')}
                  title="Buka cua-spacesd di Finder untuk di-drag ke Accessibility"
                >
                  <FolderOpen size={12} />
                  Drag 2: cua-spacesd
                </button>
                <button
                  type="button"
                  onClick={() => void openSettings('reveal-binary', 'app')}
                  title="Buka OpenDots app di Finder untuk di-drag ke Accessibility"
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
            <strong>2. Screen Recording (Tangkapan Jendela)</strong>
            <span>Diperlukan oleh Apple Vision OCR dan pratinjau kanvas kanan.</span>
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
              Izinkan <ExternalLink size={11} />
            </button>
          )}
        </div>

        <div className="permission-row">
          <div>
            <strong>3. CUA Driver Daemon</strong>
            <span>Layanan lokal pengirim aksi background di 127.0.0.1:3211.</span>
          </div>
          <span className={`status ${perms.cua_daemon ? 'completed' : 'paused'}`}>
            <span />
            {perms.cua_daemon ? 'Online' : 'Offline'}
          </span>
        </div>

        <div className="permission-row">
          <div>
            <strong>4. Perception Eye Engine</strong>
            <span>Binary OCR cepat & pemetaan koordinat Logical Points.</span>
          </div>
          <span className={`status ${perms.perception_engine ? 'completed' : 'failed'}`}>
            <span />
            {perms.perception_engine ? 'Ready' : 'Missing'}
          </span>
        </div>
      </div>
    </section>
  );
}
