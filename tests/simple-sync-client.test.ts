import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('simple-sync-client (Firebase REST)', () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.resetModules();
    mockFetch.mockReset();
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function importClient() {
    return import('../src/lib/sync-core/simple-sync-client');
  }

  describe('firebaseRegister', () => {
    it('returns tokens on successful registration', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          idToken: 'id-tk',
          refreshToken: 'ref-tk',
          localId: 'uid-1',
          email: 'a@b.com',
        }),
      });

      const { firebaseRegister } = await importClient();
      const result = await firebaseRegister({ apiKey: 'key', email: 'a@b.com', password: '123456' });

      expect(result).toEqual({
        idToken: 'id-tk',
        refreshToken: 'ref-tk',
        uid: 'uid-1',
        email: 'a@b.com',
      });

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain('signUp');
      expect(url).toContain('key=key');
    });

    it('throws on registration failure', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        json: async () => ({ error: { message: 'EMAIL_EXISTS' } }),
      });

      const { firebaseRegister } = await importClient();
      await expect(firebaseRegister({ apiKey: 'key', email: 'a@b.com', password: '123' }))
        .rejects.toThrow();
    });
  });

  describe('firebaseLogin', () => {
    it('returns tokens on successful login', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          idToken: 'id-tk-2',
          refreshToken: 'ref-tk-2',
          localId: 'uid-2',
          email: 'c@d.com',
        }),
      });

      const { firebaseLogin } = await importClient();
      const result = await firebaseLogin({ apiKey: 'key', email: 'c@d.com', password: '999' });

      expect(result.idToken).toBe('id-tk-2');
      expect(result.uid).toBe('uid-2');

      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain('signInWithPassword');
    });
  });

  describe('firebaseRefreshToken', () => {
    it('returns new tokens on successful refresh', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id_token: 'new-id-tk',
          refresh_token: 'new-ref-tk',
          user_id: 'uid-1',
        }),
      });

      const { firebaseRefreshToken } = await importClient();
      const result = await firebaseRefreshToken({ apiKey: 'key', refreshToken: 'old-ref-tk' });

      expect(result.idToken).toBe('new-id-tk');
      expect(result.refreshToken).toBe('new-ref-tk');

      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain('securetoken.googleapis.com');
    });

    it('throws on refresh failure', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        json: async () => ({ error: { message: 'TOKEN_EXPIRED' } }),
      });

      const { firebaseRefreshToken } = await importClient();
      await expect(firebaseRefreshToken({ apiKey: 'key', refreshToken: 'bad' }))
        .rejects.toThrow();
    });
  });

  describe('firebasePush', () => {
    it('pushes data to Firebase RTDB', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ payload: '{}', updatedAt: '2026-01-01T00:00:00Z' }),
      });

      const { firebasePush } = await importClient();
      await firebasePush({
        dbUrl: 'https://db.firebaseio.com',
        idToken: 'tk',
        uid: 'uid',
        payload: '{"data":1}',
      });

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toContain('/sync/uid.json');
      expect(options.method).toBe('PUT');
    });
  });

  describe('firebasePull', () => {
    it('pulls data from Firebase RTDB', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          payload: '{"cookies":[]}',
          updatedAt: '2026-01-01T00:00:00Z',
        }),
      });

      const { firebasePull } = await importClient();
      const result = await firebasePull({
        dbUrl: 'https://db.firebaseio.com',
        idToken: 'tk',
        uid: 'uid',
      });

      expect(result.payload).toBe('{"cookies":[]}');
      expect(result.updatedAt).toBe('2026-01-01T00:00:00Z');

      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain('/sync/uid.json');
    });

    it('throws when no data exists', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => null,
      });

      const { firebasePull } = await importClient();
      await expect(firebasePull({
        dbUrl: 'https://db.firebaseio.com',
        idToken: 'tk',
        uid: 'uid',
      })).rejects.toThrow();
    });
  });

  describe('network errors', () => {
    it('wraps fetch errors with a friendly message', async () => {
      mockFetch.mockRejectedValueOnce(new TypeError('fetch failed'));

      const { firebaseRegister } = await importClient();
      await expect(firebaseRegister({ apiKey: 'k', email: 'a@b.c', password: 'p' }))
        .rejects.toThrow(/network/i);
    });
  });
});
