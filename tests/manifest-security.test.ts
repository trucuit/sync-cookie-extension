import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('extension manifest security settings', () => {
  it('defines explicit CSP for extension pages', () => {
    const manifestPath = resolve(process.cwd(), 'src/manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      content_security_policy?: {
        extension_pages?: string;
      };
    };

    expect(manifest.content_security_policy?.extension_pages).toContain("script-src 'self'");
    expect(manifest.content_security_policy?.extension_pages).toContain("object-src 'self'");
  });

  it('keeps permissions minimal for Firebase sync scope', () => {
    const manifestPath = resolve(process.cwd(), 'src/manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      permissions?: string[];
      host_permissions?: string[];
      content_scripts?: unknown[];
    };

    expect(manifest.permissions).toEqual(
      expect.arrayContaining(['cookies', 'storage', 'tabs'])
    );
    expect(manifest.permissions).not.toContain('activeTab');
    expect(manifest.permissions).not.toContain('identity');
    expect(manifest.permissions).not.toContain('alarms');

    expect(manifest.host_permissions).toEqual([
      'https://*.firebaseio.com/*',
      'https://identitytoolkit.googleapis.com/*',
      'https://securetoken.googleapis.com/*',
    ]);
    expect(manifest.host_permissions).not.toContain('<all_urls>');
    expect(manifest.content_scripts ?? []).toHaveLength(0);
  });
});
