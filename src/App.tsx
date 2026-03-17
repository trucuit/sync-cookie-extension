import { useCallback, useEffect, useMemo, useState } from 'react';
import './App.css';
import { PasswordDialog } from './components/PasswordDialog';
import { decrypt, encrypt } from './lib/crypto';

type DialogType = 'export' | 'import' | null;
type OperationStatus = 'idle' | 'syncing' | 'synced' | 'error';
type CloudSyncMode = 'push' | 'pull' | 'bidirectional';

type BackgroundError = {
  code?: string;
  message: string;
};

type StatusSnapshot = {
  auth: {
    connected: boolean;
    tokenStored: boolean;
    profile: {
      login: string | null;
    } | null;
    config: {
      hasGithubClientId: boolean;
      hasOAuthProxyUrl: boolean;
    };
  };
  sync: {
    metadata: {
      gistId: string | null;
      revision: string | null;
      lastSyncedAt: string | null;
      manifestVersion: number | null;
      syncVersion: number;
    };
    settings: {
      autoSyncIntervalMinutes: number;
      domainWhitelist: string[];
    };
    runtimeState: {
      source?: string;
      mode?: string;
      status?: string;
      reason?: string;
      error?: { message?: string };
      updatedAt?: string;
    } | null;
    hasSessionPassword: boolean;
  };
};

type BackgroundResponse<T> =
  | {
      ok: true;
      data: T;
    }
  | {
      ok: false;
      error: BackgroundError;
    };

function normalizeDomainList(value: string) {
  return [...new Set(value.split(/[\n,]+/).map((item) => item.trim().toLowerCase()).filter(Boolean))];
}

function formatTimestamp(value: string | null) {
  if (!value) {
    return 'Chưa có';
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return parsed.toLocaleString();
}

async function sendBackgroundMessage<T>(request: unknown): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    chrome.runtime.sendMessage(request, (response: BackgroundResponse<T> | undefined) => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        reject(new Error(runtimeError.message));
        return;
      }

      if (!response) {
        reject(new Error('Không nhận được phản hồi từ service worker.'));
        return;
      }

      if (!response.ok) {
        reject(new Error(response.error?.message ?? 'Background request thất bại.'));
        return;
      }

      resolve(response.data);
    });
  });
}

