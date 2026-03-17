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

  it('keeps permissions minimal for MVP runtime scope', () => {
    const manifestPath = resolve(process.cwd(), 'src/manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      permissions?: string[];
      host_permissions?: string[];
      content_scripts?: unknown[];
    };

    expect(manifest.permissions).toEqual(
      expect.arrayContaining(['cookies', 'storage', 'tabs', 'identity', 'alarms'])
    );
    expect(manifest.permissions).not.toContain('activeTab');

    expect(manifest.host_permissions).toEqual([
      'https://github.com/*',
      'https://api.github.com/*',
      'https://*.atlassian.net/*',
      'https://*.run.app/*',
    ]);
    expect(manifest.host_permissions).not.toContain('<all_urls>');
    expect(manifest.content_scripts ?? []).toHaveLength(0);
  });
});
