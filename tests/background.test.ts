import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type RuntimeMessageHandler = (
  request: unknown,
  sender: unknown,
  sendResponse: (response: unknown) => void,
) => boolean;

describe('background service worker', () => {
  const onInstalledAddListener = vi.fn();
  const onMessageAddListener = vi.fn();

  beforeEach(() => {
    vi.resetModules();
    onInstalledAddListener.mockReset();
    onMessageAddListener.mockReset();

    vi.stubGlobal('chrome', {
      runtime: {
        onInstalled: {
          addListener: onInstalledAddListener,
        },
        onMessage: {
          addListener: onMessageAddListener,
        },
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('registers install and message listeners on import', async () => {
    await import('../src/background');

    expect(onInstalledAddListener).toHaveBeenCalledTimes(1);
    expect(onMessageAddListener).toHaveBeenCalledTimes(1);
  });

  it('logs install event when onInstalled listener is triggered', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await import('../src/background');
    const installedHandler = onInstalledAddListener.mock.calls[0]?.[0] as (() => void) | undefined;

    expect(installedHandler).toBeTypeOf('function');
    installedHandler?.();

    expect(logSpy).toHaveBeenCalledWith('Sync Cookie Extension installed');
  });

  it('returns success response from runtime message handler', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await import('../src/background');
    const messageHandler = onMessageAddListener.mock.calls[0]?.[0] as RuntimeMessageHandler | undefined;

    expect(messageHandler).toBeTypeOf('function');

    const request = { type: 'PING' };
    const sendResponse = vi.fn();
    const keepChannelOpen = messageHandler?.(request, {}, sendResponse);

    expect(logSpy).toHaveBeenCalledWith('Message received:', request);
    expect(sendResponse).toHaveBeenCalledWith({ success: true });
    expect(keepChannelOpen).toBe(true);
  });
});