function App() {
  const [localStatus, setLocalStatus] = useState<OperationStatus>('idle');
  const [cloudStatus, setCloudStatus] = useState<OperationStatus>('idle');
  const [dialogType, setDialogType] = useState<DialogType>(null);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [syncPassword, setSyncPassword] = useState('');
  const [statusSnapshot, setStatusSnapshot] = useState<StatusSnapshot | null>(null);
  const [domainWhitelistInput, setDomainWhitelistInput] = useState('');
  const [autoSyncInterval, setAutoSyncInterval] = useState('5');
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [cloudError, setCloudError] = useState<string | null>(null);

  const cloudBadge = useMemo(() => {
    if (cloudStatus === 'syncing') {
      return 'Cloud syncing...';
    }
    if (cloudStatus === 'synced') {
      return 'Cloud synced ✓';
    }
    if (cloudStatus === 'error') {
      return 'Cloud error ✗';
    }
    return 'Cloud idle';
  }, [cloudStatus]);

  const refreshStatus = useCallback(async () => {
    try {
      const snapshot = await sendBackgroundMessage<StatusSnapshot>({
        type: 'SYNC_GET_STATUS',
      });
      setStatusSnapshot(snapshot);

      if (!settingsLoaded) {
        setAutoSyncInterval(`${snapshot.sync.settings.autoSyncIntervalMinutes}`);
        setDomainWhitelistInput(snapshot.sync.settings.domainWhitelist.join('\n'));
        setSettingsLoaded(true);
      }
    } catch (error) {
      setCloudError(error instanceof Error ? error.message : 'Không đọc được trạng thái cloud sync.');
    }
  }, [settingsLoaded]);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  const handleExportWithPassword = async (password: string) => {
    try {
      setDialogType(null);
      setLocalStatus('syncing');

      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab.url) {
        throw new Error('No active tab');
      }

      const url = new URL(tab.url);
      const domain = url.hostname;

      const cookies = await chrome.cookies.getAll({ domain });

      const exportData = {
        version: '1.0.0',
        timestamp: Date.now(),
        domain,
        cookies: cookies.map((cookie) => ({
          name: cookie.name,
          value: cookie.value,
          domain: cookie.domain,
          path: cookie.path,
          secure: cookie.secure,
          httpOnly: cookie.httpOnly,
          sameSite: cookie.sameSite,
          expirationDate: cookie.expirationDate,
        })),
      };

      const encrypted = await encrypt(JSON.stringify(exportData), password);

      const encryptedData = {
        ...encrypted,
        version: '1.0.0',
        encrypted: true,
      };

      const blob = new Blob([JSON.stringify(encryptedData, null, 2)], { type: 'application/json' });
      const blobUrl = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = blobUrl;
      anchor.download = `cookies-${domain}-${Date.now()}.encrypted.json`;
      anchor.click();
      URL.revokeObjectURL(blobUrl);

      setLocalStatus('synced');
      setTimeout(() => setLocalStatus('idle'), 1500);
    } catch (error) {
      console.error('Export failed:', error);
      setLocalStatus('error');
      setTimeout(() => setLocalStatus('idle'), 1500);
    }
  };

  const handleImportWithPassword = async (password: string) => {
    if (!pendingFile) {
      return;
    }

    try {
      setDialogType(null);
      setLocalStatus('syncing');

      const text = await pendingFile.text();
      const encryptedData = JSON.parse(text);
      if (!encryptedData.encrypted) {
        throw new Error('File is not encrypted');
      }

      const decryptedText = await decrypt(
        {
          data: encryptedData.data,
          iv: encryptedData.iv,
          salt: encryptedData.salt,
        },
        password
      );

      const data = JSON.parse(decryptedText);
      if (!Array.isArray(data.cookies)) {
        throw new Error('Invalid cookie file format');
      }

      const confirmed = confirm(`Import ${data.cookies.length} cookies for ${data.domain}?`);
      if (!confirmed) {
        setLocalStatus('idle');
        return;
      }

      let imported = 0;
      for (const cookie of data.cookies) {
        try {
          await chrome.cookies.set({
            url: `http${cookie.secure ? 's' : ''}://${cookie.domain}${cookie.path}`,
            name: cookie.name,
            value: cookie.value,
            domain: cookie.domain,
            path: cookie.path,
            secure: cookie.secure,
            httpOnly: cookie.httpOnly,
            sameSite: cookie.sameSite,
            expirationDate: cookie.expirationDate,
          });
          imported += 1;
        } catch (singleError) {
          console.warn(`Failed to import cookie ${cookie.name}:`, singleError);
        }
      }

      setPendingFile(null);
      setLocalStatus('synced');
      setTimeout(() => {
        setLocalStatus('idle');
        alert(`Imported ${imported}/${data.cookies.length} cookies.`);
      }, 800);
    } catch (error) {
      console.error('Import failed:', error);
      setPendingFile(null);
      setLocalStatus('error');
      setTimeout(() => {
        setLocalStatus('idle');
        alert(`Import failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }, 800);
    }
  };

  const handleConnectGitHub = async () => {
    setCloudError(null);

    if (!syncPassword.trim()) {
      setCloudError('Nhập password trước khi connect GitHub.');
      return;
    }

    try {
      setCloudStatus('syncing');
      await sendBackgroundMessage({
        type: 'AUTH_CONNECT',
        password: syncPassword,
      });
      await refreshStatus();
      setCloudStatus('synced');
      setTimeout(() => setCloudStatus('idle'), 1200);
    } catch (error) {
      setCloudStatus('error');
      setCloudError(error instanceof Error ? error.message : 'GitHub connect thất bại.');
    }
  };

  const handleDisconnectGitHub = async () => {
    setCloudError(null);
    try {
      setCloudStatus('syncing');
      await sendBackgroundMessage({
        type: 'AUTH_DISCONNECT',
      });
      await refreshStatus();
      setCloudStatus('synced');
      setTimeout(() => setCloudStatus('idle'), 1000);
    } catch (error) {
      setCloudStatus('error');
      setCloudError(error instanceof Error ? error.message : 'GitHub disconnect thất bại.');
    }
  };

  const handleRunCloudSync = async (mode: CloudSyncMode) => {
    setCloudError(null);

    if (!syncPassword.trim()) {
      setCloudError('Nhập password để chạy Gist sync.');
      return;
    }

    try {
      setCloudStatus('syncing');
      await sendBackgroundMessage({
        type: 'SYNC_RUN',
        mode,
        password: syncPassword,
      });
      await refreshStatus();
      setCloudStatus('synced');
      setTimeout(() => setCloudStatus('idle'), 1200);
    } catch (error) {
      setCloudStatus('error');
      setCloudError(error instanceof Error ? error.message : 'Cloud sync thất bại.');
    }
  };

  const handleSaveSettings = async () => {
    setCloudError(null);
    const parsedInterval = Number(autoSyncInterval);

    try {
      setCloudStatus('syncing');
      await sendBackgroundMessage({
        type: 'SYNC_SET_SETTINGS',
        autoSyncIntervalMinutes: parsedInterval,
        domainWhitelist: normalizeDomainList(domainWhitelistInput),
      });
      await refreshStatus();
      setCloudStatus('synced');
      setTimeout(() => setCloudStatus('idle'), 1000);
    } catch (error) {
      setCloudStatus('error');
      setCloudError(error instanceof Error ? error.message : 'Lưu sync settings thất bại.');
    }
  };

  const handleImport = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = (event) => {
      const file = (event.target as HTMLInputElement).files?.[0];
      if (file) {
        setPendingFile(file);
        setDialogType('import');
      }
    };
    input.click();
  };

  return (
    <>
      <div className="w-[380px] min-h-[560px] bg-gradient-to-br from-purple-50 to-blue-50 dark:from-gray-900 dark:to-gray-800">
        <div className="bg-white dark:bg-gray-800 shadow-sm p-4 border-b border-gray-200 dark:border-gray-700">
          <div className="flex items-center justify-between gap-2">
            <h1 className="text-lg font-semibold text-gray-900 dark:text-white">Sync Cookie</h1>
            <div className="text-xs rounded-full bg-indigo-100 text-indigo-700 px-2 py-1">{cloudBadge}</div>
          </div>
          <p className="text-xs text-gray-500 mt-1">GitHub OAuth + Gist Sync + local import/export</p>
        </div>

        <div className="p-4 space-y-4">
          <div className="rounded-lg border border-gray-200 bg-white p-3 dark:bg-gray-800 dark:border-gray-700">
            <p className="text-sm font-semibold text-gray-900 dark:text-white">GitHub OAuth</p>
            <p className="text-xs text-gray-500 mt-1">
              Status:{' '}
              {statusSnapshot?.auth.connected
                ? `Connected${statusSnapshot?.auth.profile?.login ? ` @${statusSnapshot.auth.profile.login}` : ''}`
                : 'Not connected'}
            </p>
            <input
              type="password"
              value={syncPassword}
              onChange={(event) => setSyncPassword(event.target.value)}
              placeholder="Sync password"
              className="mt-2 w-full rounded-md border border-gray-300 px-3 py-2 text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-white"
            />

            <div className="grid grid-cols-2 gap-2 mt-2">
              <button
                onClick={handleConnectGitHub}
                disabled={cloudStatus === 'syncing'}
                className="rounded-md bg-gray-900 text-white text-sm py-2 disabled:opacity-50"
              >
                Connect GitHub
              </button>
              <button
                onClick={handleDisconnectGitHub}
                disabled={cloudStatus === 'syncing'}
                className="rounded-md bg-gray-100 text-gray-700 text-sm py-2 border border-gray-200 disabled:opacity-50"
              >
                Disconnect
              </button>
            </div>

            <div className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-2 py-1.5 text-[11px] text-amber-800">
              Token GitHub được mã hoá và lưu ở extension storage; sync password chỉ giữ trong session runtime.
              Scope MVP hiện chỉ hỗ trợ host `github.com`, `api.github.com`, `*.atlassian.net` và proxy `*.run.app`.
            </div>

            {!statusSnapshot?.auth.config.hasGithubClientId || !statusSnapshot?.auth.config.hasOAuthProxyUrl ? (
              <p className="mt-2 text-xs text-amber-600">
                Thiếu config env (`VITE_GITHUB_CLIENT_ID` hoặc `VITE_GITHUB_OAUTH_PROXY_URL`).
              </p>
            ) : null}
          </div>

          <div className="rounded-lg border border-gray-200 bg-white p-3 dark:bg-gray-800 dark:border-gray-700">
            <p className="text-sm font-semibold text-gray-900 dark:text-white">Gist Sync Actions</p>
            <div className="grid grid-cols-3 gap-2 mt-2">
              <button
                onClick={() => handleRunCloudSync('bidirectional')}
                disabled={cloudStatus === 'syncing'}
                className="rounded-md bg-gradient-to-r from-purple-500 to-blue-500 text-white text-sm py-2 disabled:opacity-50"
              >
                Sync Now
              </button>
              <button
                onClick={() => handleRunCloudSync('push')}
                disabled={cloudStatus === 'syncing'}
                className="rounded-md bg-gray-100 border border-gray-200 text-gray-700 text-sm py-2 disabled:opacity-50"
              >
                Push
              </button>
              <button
                onClick={() => handleRunCloudSync('pull')}
                disabled={cloudStatus === 'syncing'}
                className="rounded-md bg-gray-100 border border-gray-200 text-gray-700 text-sm py-2 disabled:opacity-50"
              >
                Pull
              </button>
            </div>

            <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-gray-600">
              <p>Gist ID: {statusSnapshot?.sync.metadata.gistId ?? 'Chưa có'}</p>
              <p>Last sync: {formatTimestamp(statusSnapshot?.sync.metadata.lastSyncedAt ?? null)}</p>
              <p>Manifest: {statusSnapshot?.sync.metadata.manifestVersion ?? 'N/A'}</p>
              <p>Sync version: {statusSnapshot?.sync.metadata.syncVersion ?? 0}</p>
            </div>
          </div>

          <div className="rounded-lg border border-gray-200 bg-white p-3 dark:bg-gray-800 dark:border-gray-700">
            <p className="text-sm font-semibold text-gray-900 dark:text-white">Auto-sync Settings</p>
            <div className="mt-2">
              <label className="text-xs text-gray-500">Interval (minutes 1-60)</label>
              <input
                type="number"
                min={1}
                max={60}
                value={autoSyncInterval}
                onChange={(event) => setAutoSyncInterval(event.target.value)}
                className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-white"
              />
            </div>
            <div className="mt-2">
              <label className="text-xs text-gray-500">Domain whitelist (newline/comma)</label>
              <textarea
                value={domainWhitelistInput}
                onChange={(event) => setDomainWhitelistInput(event.target.value)}
                placeholder="github.com\nmail.google.com"
                rows={3}
                className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-white"
              />
            </div>
            <button
              onClick={handleSaveSettings}
              disabled={cloudStatus === 'syncing'}
              className="mt-2 rounded-md bg-gray-900 text-white text-sm py-2 px-3 disabled:opacity-50"
            >
              Save Settings
            </button>
            <p className="mt-2 text-xs text-gray-500">
              Runtime: {statusSnapshot?.sync.runtimeState?.status ?? 'N/A'} · Updated:{' '}
              {formatTimestamp(statusSnapshot?.sync.runtimeState?.updatedAt ?? null)}
            </p>
          </div>

          <div className="rounded-lg border border-gray-200 bg-white p-3 dark:bg-gray-800 dark:border-gray-700">
            <p className="text-sm font-semibold text-gray-900 dark:text-white">Local file transfer</p>
            <div className="grid grid-cols-2 gap-2 mt-2">
              <button
                onClick={() => setDialogType('export')}
                disabled={localStatus === 'syncing'}
                className="rounded-md bg-gray-900 text-white text-sm py-2 disabled:opacity-50"
              >
                Export (encrypted)
              </button>
              <button
                onClick={handleImport}
                disabled={localStatus === 'syncing'}
                className="rounded-md bg-gray-100 border border-gray-200 text-gray-700 text-sm py-2 disabled:opacity-50"
              >
                Import cookies
              </button>
            </div>
            <p className="mt-2 text-xs text-gray-500">Local status: {localStatus}</p>
          </div>

          {cloudError ? <p className="text-xs text-red-600">{cloudError}</p> : null}
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
        onCancel={() => {
          setDialogType(null);
          setPendingFile(null);
        }}
      />
    </>
  );
}

export default App;
