import { afterEach, describe, expect, it, vi } from 'vitest';
import { startMemoryWatchdog } from '../../src/runtime/memoryWatchdog.js';
import type { Logger } from '../../src/logger.js';

const MB = 1024 * 1024;

describe('startMemoryWatchdog', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('stops the server once memory exceeds the limit, and only then', () => {
    vi.useFakeTimers();
    let rss = 200 * MB;
    const errors: string[] = [];
    const logger: Logger = {
      error: (m) => errors.push(m),
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
    };
    const onExceeded = vi.fn();

    const stop = startMemoryWatchdog({
      limitBytes: 1024 * MB,
      logger,
      onExceeded,
      readRss: () => rss,
      intervalMs: 1000,
    });
    vi.advanceTimersByTime(5000);
    expect(onExceeded).not.toHaveBeenCalled();

    rss = 1500 * MB;
    vi.advanceTimersByTime(1000);
    expect(onExceeded).toHaveBeenCalledTimes(1);
    expect(errors[0]).toContain('1500 MB exceeded the limit of 1024 MB');
    stop();
  });
});
