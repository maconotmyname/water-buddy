'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MAX_HISTORY_DAYS,
  createHistoryRecord,
  normalizeHistory,
  pruneHistory
} = require('../src/shared/history');

test('history record captures partial and closed ring state', () => {
  assert.deepEqual(createHistoryRecord({ consumedMl: 750, targetMl: 2000, mode: 'work' }), {
    consumedMl: 750,
    targetMl: 2000,
    percent: 38,
    closed: false,
    mode: 'work'
  });
  assert.deepEqual(createHistoryRecord({ consumedMl: 2200, targetMl: 2000, mode: 'holiday' }), {
    consumedMl: 2200,
    targetMl: 2000,
    percent: 100,
    closed: true,
    mode: 'holiday'
  });
});

test('history normalization removes invalid keys and recomputes completion', () => {
  assert.deepEqual(normalizeHistory({
    '2026-08-19': { consumedMl: 1000, targetMl: 2000, percent: 100, closed: true, mode: 'work' },
    invalid: { consumedMl: 2000, targetMl: 2000 },
    '2026-08-20': null
  }), {
    '2026-08-19': {
      consumedMl: 1000,
      targetMl: 2000,
      percent: 50,
      closed: false,
      mode: 'work'
    }
  });
});

test('history retention keeps at most two years of daily records', () => {
  const history = {};
  const current = new Date(2026, 7, 20, 12);
  for (let offset = 0; offset <= MAX_HISTORY_DAYS; offset += 1) {
    const date = new Date(current);
    date.setDate(date.getDate() - offset);
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    history[key] = createHistoryRecord({ consumedMl: 0, targetMl: 2000, mode: 'work' });
  }
  assert.equal(Object.keys(pruneHistory(history, current)).length, MAX_HISTORY_DAYS);
});
