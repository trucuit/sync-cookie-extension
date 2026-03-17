import { useCallback, useEffect, useState } from 'react';
import './App.css';
import { PasswordDialog } from './components/PasswordDialog';
import { decrypt, encrypt } from './lib/crypto';

type DialogType = 'export' | 'import' | null;
type OperationStatus = 'idle' | 'syncing' | 'synced' | 'error';

type SimpleSyncStatus = {
  loggedIn: boolean;
  email: string | null;
  syncState: {
    lastPushedAt?: string | null;
    lastPulledAt?: string | null;
    cookieCount?: number;
  } | null;
};

type BackgroundResponse<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code?: string; message: string } };

function sendBackgroundMessage<T>(message: Record<string, unknown>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response: BackgroundResponse<T>) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message ?? 'Background message failed'));
        return;
      }
      if (!response) { reject(new Error('No response from background')); return; }
      if (!response.ok) { reject(new Error(response.error?.message ?? 'Background request failed')); return; }
      resolve(response.data);
    });
  });
}

function formatTimestamp(iso: string | null | undefined) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('vi-VN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  } catch { return iso; }
}

/* ─── SVG Icons (inline, no emoji) ─── */
const Icons = {
  sync: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 2v6h-6" /><path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
      <path d="M3 22v-6h6" /><path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
    </svg>
  ),
  user: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" />
    </svg>
  ),
  lock: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect width="18" height="11" x="3" y="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  ),
  upload: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" x2="12" y1="3" y2="15" />
    </svg>
  ),
  download: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" x2="12" y1="15" y2="3" />
    </svg>
  ),
  globe: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" /><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" /><path d="M2 12h20" />
    </svg>
  ),
  folder: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m13 13.5 2-2.5-2-2.5" /><path d="M2 21a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H20a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2Z" />
    </svg>
  ),
  alert: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" /><line x1="12" x2="12" y1="8" y2="12" /><line x1="12" x2="12.01" y1="16" y2="16" />
    </svg>
  ),
  logout: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><polyline points="16 17 21 12 16 7" /><line x1="21" x2="9" y1="12" y2="12" />
    </svg>
  ),
};

