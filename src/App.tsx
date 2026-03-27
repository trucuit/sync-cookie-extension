import { useCallback, useEffect, useState } from 'react';
import { DEFAULT_SYNC_PASSWORD } from './lib/sync-core/default-sync-password';
import { DEFAULT_DOMAIN_WHITELIST } from './lib/sync-core/sync-records';
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

/* ─── SVG Icons ─── */
const icon = (d: string) => (
  <svg className="w-full h-full" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" dangerouslySetInnerHTML={{ __html: d }} />
);

const Icons = {
  sync: icon('<path d="M21 2v6h-6"/><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M3 22v-6h6"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/>'),
  user: icon('<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>'),
  lock: icon('<rect width="18" height="11" x="3" y="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>'),
  upload: icon('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" x2="12" y1="3" y2="15"/>'),
  download: icon('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/>'),
  globe: icon('<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>'),
  alert: icon('<circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/>'),
  logout: icon('<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" x2="9" y1="12" y2="12"/>'),
};

/* ─── Reusable sub-components ─── */
const CardIcon = ({ children }: { children: React.ReactNode }) => (
  <span className="w-5 h-5 text-accent-indigo shrink-0">{children}</span>
);

const CardHeader = ({ icon: ic, title, subtitle }: { icon: React.ReactNode; title: string; subtitle: string }) => (
  <div className="flex items-center gap-2 mb-3">
    <CardIcon>{ic}</CardIcon>
    <div>
      <div className="text-[13px] font-semibold text-text-primary">{title}</div>
      <div className="text-[11px] text-text-secondary mt-0.5">{subtitle}</div>
    </div>
  </div>
);

const Input = (props: React.InputHTMLAttributes<HTMLInputElement>) => (
  <input
    {...props}
    className={`w-full px-3 py-2.5 text-[13px] font-sans text-text-primary bg-surface-input border border-border-input rounded-lg outline-none transition-all duration-200 ease-out placeholder:text-text-muted focus:border-accent-indigo focus:ring-[3px] focus:ring-border-focus ${props.className ?? ''}`}
  />
);

const BtnPrimary = ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
  <button
    {...props}
    className={`px-4 py-2.5 text-[13px] font-medium font-sans text-white gradient-primary rounded-lg cursor-pointer transition-all duration-200 ease-out inline-flex items-center justify-center gap-1.5 whitespace-nowrap hover:gradient-primary-hover hover:shadow-[0_0_20px_rgba(99,102,241,0.15)] disabled:opacity-40 disabled:cursor-not-allowed ${props.className ?? ''}`}
  >
    {children}
  </button>
);

const BtnSecondary = ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
  <button
    {...props}
    className={`px-4 py-2.5 text-[13px] font-medium font-sans text-text-secondary bg-surface-input border border-border rounded-lg cursor-pointer transition-all duration-200 ease-out inline-flex items-center justify-center gap-1.5 whitespace-nowrap hover:bg-surface-card-hover hover:text-text-primary disabled:opacity-40 disabled:cursor-not-allowed ${props.className ?? ''}`}
  >
    {children}
  </button>
);

const BtnDanger = ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
  <button
    {...props}
    className={`px-4 py-2.5 text-[13px] font-medium font-sans text-accent-red bg-red-500/10 border border-red-500/20 rounded-lg cursor-pointer transition-all duration-200 ease-out inline-flex items-center justify-center gap-1.5 whitespace-nowrap hover:bg-red-500/20 disabled:opacity-40 disabled:cursor-not-allowed ${props.className ?? ''}`}
  >
    {children}
  </button>
);

const Spinner = () => (
  <span className="w-3.5 h-3.5 border-2 border-white/20 border-t-white rounded-full animate-spin-fast" />
);

const BtnIcon = ({ children }: { children: React.ReactNode }) => (
  <span className="w-3.5 h-3.5 shrink-0">{children}</span>
);

