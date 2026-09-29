'use strict';

/**
 * Unit tests for src/boot-timers.js.
 *
 * What must hold: both background timers are started; one timer failing does
 * not stop the other or throw into the boot path; and the result says which
 * happened rather than leaving a caller to read the log. The last of those is
 * the reason the function exists at all - the desktop boot (src/server.js) and
 * the server boot (api/server.js) call this so they cannot drift apart, and a
 * caller that cannot tell success from failure would just be drift with extra
 * steps.
 */

jest.mock('../../src/realtime/scheduler', () => ({ start: jest.fn() }));
jest.mock('../../src/services/unanswered-orders', () => ({ start: jest.fn() }));

const { startBootTimers } = require('../../src/boot-timers');
const scheduler = require('../../src/realtime/scheduler');
const unansweredOrders = require('../../src/services/unanswered-orders');

const quiet = { warn: () => {}, log: () => {}, error: () => {} };

beforeEach(() => {
  jest.clearAllMocks();
});

describe('startBootTimers', () => {
  test('starts both timers and reports them', () => {
    const result = startBootTimers({ log: quiet });

    expect(scheduler.start).toHaveBeenCalledTimes(1);
    expect(unansweredOrders.start).toHaveBeenCalledTimes(1);
    expect(result.started.sort()).toEqual(['scheduler', 'unanswered-orders']);
    expect(result.failed).toEqual([]);
  });

  test('a timer that fails does not stop the other one', () => {
    scheduler.start.mockImplementationOnce(() => {
      throw new Error('read only');
    });

    const result = startBootTimers({ log: quiet });

    expect(unansweredOrders.start).toHaveBeenCalledTimes(1);
    expect(result.started).toEqual(['unanswered-orders']);
    expect(result.failed).toEqual([{ name: 'scheduler', message: 'read only' }]);
  });

  test('never throws, even when both fail', () => {
    scheduler.start.mockImplementationOnce(() => {
      throw new Error('nope');
    });
    unansweredOrders.start.mockImplementationOnce(() => {
      throw new Error('also nope');
    });

    /* One call, its result captured: mockImplementationOnce only covers the
       first invocation, so calling it twice here would test the second. */
    let result;
    expect(() => {
      result = startBootTimers({ log: quiet });
    }).not.toThrow();
    expect(result.failed.map((f) => f.name).sort()).toEqual(['scheduler', 'unanswered-orders']);
  });

  test('says which timer started, which is the line support reads', () => {
    const lines = [];
    startBootTimers({ log: { log: (m) => lines.push(m), warn: () => {} } });

    expect(lines).toContain('✅ Webhook delivery scheduler running');
    expect(lines).toContain('✅ Unanswered-order rule running');
  });
});
