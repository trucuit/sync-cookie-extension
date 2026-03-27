import { describe, expect, it } from 'vitest';
import manifest from '../src/manifest';
import { buildCookieHostPermissions, SUPPORTED_SYNC_DOMAINS } from '../src/lib/sync-core/sync-records';

describe('extension manifest security settings', () => {
  it('defines explicit CSP for extension pages', () => {
    expect(manifest.content_security_policy?.extension_pages).toContain("script-src 'self'");
    expect(manifest.content_security_policy?.extension_pages).toContain("object-src 'self'");
  });

  it('keeps permissions minimal for proxy-based sync scope', () => {
    expect(manifest.permissions).toEqual(
      expect.arrayContaining(['cookies', 'storage', 'tabs'])
    );
    expect(manifest.permissions).not.toContain('activeTab');
    expect(manifest.permissions).not.toContain('identity');
    expect(manifest.permissions).not.toContain('alarms');

    expect(manifest.host_permissions).toEqual([
      'https://*.run.app/*',
      'http://localhost/*',
      'http://127.0.0.1/*',
      ...buildCookieHostPermissions(SUPPORTED_SYNC_DOMAINS),
    ]);
    expect(manifest.host_permissions).not.toContain('<all_urls>');
    expect(manifest.content_scripts ?? []).toHaveLength(0);
  });
});
