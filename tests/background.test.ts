import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type RuntimeMessageHandler = (
  request: unknown,
  sender: unknown,
  sendResponse: (response: unknown) => void,
) => boolean;

describe('background service worker', () => {
  const onInstalledAddListener = vi.fn();
  const onStartupAddListener = vi.fn();
  const onMessageAddListener = vi.fn();
  const onAlarmAddListener = vi.fn();
  const alarmCreate = vi.fn();

  const storageLocalGet = vi.fn();
  const storageLocalSet = vi.fn();
  const storageLocalRemove = vi.fn();
  const storageSessionGet = vi.fn();
  const storageSessionSet = vi.fn();
  const storageSessionRemove = vi.fn();

  beforeEach(() => {
    vi.resetModules();

    onInstalledAddListener.mockReset();
    onStartupAddListener.mockReset();
    onMessageAddListener.mockReset();
    onAlarmAddListener.mockReset();
    alarmCreate.mockReset();

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
        onStartup: {
          addListener: onStartupAddListener,
        },
        onMessage: {
          addListener: onMessageAddListener,
        },
      },
      alarms: {
        create: alarmCreate,
        onAlarm: {
          addListener: onAlarmAddListener,
        },
      },
      identity: {
        getRedirectURL: vi.fn(() => 'https://mock.chromiumapp.org/callback'),
        launchWebAuthFlow: vi.fn(),
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
    expect(onStartupAddListener).toHaveBeenCalledTimes(1);
    expect(onAlarmAddListener).toHaveBeenCalledTimes(1);
    expect(onMessageAddListener).toHaveBeenCalledTimes(1);
  });

  it('returns status snapshot from SYNC_GET_STATUS message', async () => {
    await import('../src/background');

    const messageHandler = onMessageAddListener.mock.calls[0]?.[0] as RuntimeMessageHandler | undefined;
    expect(messageHandler).toBeTypeOf('function');

    const sendResponse = vi.fn();
    const keepChannelOpen = messageHandler?.({ type: 'SYNC_GET_STATUS' }, {}, sendResponse);
    expect(keepChannelOpen).toBe(true);

    await vi.waitFor(() => {
      expect(sendResponse).toHaveBeenCalledWith(
        expect.objectContaining({
          ok: true,
          data: expect.objectContaining({
            auth: expect.any(Object),
            sync: expect.any(Object),
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

