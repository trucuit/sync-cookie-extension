import { useState } from 'react';
import './App.css';
import { PasswordDialog } from './components/PasswordDialog';
import { encrypt, decrypt } from './lib/crypto';

type DialogType = 'export' | 'import' | null;

function App() {
  const [syncStatus, setSyncStatus] = useState<'idle' | 'syncing' | 'synced' | 'error'>('idle');
  const [dialogType, setDialogType] = useState<DialogType>(null);
  const [pendingFile, setPendingFile] = useState<File | null>(null);

  const handleExportWithPassword = async (password: string) => {
    try {
      setDialogType(null);
      setSyncStatus('syncing');

      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab.url) throw new Error('No active tab');

      const url = new URL(tab.url);
      const domain = url.hostname;

      const cookies = await chrome.cookies.getAll({ domain });

      const exportData = {
        version: '1.0.0',
        timestamp: Date.now(),
        domain,
        cookies: cookies.map(cookie => ({
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
      const url_blob = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url_blob;
      a.download = `cookies-${domain}-${Date.now()}.encrypted.json`;
      a.click();
      URL.revokeObjectURL(url_blob);

      setSyncStatus('synced');
      setTimeout(() => setSyncStatus('idle'), 2000);
    } catch (error) {
      console.error('Export failed:', error);
      setSyncStatus('error');
      setTimeout(() => setSyncStatus('idle'), 2000);
    }
  };

  const handleImportWithPassword = async (password: string) => {
    if (!pendingFile) return;

    try {
      setDialogType(null);
      setSyncStatus('syncing');

      const text = await pendingFile.text();
      const encryptedData = JSON.parse(text);

      if (!encryptedData.encrypted) {
        throw new Error('File is not encrypted');
      }

      const decryptedText = await decrypt({
        data: encryptedData.data,
        iv: encryptedData.iv,
        salt: encryptedData.salt,
      }, password);

      const data = JSON.parse(decryptedText);

      if (!data.cookies || !Array.isArray(data.cookies)) {
        throw new Error('Invalid cookie file format');
      }

      const confirmed = confirm(
        `Import ${data.cookies.length} cookies for ${data.domain}?`
      );

      if (!confirmed) {
        setSyncStatus('idle');
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
          imported++;
        } catch (err) {
          console.warn(`Failed to import cookie ${cookie.name}:`, err);
        }
      }

      setSyncStatus('synced');
      setTimeout(() => {
        setSyncStatus('idle');
        alert(`Successfully imported ${imported} of ${data.cookies.length} cookies`);
      }, 1000);

      setPendingFile(null);
    } catch (error) {
      console.error('Import failed:', error);
      setSyncStatus('error');
      setTimeout(() => {
        setSyncStatus('idle');
        alert(`Import failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }, 1000);
      setPendingFile(null);
    }
  };

  const handleExport = () => {
    setDialogType('export');
  };

  const handleImport = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (file) {
        setPendingFile(file);
        setDialogType('import');
      }
    };
    input.click();
  };

  const handleSync = () => {
    setSyncStatus('syncing');
    setTimeout(() => {
      setSyncStatus('synced');
      setTimeout(() => setSyncStatus('idle'), 2000);
    }, 1500);
  };

  return (
    <>
      <div className="w-[360px] min-h-[480px] bg-gradient-to-br from-purple-50 to-blue-50 dark:from-gray-900 dark:to-gray-800">
        <div className="bg-white dark:bg-gray-800 shadow-sm p-4 border-b border-gray-200 dark:border-gray-700">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 bg-gradient-to-br from-purple-500 to-blue-500 rounded-lg flex items-center justify-center">
                <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-3m-1 4l-3 3m0 0l-3-3m3 3V4" />
                </svg>
              </div>
              <h1 className="text-lg font-semibold text-gray-900 dark:text-white">Sync Cookie</h1>
            </div>
            {syncStatus !== 'idle' && (
              <div className={`px-2 py-1 rounded-full text-xs font-medium ${
                syncStatus === 'syncing' ? 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300' :
                syncStatus === 'synced' ? 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300' :
                'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300'
              }`}>
                {syncStatus === 'syncing' ? 'Processing...' :
                 syncStatus === 'synced' ? 'Success ✓' :
                 'Error ✗'}
              </div>
            )}
          </div>
        </div>

        <div className="p-6">
          <div className="space-y-3">
            <button
              onClick={handleExport}
              className="w-full bg-white dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-700 text-gray-900 dark:text-white font-medium py-3 px-4 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 transition-colors flex items-center justify-center gap-2"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
              Export (Encrypted)
            </button>

            <button
              onClick={handleImport}
              className="w-full bg-white dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-700 text-gray-900 dark:text-white font-medium py-3 px-4 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 transition-colors flex items-center justify-center gap-2"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
              </svg>
              Import Cookies
            </button>

            <button
              onClick={handleSync}
              disabled={syncStatus === 'syncing'}
              className="w-full bg-gradient-to-r from-purple-500 to-blue-500 hover:from-purple-600 hover:to-blue-600 disabled:opacity-50 text-white font-medium py-3 px-4 rounded-lg shadow-md transition-all flex items-center justify-center gap-2"
            >
              <svg className={`w-5 h-5 ${syncStatus === 'syncing' ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              Sync Now
            </button>
          </div>

          <div className="mt-6 p-4 bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700">
            <div className="flex items-start gap-2">
              <svg className="w-5 h-5 text-blue-500 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <div className="text-sm text-gray-600 dark:text-gray-400">
                <p className="font-medium text-gray-900 dark:text-white mb-1">🔐 Secure</p>
                <ul className="space-y-1 list-disc list-inside">
                  <li>AES-256 encryption</li>
                  <li>Export current site</li>
                  <li>Password protected</li>
                </ul>
              </div>
            </div>
          </div>

          <button className="w-full mt-4 text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 flex items-center justify-center gap-1 transition-colors">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
            Settings
          </button>
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