/* ─── Status badge styles ─── */
const statusStyles: Record<string, string> = {
  online: 'bg-emerald-500/[.12] text-accent-green',
  syncing: 'bg-cyan-500/[.12] text-accent-cyan',
  done: 'bg-emerald-500/[.12] text-accent-green',
  error: 'bg-red-500/[.12] text-accent-red',
  offline: 'bg-slate-500/[.15] text-text-muted',
};

const dotStyles: Record<string, string> = {
  online: 'bg-accent-green shadow-[0_0_6px_#34D399]',
  syncing: 'bg-accent-cyan animate-pulse-dot',
  done: 'bg-accent-green',
  error: 'bg-accent-red',
  offline: 'bg-text-muted',
};

function App() {
  const [simpleEmail, setSimpleEmail] = useState('');
  const [simplePassword, setSimplePassword] = useState('');
  const [simpleSyncPassword, setSimpleSyncPassword] = useState('');
  const [simpleStatus, setSimpleStatus] = useState<SimpleSyncStatus | null>(null);
  const [simpleOpStatus, setSimpleOpStatus] = useState<OperationStatus>('idle');
  const [simpleError, setSimpleError] = useState<string | null>(null);

  const refreshSimpleStatus = useCallback(async () => {
    try {
      const status = await sendBackgroundMessage<SimpleSyncStatus>({ type: 'SIMPLE_SYNC_STATUS' });
      setSimpleStatus(status);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    void refreshSimpleStatus();
  }, [refreshSimpleStatus]);

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
    try {
      setSimpleOpStatus('syncing');
      await sendBackgroundMessage({
        type: 'SIMPLE_SYNC_PUSH',
        password: simpleSyncPassword.trim() || DEFAULT_SYNC_PASSWORD,
      });
      await refreshSimpleStatus();
      setSimpleOpStatus('synced');
      setTimeout(() => setSimpleOpStatus('idle'), 1500);
    } catch (error) { setSimpleOpStatus('error'); setSimpleError(error instanceof Error ? error.message : 'Push thất bại.'); }
  };

  const handleSimplePull = async () => {
    setSimpleError(null);
    try {
      setSimpleOpStatus('syncing');
      await sendBackgroundMessage({
        type: 'SIMPLE_SYNC_PULL',
        password: simpleSyncPassword.trim() || DEFAULT_SYNC_PASSWORD,
      });
      await refreshSimpleStatus();
      setSimpleOpStatus('synced');
      setTimeout(() => setSimpleOpStatus('idle'), 1500);
    } catch (error) { setSimpleOpStatus('error'); setSimpleError(error instanceof Error ? error.message : 'Pull thất bại.'); }
  };

  const badgeKey = (() => {
    if (simpleOpStatus === 'syncing') return 'syncing';
    if (simpleOpStatus === 'synced') return 'done';
    if (simpleOpStatus === 'error') return 'error';
    if (simpleStatus?.loggedIn) return 'online';
    return 'offline';
  })();

  const badgeLabel: Record<string, string> = { syncing: 'Syncing', done: 'Done', error: 'Error', online: 'Online', offline: 'Offline' };

  return (
    <>
      <div className="w-[380px] min-h-[560px] bg-surface font-sans text-text-primary overflow-y-auto overflow-x-hidden">
        {/* ─── Header ─── */}
        <header className="px-5 py-4 bg-surface-secondary border-b border-border flex items-center justify-between backdrop-blur-xl sticky top-0 z-10">
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-lg gradient-primary flex items-center justify-center shrink-0">
              <span className="w-4 h-4 text-white">{Icons.sync}</span>
            </div>
            <div>
              <div className="text-[15px] font-bold tracking-tight text-text-primary">Sync Cookie</div>
              <div className="text-[11px] text-text-muted mt-px">Firebase Sync · AES-256</div>
            </div>
          </div>
          <div className={`text-[11px] font-medium px-2.5 py-1 rounded-full flex items-center gap-[5px] whitespace-nowrap ${statusStyles[badgeKey]}`}>
            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dotStyles[badgeKey]}`} />
            {badgeLabel[badgeKey]}
          </div>
        </header>

        <div className="p-4 pb-6 flex flex-col gap-3">
          {/* ─── Account Card ─── */}
          <div className="bg-surface-card border border-border rounded-xl p-4 transition-all duration-200 ease-out hover:bg-surface-card-hover hover:shadow-[0_2px_12px_rgba(0,0,0,0.3)]">
            <CardHeader icon={Icons.user} title="Account" subtitle={simpleStatus?.loggedIn ? (simpleStatus.email ?? '') : 'Not logged in'} />
            {!simpleStatus?.loggedIn ? (
              <>
                <Input type="email" value={simpleEmail} onChange={(e) => setSimpleEmail(e.target.value)} placeholder="Email" />
                <Input type="password" value={simplePassword} onChange={(e) => setSimplePassword(e.target.value)} placeholder="Password" className="mt-2" />
                <BtnPrimary onClick={handleSimpleLogin} disabled={simpleOpStatus === 'syncing'} className="w-full mt-2.5">
                  {simpleOpStatus === 'syncing' ? <Spinner /> : null}
                  Login
                </BtnPrimary>
              </>
            ) : (
              <BtnDanger onClick={handleSimpleLogout} className="w-full">
                <BtnIcon>{Icons.logout}</BtnIcon>
                Logout
              </BtnDanger>
            )}
          </div>

          {/* ─── Sync Card ─── */}
          {simpleStatus?.loggedIn ? (
            <div className="bg-surface-card border border-border rounded-xl p-4 transition-all duration-200 ease-out hover:bg-surface-card-hover hover:shadow-[0_2px_12px_rgba(0,0,0,0.3)]">
              <CardHeader icon={Icons.lock} title="Sync Cookies" subtitle="Cloud sync for supported sites" />
              <Input type="password" value={simpleSyncPassword} onChange={(e) => setSimpleSyncPassword(e.target.value)} placeholder="Sync password" />
              <div className="mt-2 text-[11px] text-text-muted">Hỗ trợ: {DEFAULT_DOMAIN_WHITELIST.join(', ')}.</div>
              <div className="grid grid-cols-2 gap-2 mt-2.5">
                <BtnPrimary onClick={handleSimplePush} disabled={simpleOpStatus === 'syncing'}>
                  {simpleOpStatus === 'syncing' ? <Spinner /> : <BtnIcon>{Icons.upload}</BtnIcon>}
                  Push
                </BtnPrimary>
                <BtnSecondary onClick={handleSimplePull} disabled={simpleOpStatus === 'syncing'}>
                  <BtnIcon>{Icons.download}</BtnIcon>
                  Pull
                </BtnSecondary>
              </div>
              <div className="flex gap-3 mt-3 pt-3 border-t border-border">
                <div className="flex-1 flex flex-col gap-0.5">
                  <span className="text-[10px] uppercase tracking-wider text-text-muted">Last Push</span>
                  <span className="text-xs text-text-secondary tabular-nums">{formatTimestamp(simpleStatus?.syncState?.lastPushedAt ?? null)}</span>
                </div>
                <div className="flex-1 flex flex-col gap-0.5">
                  <span className="text-[10px] uppercase tracking-wider text-text-muted">Last Pull</span>
                  <span className="text-xs text-text-secondary tabular-nums">{formatTimestamp(simpleStatus?.syncState?.lastPulledAt ?? null)}</span>
                </div>
              </div>
            </div>
          ) : null}

          {/* ─── Error ─── */}
          {simpleError ? (
            <div className="text-xs text-accent-red bg-red-500/[.08] border border-red-500/[.15] rounded-lg px-3 py-2.5 flex items-start gap-2">
              <span className="w-3.5 h-3.5 shrink-0 mt-px">{Icons.alert}</span>
              <span>{simpleError}</span>
            </div>
          ) : null}
        </div>
      </div>
    </>
  );
}

export default App;