function App() {
  const [localStatus, setLocalStatus] = useState<OperationStatus>('idle');
  const [dialogType, setDialogType] = useState<DialogType>(null);
  const [pendingFile, setPendingFile] = useState<File | null>(null);

  const [simpleEmail, setSimpleEmail] = useState('');
  const [simplePassword, setSimplePassword] = useState('');
  const [simpleSyncPassword, setSimpleSyncPassword] = useState('');
  const [simpleStatus, setSimpleStatus] = useState<SimpleSyncStatus | null>(null);
  const [simpleOpStatus, setSimpleOpStatus] = useState<OperationStatus>('idle');
  const [simpleError, setSimpleError] = useState<string | null>(null);
  const [domainWhitelistInput, setDomainWhitelistInput] = useState('claude.ai\ngemini.google.com\nchatgpt.com');

  const refreshSimpleStatus = useCallback(async () => {
    try {
      const status = await sendBackgroundMessage<SimpleSyncStatus>({ type: 'SIMPLE_SYNC_STATUS' });
      setSimpleStatus(status);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { void refreshSimpleStatus(); }, [refreshSimpleStatus]);

  const handleSimpleRegister = async () => {
    setSimpleError(null);
    if (!simpleEmail.trim() || !simplePassword.trim()) { setSimpleError('Nhập email và password.'); return; }
    try {
      setSimpleOpStatus('syncing');
      await sendBackgroundMessage({ type: 'SIMPLE_AUTH_REGISTER', email: simpleEmail, password: simplePassword });
      await refreshSimpleStatus();
      setSimpleOpStatus('synced');
      setTimeout(() => setSimpleOpStatus('idle'), 1500);
    } catch (error) { setSimpleOpStatus('error'); setSimpleError(error instanceof Error ? error.message : 'Đăng ký thất bại.'); }
  };

  const handleSimpleLogin = async () => {
    setSimpleError(null);
    if (!simpleEmail.trim() || !simplePassword.trim()) { setSimpleError('Nhập email và password.'); return; }
    try {
      setSimpleOpStatus('syncing');
      await sendBackgroundMessage({ type: 'SIMPLE_AUTH_LOGIN', email: simpleEmail, password: simplePassword });
      await refreshSimpleStatus();
      setSimpleOpStatus('synced');
      setTimeout(() => setSimpleOpStatus('idle'), 1500);
    } catch (error) { setSimpleOpStatus('error'); setSimpleError(error instanceof Error ? error.message : 'Đăng nhập thất bại.'); }
  };

  const handleSimpleLogout = async () => {
    setSimpleError(null);
    try { await sendBackgroundMessage({ type: 'SIMPLE_AUTH_LOGOUT' }); await refreshSimpleStatus(); } catch { /* ignore */ }
  };

  const handleSimplePush = async () => {
    setSimpleError(null);
    if (!simpleSyncPassword.trim()) { setSimpleError('Nhập sync password để mã hoá cookies.'); return; }
    try {
      setSimpleOpStatus('syncing');
      await sendBackgroundMessage({ type: 'SIMPLE_SYNC_PUSH', password: simpleSyncPassword });
      await refreshSimpleStatus();
      setSimpleOpStatus('synced');
      setTimeout(() => setSimpleOpStatus('idle'), 1500);
    } catch (error) { setSimpleOpStatus('error'); setSimpleError(error instanceof Error ? error.message : 'Push thất bại.'); }
  };

  const handleSimplePull = async () => {
    setSimpleError(null);
    if (!simpleSyncPassword.trim()) { setSimpleError('Nhập sync password để giải mã cookies.'); return; }
    try {
      setSimpleOpStatus('syncing');
      await sendBackgroundMessage({ type: 'SIMPLE_SYNC_PULL', password: simpleSyncPassword });
      await refreshSimpleStatus();
      setSimpleOpStatus('synced');
      setTimeout(() => setSimpleOpStatus('idle'), 1500);
    } catch (error) { setSimpleOpStatus('error'); setSimpleError(error instanceof Error ? error.message : 'Pull thất bại.'); }
  };

  const handleExportWithPassword = async (password: string) => {
    try {
      setDialogType(null);
      setLocalStatus('syncing');
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab.url) throw new Error('No active tab');
      const url = new URL(tab.url);
      const domain = url.hostname;
      const cookies = await chrome.cookies.getAll({ domain });
      const exportData = {
        version: '1.0.0', timestamp: Date.now(), domain,
        cookies: cookies.map((c) => ({ name: c.name, value: c.value, domain: c.domain, path: c.path, secure: c.secure, httpOnly: c.httpOnly, sameSite: c.sameSite, expirationDate: c.expirationDate })),
      };
      const encrypted = await encrypt(JSON.stringify(exportData), password);
      const blob = new Blob([JSON.stringify({ ...encrypted, version: '1.0.0', encrypted: true }, null, 2)], { type: 'application/json' });
      const blobUrl = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = blobUrl;
      anchor.download = `cookies-${domain}-${Date.now()}.encrypted.json`;
      anchor.click();
      URL.revokeObjectURL(blobUrl);
      setLocalStatus('synced');
      setTimeout(() => setLocalStatus('idle'), 1500);
    } catch (error) { console.error('Export failed:', error); setLocalStatus('error'); setTimeout(() => setLocalStatus('idle'), 1500); }
  };

  const handleImportWithPassword = async (password: string) => {
    if (!pendingFile) return;
    try {
      setDialogType(null);
      setLocalStatus('syncing');
      const text = await pendingFile.text();
      const encryptedData = JSON.parse(text);
      if (!encryptedData.encrypted) throw new Error('File is not encrypted');
      const decryptedText = await decrypt({ data: encryptedData.data, iv: encryptedData.iv, salt: encryptedData.salt }, password);
      const data = JSON.parse(decryptedText);
      if (!Array.isArray(data.cookies)) throw new Error('Invalid cookie file format');
      const confirmed = confirm(`Import ${data.cookies.length} cookies for ${data.domain}?`);
      if (!confirmed) { setLocalStatus('idle'); return; }
      let imported = 0;
      for (const cookie of data.cookies) {
        try {
          await chrome.cookies.set({ url: `http${cookie.secure ? 's' : ''}://${cookie.domain}${cookie.path}`, name: cookie.name, value: cookie.value, domain: cookie.domain, path: cookie.path, secure: cookie.secure, httpOnly: cookie.httpOnly, sameSite: cookie.sameSite, expirationDate: cookie.expirationDate });
          imported += 1;
        } catch (e) { console.warn(`Failed to import cookie ${cookie.name}:`, e); }
      }
      setPendingFile(null);
      setLocalStatus('synced');
      setTimeout(() => { setLocalStatus('idle'); alert(`Imported ${imported}/${data.cookies.length} cookies.`); }, 800);
    } catch (error) { console.error('Import failed:', error); setPendingFile(null); setLocalStatus('error'); setTimeout(() => { setLocalStatus('idle'); alert(`Import failed: ${error instanceof Error ? error.message : 'Unknown error'}`); }, 800); }
  };

  const handleImport = () => {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = '.json';
    input.onchange = (event) => { const file = (event.target as HTMLInputElement).files?.[0]; if (file) { setPendingFile(file); setDialogType('import'); } };
    input.click();
  };

  const statusBadge = () => {
    if (simpleOpStatus === 'syncing') return { className: 'status-badge status-syncing', label: 'Syncing' };
    if (simpleOpStatus === 'synced') return { className: 'status-badge status-done', label: 'Done' };
    if (simpleOpStatus === 'error') return { className: 'status-badge status-error', label: 'Error' };
    if (simpleStatus?.loggedIn) return { className: 'status-badge status-online', label: 'Online' };
    return { className: 'status-badge status-offline', label: 'Offline' };
  };

  const badge = statusBadge();

  return (
    <>
      <div className="app-root">
        {/* ─── Header ─── */}
        <header className="app-header">
          <div className="app-header-left">
            <div className="app-logo">{Icons.sync}</div>
            <div>
              <div className="app-title">Sync Cookie</div>
              <div className="app-subtitle">Firebase Sync · AES-256</div>
            </div>
          </div>
          <div className={badge.className}>
            <span className="dot" />
            {badge.label}
          </div>
        </header>

        <div className="app-content">
          {/* ─── Account Card ─── */}
          <div className="card">
            <div className="card-header">
              <span className="card-icon">{Icons.user}</span>
              <div>
                <div className="card-title">Account</div>
                <div className="card-subtitle">
                  {simpleStatus?.loggedIn ? simpleStatus.email : 'Not logged in'}
                </div>
              </div>
            </div>

            {!simpleStatus?.loggedIn ? (
              <>
                <input
                  type="email" value={simpleEmail}
                  onChange={(e) => setSimpleEmail(e.target.value)}
                  placeholder="Email" className="form-input"
                />
                <input
                  type="password" value={simplePassword}
                  onChange={(e) => setSimplePassword(e.target.value)}
                  placeholder="Password" className="form-input"
                />
                <div className="btn-grid">
                  <button onClick={handleSimpleLogin} disabled={simpleOpStatus === 'syncing'} className="btn btn-primary">
                    {simpleOpStatus === 'syncing' ? <span className="spinner" /> : Icons.user && null}
                    Login
                  </button>
                  <button onClick={handleSimpleRegister} disabled={simpleOpStatus === 'syncing'} className="btn btn-secondary">
                    Register
                  </button>
                </div>
              </>
            ) : (
              <button onClick={handleSimpleLogout} className="btn btn-danger" style={{ width: '100%' }}>
                <span className="btn-icon">{Icons.logout}</span>
                Logout
              </button>
            )}
          </div>

          {/* ─── Sync Card ─── */}
          {simpleStatus?.loggedIn ? (
            <div className="card">
              <div className="card-header">
                <span className="card-icon">{Icons.lock}</span>
                <div>
                  <div className="card-title">Sync Cookies</div>
                  <div className="card-subtitle">Encrypt before syncing</div>
                </div>
              </div>

              <input
                type="password" value={simpleSyncPassword}
                onChange={(e) => setSimpleSyncPassword(e.target.value)}
                placeholder="Sync password (encryption key)" className="form-input"
              />

              <div className="btn-grid">
                <button onClick={handleSimplePush} disabled={simpleOpStatus === 'syncing'} className="btn btn-primary">
                  {simpleOpStatus === 'syncing' ? <span className="spinner" /> : <span className="btn-icon">{Icons.upload}</span>}
                  Push
                </button>
                <button onClick={handleSimplePull} disabled={simpleOpStatus === 'syncing'} className="btn btn-secondary">
                  <span className="btn-icon">{Icons.download}</span>
                  Pull
                </button>
              </div>

              <div className="sync-stats">
                <div className="sync-stat">
                  <span className="sync-stat-label">Last Push</span>
                  <span className="sync-stat-value">{formatTimestamp(simpleStatus?.syncState?.lastPushedAt ?? null)}</span>
                </div>
                <div className="sync-stat">
                  <span className="sync-stat-label">Last Pull</span>
                  <span className="sync-stat-value">{formatTimestamp(simpleStatus?.syncState?.lastPulledAt ?? null)}</span>
                </div>
              </div>
            </div>
          ) : null}


          {/* ─── Error ─── */}
          {simpleError ? (
            <div className="error-msg">
              {Icons.alert}
              <span>{simpleError}</span>
            </div>
          ) : null}

          {/* ─── Domain Whitelist ─── */}
          <div className="card">
            <div className="card-header">
              <span className="card-icon">{Icons.globe}</span>
              <div>
                <div className="card-title">Domain Whitelist</div>
                <div className="card-subtitle">Only sync these domains</div>
              </div>
            </div>
            <textarea
              value={domainWhitelistInput}
              onChange={(event) => setDomainWhitelistInput(event.target.value)}
              placeholder={"github.com\nmail.google.com"}
              rows={3} className="form-input"
            />
            <p className="form-hint">Separate domains with newlines or commas.</p>
          </div>

          {/* ─── Local Transfer ─── */}
          <div className="card">
            <div className="card-header">
              <span className="card-icon">{Icons.folder}</span>
              <div>
                <div className="card-title">Local Transfer</div>
                <div className="card-subtitle">File-based cookie backup</div>
              </div>
            </div>
            <div className="btn-grid">
              <button onClick={() => setDialogType('export')} disabled={localStatus === 'syncing'} className="btn btn-primary">
                <span className="btn-icon">{Icons.upload}</span>
                Export
              </button>
              <button onClick={handleImport} disabled={localStatus === 'syncing'} className="btn btn-secondary">
                <span className="btn-icon">{Icons.download}</span>
                Import
              </button>
            </div>
          </div>
        </div>
      </div>

      <PasswordDialog
        isOpen={dialogType === 'export'}
        title="Encrypt Cookies"
        description="Enter a password to encrypt your cookies."
        onConfirm={handleExportWithPassword}
        onCancel={() => setDialogType(null)}
      />
      <PasswordDialog
        isOpen={dialogType === 'import'}
        title="Decrypt Cookies"
        description="Enter the password to decrypt these cookies."
        onConfirm={handleImportWithPassword}
        onCancel={() => { setDialogType(null); setPendingFile(null); }}
      />
    </>
  );
}

export default App;
