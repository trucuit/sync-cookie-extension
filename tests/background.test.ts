import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type RuntimeMessageHandler = (
  request: unknown,
  sender: unknown,
  sendResponse: (response: unknown) => void,
) => boolean;

describe('background service worker', () => {
  const onInstalledAddListener = vi.fn();
  const onMessageAddListener = vi.fn();

  const storageLocalGet = vi.fn();
  const storageLocalSet = vi.fn();
  const storageLocalRemove = vi.fn();
  const storageSessionGet = vi.fn();
  const storageSessionSet = vi.fn();
  const storageSessionRemove = vi.fn();

  beforeEach(() => {
    vi.resetModules();

    onInstalledAddListener.mockReset();
    onMessageAddListener.mockReset();

    storageLocalGet.mockReset();
    storageLocalSet.mockReset();
    storageLocalRemove.mockReset();
    storageSessionGet.mockReset();
    storageSessionSet.mockReset();
    storageSessionRemove.mockReset();

    storageLocalGet.mockResolvedValue({});
    storageLocalSet.mockResolvedValue(undefined);
    storageLocalRemove.mockResolvedValue(undefined);
    storageSessionGet.mockResolvedValue({});
    storageSessionSet.mockResolvedValue(undefined);
    storageSessionRemove.mockResolvedValue(undefined);

    vi.stubGlobal('chrome', {
      runtime: {
        lastError: undefined,
        onInstalled: {
          addListener: onInstalledAddListener,
        },
        onMessage: {
          addListener: onMessageAddListener,
        },
      },
      cookies: {
        getAll: vi.fn().mockResolvedValue([]),
        remove: vi.fn().mockResolvedValue(undefined),
        set: vi.fn().mockResolvedValue(undefined),
      },
      storage: {
        local: {
          get: storageLocalGet,
          set: storageLocalSet,
          remove: storageLocalRemove,
        },
        session: {
          get: storageSessionGet,
          set: storageSessionSet,
          remove: storageSessionRemove,
        },
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('registers background listeners on import', async () => {
    await import('../src/background');

    expect(onInstalledAddListener).toHaveBeenCalledTimes(1);
    expect(onMessageAddListener).toHaveBeenCalledTimes(1);
  });

  it('returns Firebase sync status from SIMPLE_SYNC_STATUS message', async () => {
    await import('../src/background');

    const messageHandler = onMessageAddListener.mock.calls[0]?.[0] as RuntimeMessageHandler | undefined;
    expect(messageHandler).toBeTypeOf('function');

    const sendResponse = vi.fn();
    const keepChannelOpen = messageHandler?.({ type: 'SIMPLE_SYNC_STATUS' }, {}, sendResponse);
    expect(keepChannelOpen).toBe(true);

    await vi.waitFor(() => {
      expect(sendResponse).toHaveBeenCalledWith(
        expect.objectContaining({
          ok: true,
          data: expect.objectContaining({
            loggedIn: false,
            email: null,
            syncState: null,
          }),
        })
      );
    });
  });

  it('returns error for unsupported request type', async () => {
    await import('../src/background');

    const messageHandler = onMessageAddListener.mock.calls[0]?.[0] as RuntimeMessageHandler | undefined;
    expect(messageHandler).toBeTypeOf('function');

    const sendResponse = vi.fn();
    messageHandler?.({ type: 'UNKNOWN_ACTION' }, {}, sendResponse);

    await vi.waitFor(() => {
      expect(sendResponse).toHaveBeenCalledWith(
        expect.objectContaining({
          ok: false,
          error: expect.objectContaining({
            code: 'request.unsupported',
          }),
        })
      );
    });
  });
});
