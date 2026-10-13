'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_SETTINGS,
  buildDailyPlan,
  localDateKey,
  normalizeSettings,
  normalizeTarget
} = require('../src/shared/schedule');

test('daily target is rounded to a whole cup multiple', () => {
  assert.equal(normalizeTarget(2000, 300), 2100);
  assert.equal(normalizeTarget(2000, 350), 2100);
  assert.equal(normalizeTarget(2050, 250), 2000);
});

test('cup volume accepts a broad custom range and clamps extremes', () => {
  assert.deepEqual(
    { cupMl: normalizeSettings({ cupMl: 875, targetMl: 2000 }).cupMl, targetMl: normalizeSettings({ cupMl: 875, targetMl: 2000 }).targetMl },
    { cupMl: 875, targetMl: 1750 }
  );
  assert.equal(normalizeSettings({ cupMl: 50 }).cupMl, 100);
  assert.equal(normalizeSettings({ cupMl: 1200 }).cupMl, 1000);
});

test('desktop pet scale is stepped and clamped', () => {
  assert.equal(normalizeSettings({ petScale: 126 }).petScale, 130);
  assert.equal(normalizeSettings({ petScale: 20 }).petScale, 70);
  assert.equal(normalizeSettings({ petScale: 200 }).petScale, 140);
});

test('default plan excludes every reminder from the lunch break', () => {
  const plan = buildDailyPlan(DEFAULT_SETTINGS);
  assert.equal(plan.cupCount, 8);
  assert.equal(plan.reminders[0].time, '08:00');
  assert.equal(plan.reminders.at(-1).time, '22:00');
  assert.ok(plan.reminders.every((item) => item.minuteOfDay < 750 || item.minuteOfDay >= 840));
});

test('active time is distributed evenly across both sides of a break', () => {
  const plan = buildDailyPlan({
    ...DEFAULT_SETTINGS,
    targetMl: 1800,
    cupMl: 300,
    startTime: '09:00',
    endTime: '21:00',
    restStartTime: '12:00',
    restEndTime: '14:00'
  });
  assert.deepEqual(plan.reminders.map((item) => item.time), [
    '09:00',
    '11:00',
    '15:00',
    '17:00',
    '19:00',
    '21:00'
  ]);
});

test('plan without a break includes evenly spaced reminders', () => {
  const plan = buildDailyPlan({ ...DEFAULT_SETTINGS, restEnabled: false });
  assert.deepEqual(plan.reminders.map((item) => item.time), [
    '08:00',
    '10:00',
    '12:00',
    '14:00',
    '16:00',
    '18:00',
    '20:00',
    '22:00'
  ]);
});

test('invalid break outside the drinking period is rejected', () => {
  assert.throws(
    () => buildDailyPlan({ ...DEFAULT_SETTINGS, restStartTime: '07:00' }),
    /完整位于喝水时段内/
  );
});

test('date key uses local calendar fields', () => {
  assert.equal(localDateKey(new Date(2026, 7, 10, 23, 59)), '2026-08-10');
});
