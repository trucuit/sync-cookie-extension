import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('simple-sync-client (Firebase proxy)', () => {
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
    it('calls proxy register endpoint and returns tokens', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          idToken: 'id-tk',
          refreshToken: 'ref-tk',
          uid: 'uid-1',
          email: 'a@b.com',
        }),
      });

      const { firebaseRegister } = await importClient();
      const result = await firebaseRegister({
        proxyBaseUrl: 'https://proxy.example.com',
        email: 'a@b.com',
        password: '123456',
      });

      expect(result).toEqual({
        idToken: 'id-tk',
        refreshToken: 'ref-tk',
        uid: 'uid-1',
        email: 'a@b.com',
      });

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toBe('https://proxy.example.com/firebase/auth/register');
      expect(options.method).toBe('POST');
      expect(options.body).toContain('"email":"a@b.com"');
    });

    it('maps proxy errors on register failure', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        json: async () => ({
          error: 'firebase.register_failed',
          message: 'Email đã được đăng ký.',
        }),
      });

      const { firebaseRegister } = await importClient();
      await expect(firebaseRegister({
        proxyBaseUrl: 'https://proxy.example.com',
        email: 'a@b.com',
        password: '123456',
      })).rejects.toThrow('Email đã được đăng ký.');
    });
  });

  describe('firebaseLogin', () => {
    it('calls proxy login endpoint', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          idToken: 'id-login',
          refreshToken: 'ref-login',
          uid: 'uid-2',
          email: 'c@d.com',
        }),
      });

      const { firebaseLogin } = await importClient();
      const result = await firebaseLogin({
        proxyBaseUrl: 'https://proxy.example.com/',
        email: 'c@d.com',
        password: '999999',
      });

      expect(result.idToken).toBe('id-login');
      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe('https://proxy.example.com/firebase/auth/login');
    });
  });

  describe('firebaseRefreshToken', () => {
    it('calls proxy refresh endpoint', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          idToken: 'new-id-tk',
          refreshToken: 'new-ref-tk',
          uid: 'uid-1',
        }),
      });

      const { firebaseRefreshToken } = await importClient();
      const result = await firebaseRefreshToken({
        proxyBaseUrl: 'https://proxy.example.com',
        refreshToken: 'old-ref-tk',
      });

      expect(result).toEqual({
        idToken: 'new-id-tk',
        refreshToken: 'new-ref-tk',
        uid: 'uid-1',
      });

      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe('https://proxy.example.com/firebase/auth/refresh');
    });
  });

  describe('firebasePush', () => {
    it('pushes data through proxy', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true, updatedAt: '2026-01-01T00:00:00Z', uid: 'uid-1' }),
      });

      const { firebasePush } = await importClient();
      const result = await firebasePush({
        proxyBaseUrl: 'https://proxy.example.com',
        idToken: 'tk',
        payload: '{"data":1}',
      });

      expect(result.ok).toBe(true);
      expect(result.uid).toBe('uid-1');
      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toBe('https://proxy.example.com/firebase/sync/push');
      expect(options.body).toContain('"idToken":"tk"');
    });
  });

  describe('firebasePull', () => {
    it('pulls data through proxy', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ok: true,
          payload: '{"cookies":[]}',
          updatedAt: '2026-01-01T00:00:00Z',
          uid: 'uid-1',
        }),
      });

      const { firebasePull } = await importClient();
      const result = await firebasePull({
        proxyBaseUrl: 'https://proxy.example.com',
        idToken: 'tk',
      });

      expect(result.payload).toBe('{"cookies":[]}');
      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe('https://proxy.example.com/firebase/sync/pull');
    });

    it('throws when payload is empty', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true, payload: null }),
      });

      const { firebasePull } = await importClient();
      await expect(firebasePull({
        proxyBaseUrl: 'https://proxy.example.com',
        idToken: 'tk',
      })).rejects.toThrow(/No synced data/i);
    });
  });

  describe('network errors', () => {
    it('wraps fetch errors with a proxy-friendly message', async () => {
      mockFetch.mockRejectedValueOnce(new TypeError('fetch failed'));

      const { firebaseRegister } = await importClient();
      await expect(firebaseRegister({
        proxyBaseUrl: 'https://proxy.example.com',
        email: 'a@b.c',
        password: 'p',
      })).rejects.toThrow(/proxy/i);
    });
  });
});
