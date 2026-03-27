import { describe, expect, it } from 'vitest';
import {
  findDomainMatch,
  groupCookiesByDomain,
  parseDomainWhitelistInput,
  toDomainKey,
} from '../src/lib/sync-core/sync-records';

describe('sync-record helpers', () => {
  it('encodes domain keys predictably', () => {
    expect(toDomainKey('chatgpt.com')).toBe('chatgpt,com');
    expect(toDomainKey('.claude.ai')).toBe('claude,ai');
  });

  it('matches subdomains to supported root domains', () => {
    expect(findDomainMatch('.chatgpt.com', ['chatgpt.com'])).toBe('chatgpt.com');
    expect(findDomainMatch('auth.claude.ai', ['claude.ai'])).toBe('claude.ai');
  });

  it('groups cookies by matched root domain', () => {
    const grouped = groupCookiesByDomain([
      { domain: '.chatgpt.com', name: 'a' },
      { domain: 'auth.chatgpt.com', name: 'b' },
      { domain: '.claude.ai', name: 'c' },
    ], ['chatgpt.com', 'claude.ai']);

    expect(grouped['chatgpt.com']).toHaveLength(2);
    expect(grouped['claude.ai']).toHaveLength(1);
  });

  it('normalizes whitelist input from textarea form', () => {
    expect(parseDomainWhitelistInput('chatgpt.com\nclaude.ai,foo.example')).toEqual([
      'chatgpt.com',
      'claude.ai',
    ]);
  });
});
