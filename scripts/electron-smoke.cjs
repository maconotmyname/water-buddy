'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require('playwright');

const projectRoot = path.resolve(__dirname, '..');
const electronExecutable = process.env.WATER_BUDDY_EXECUTABLE
  ? path.resolve(process.env.WATER_BUDDY_EXECUTABLE)
  : path.join(projectRoot, 'node_modules', 'electron', 'dist', 'electron.exe');
const launchArguments = process.env.WATER_BUDDY_EXECUTABLE ? [] : [projectRoot];
const artifactsDir = path.join(projectRoot, 'artifacts');
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'water-buddy-smoke-'));
const monday = new Date(2026, 7, 10, 8, 0, 0, 0);
let launchNowMs = monday.getTime();

function dateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

fs.writeFileSync(path.join(userDataDir, 'water-buddy.json'), `${JSON.stringify({
  settings: {
    targetMl: 2250,
    cupMl: 250,
    startTime: '08:30',
    endTime: '22:00',
    restEnabled: true,
    restStartTime: '12:30',
    restEndTime: '14:00',
    alwaysOnTop: true,
    launchAtLogin: false,
    petScale: 100
  },
  ui: { compact: false },
  daily: { date: dateKey(monday), consumedMl: 0, notifiedTimes: [] }
}, null, 2)}\n`, 'utf8');

async function launchApp() {
  return electron.launch({
    executablePath: electronExecutable,
    args: launchArguments,
    cwd: projectRoot,
    timeout: 20_000,
    env: {
      ...process.env,
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
      WATER_BUDDY_USER_DATA_DIR: userDataDir,
      WATER_BUDDY_TEST_MODE: 'true',
      WATER_BUDDY_TEST_NOW: String(launchNowMs)
    }
  });
}

async function stopApp(electronApp) {
  const closePromise = electronApp.waitForEvent('close');
  await electronApp.evaluate(({ app }) => app.quit());
  await Promise.race([
    closePromise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('Electron app did not close within 10 seconds.')), 10_000))
  ]);
}

function observeWindow(window, errors) {
  window.on('pageerror', (error) => errors.push(error.message));
  window.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
}

function getWindowBounds(electronApp) {
  return electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds());
}

async function getReminderWindowState(electronApp, window) {
  const native = await electronApp.evaluate(({ BrowserWindow }) => {
    const mainWindow = BrowserWindow.getAllWindows()[0];
    return {
      visible: mainWindow.isVisible(),
      minimized: mainWindow.isMinimized(),
      focused: mainWindow.isFocused(),
      alwaysOnTop: mainWindow.isAlwaysOnTop(),
      bounds: mainWindow.getBounds()
    };
  });
  const renderer = await window.evaluate(() => ({
    compact: document.body.classList.contains('is-compact'),
    peek: document.body.classList.contains('is-pet-peek')
  }));
  return { ...native, ...renderer };
}

async function waitUntil(check, description, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  let lastError;

  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  const detail = lastError ? ` Last error: ${lastError.message}` : '';
  throw new Error(`Timed out waiting for ${description}.${detail}`);
}

(async () => {
  fs.mkdirSync(artifactsDir, { recursive: true });
  const errors = [];
  console.log('Smoke stage: launching Electron');
  let electronApp = await launchApp();
  console.log('Smoke stage: Electron launched, waiting for first window');
  let window = await electronApp.firstWindow({ timeout: 20_000 });
  observeWindow(window, errors);
  console.log('Smoke stage: initial window');

  await waitUntil(
    async () => (await window.locator('[data-plan-summary]').textContent()) !== '加载中',
    'the initial plan summary'
  );
  assert.equal(await window.locator('[data-consumed]').textContent(), '0');

  console.log('Smoke stage: automatic profiles and migration');
  let profileModel = await window.evaluate(() => window.waterBuddy.getModel());
  assert.equal(profileModel.runtime.mode, 'work');
  assert.equal(profileModel.runtime.automaticMode, 'work');
  assert.equal(profileModel.runtime.modeOverridden, false);
  assert.equal(profileModel.profiles.work.targetMl, 2250);
  assert.equal(profileModel.profiles.work.startTime, '08:30');
  assert.equal(profileModel.profiles.holiday.startTime, '09:30');
  assert.equal(await window.locator('body.is-holiday').count(), 0);
  assert.deepEqual(profileModel.history[dateKey(monday)], {
    consumedMl: 0,
    targetMl: 2250,
    percent: 0,
    closed: false,
    mode: 'work'
  });

  await window.locator('[data-mode="holiday"]').click();
  await waitUntil(async () => (await window.locator('body').getAttribute('data-mode')) === 'holiday', 'holiday mode');
  profileModel = await window.evaluate(() => window.waterBuddy.getModel());
  assert.equal(profileModel.runtime.mode, 'holiday');
  assert.equal(profileModel.runtime.modeOverridden, true);
  assert.equal(profileModel.daily.consumedMl, 0);
  assert.equal(await window.locator('body.is-holiday').count(), 1);
  const holidayPalette = await window.evaluate(() => {
    const style = getComputedStyle(document.body);
    return {
      panel: style.getPropertyValue('--app-panel').trim(),
      water: style.getPropertyValue('--app-water').trim(),
      coral: style.getPropertyValue('--app-coral').trim()
    };
  });
  assert.deepEqual(holidayPalette, { panel: '#29212f', water: '#69d7c7', coral: '#ef826f' });

  await window.locator('[data-open-settings]').click();
  assert.equal(await window.locator('[data-settings-mode="holiday"]').getAttribute('aria-selected'), 'true');
  await window.locator('[data-cup-input]').fill('875');
  await window.locator('[data-cup-input]').press('Tab');
  assert.equal(await window.locator('[data-cup-input]').inputValue(), '875');
  assert.match(await window.locator('[data-preview-title]').textContent(), /2 杯 × 875 mL = 1750 mL/);
  await window.locator('[data-target-input]').fill('2100');
  await window.locator('[data-cup-input]').fill('300');
  await window.locator('[data-cup-input]').press('Tab');
  await window.locator('[data-start-time]').fill('10:00');
  await window.locator('[data-end-time]').fill('23:00');
  await window.locator('[data-rest-start]').fill('13:30');
  await window.locator('[data-rest-end]').fill('15:00');
  await waitUntil(async () => !(await window.locator('[data-save-settings]').isDisabled()), 'settings to become valid');
  await window.locator('[data-save-settings]').click();
  await waitUntil(async () => (await window.locator('[data-target]').textContent()) === '2100', 'holiday target update');

  await window.locator('[data-mode="work"]').click();
  await waitUntil(async () => (await window.locator('body').getAttribute('data-mode')) === 'work', 'work mode');
  profileModel = await window.evaluate(() => window.waterBuddy.getModel());
  assert.equal(profileModel.plan.targetMl, 2250);
  assert.equal(profileModel.plan.cupMl, 250);
  assert.equal(profileModel.profiles.holiday.targetMl, 2100);
  assert.equal(profileModel.profiles.holiday.cupMl, 300);

  await window.locator('[data-mode="holiday"]').click();
  await stopApp(electronApp);
  electronApp = await launchApp();
  window = await electronApp.firstWindow();
  observeWindow(window, errors);
  await waitUntil(async () => (await window.locator('body').getAttribute('data-mode')) === 'holiday', 'persisted holiday mode');
  profileModel = await window.evaluate(() => window.waterBuddy.getModel());
  assert.equal(profileModel.runtime.modeOverridden, true);
  assert.equal(profileModel.profiles.holiday.targetMl, 2100);
  assert.equal(profileModel.profiles.work.targetMl, 2250);

  const tuesday = new Date(2026, 7, 11, 8, 0, 0, 0);
  profileModel = await window.evaluate((timestamp) => window.waterBuddy.testSetNow(timestamp), tuesday.getTime());
  assert.equal(profileModel.runtime.mode, 'work');
  assert.equal(profileModel.runtime.modeOverridden, false);
  assert.equal(profileModel.daily.consumedMl, 0);
  for (let index = 0; index < 9; index += 1) {
    profileModel = await window.evaluate(() => window.waterBuddy.drink());
  }
  assert.equal(profileModel.daily.consumedMl, 2250);
  assert.equal(profileModel.history[dateKey(tuesday)].closed, true);
  assert.equal(profileModel.history[dateKey(tuesday)].percent, 100);

  const saturday = new Date(2026, 7, 15, 8, 0, 0, 0);
  profileModel = await window.evaluate((timestamp) => window.waterBuddy.testSetNow(timestamp), saturday.getTime());
  assert.equal(profileModel.runtime.mode, 'holiday');
  assert.equal(profileModel.runtime.automaticMode, 'holiday');
  await waitUntil(async () => (await window.locator('body').getAttribute('data-mode')) === 'holiday', 'automatic holiday mode');

  const followingMonday = new Date(2026, 7, 17, 8, 0, 0, 0);
  profileModel = await window.evaluate((timestamp) => window.waterBuddy.testSetNow(timestamp), followingMonday.getTime());
  assert.equal(profileModel.runtime.mode, 'work');
  assert.equal(profileModel.runtime.automaticMode, 'work');
  await waitUntil(async () => (await window.locator('body').getAttribute('data-mode')) === 'work', 'automatic work mode');

  await window.locator('[data-schedule-view="month"]').click();
  await waitUntil(async () => await window.locator('[data-month-view]').isVisible(), 'month view');
  assert.equal(await window.locator('.month-day').count(), 42);
  const closedDay = window.locator(`.month-day[data-date="${dateKey(tuesday)}"].is-closed`);
  assert.equal(await closedDay.count(), 1);
  assert.equal(await closedDay.locator('svg').evaluate((svg) => getComputedStyle(svg).display), 'none');
  assert.match(
    await closedDay.locator('.month-day-number').evaluate((number) => getComputedStyle(number).clipPath),
    /polygon/
  );
  assert.match(await window.locator('[data-month-summary]').textContent(), /闭环 1 天/);
  assert.equal(await window.locator('[data-month-label]').textContent(), '2026年8月');
  assert.equal(await window.locator('[data-month-shift="1"]').isDisabled(), true);
  await window.screenshot({ path: path.join(artifactsDir, 'month-history.png') });
  await window.locator('[data-month-shift="-1"]').click();
  assert.equal(await window.locator('[data-month-label]').textContent(), '2026年7月');
  assert.equal(await window.locator('[data-month-shift="1"]').isDisabled(), false);
  await window.locator('[data-month-shift="1"]').click();
  await window.locator('[data-schedule-view="today"]').click();

  const hostClock = new Date();
  const runtimeDay = new Date(2026, 7, 20, hostClock.getHours(), hostClock.getMinutes(), 0, 0);
  launchNowMs = runtimeDay.getTime();
  await window.evaluate((timestamp) => window.waterBuddy.testSetNow(timestamp), launchNowMs);
  await window.evaluate(() => window.waterBuddy.setMode('work'));
  await waitUntil(async () => (await window.locator('body').getAttribute('data-mode')) === 'work', 'runtime work mode');

  const timerWindow = await window.evaluate(() => {
    const now = new Date();
    const currentMinutes = now.getHours() * 60 + now.getMinutes();
    const startMinutes = currentMinutes === 1439 ? 1438 : currentMinutes;
    const endMinutes = currentMinutes >= 1438 ? 1439 : currentMinutes + 60;
    const format = (value) => `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
    return { startTime: format(startMinutes), endTime: format(endMinutes) };
  });
  const timerResult = await window.evaluate(async (times) => window.waterBuddy.saveSettings({
    targetMl: 500,
    cupMl: 500,
    startTime: times.startTime,
    endTime: times.endTime,
    restEnabled: false,
    restStartTime: '12:30',
    restEndTime: '14:00',
    alwaysOnTop: false,
    launchAtLogin: false,
    petScale: 100
  }), timerWindow);
  assert.equal(timerResult.ok, true);
  await window.locator('[data-toast].is-visible').waitFor({ timeout: 10_000 });
  assert.equal(await window.locator('[data-toast]').textContent(), '喝水时间到了');
  const runtime = await window.evaluate(() => window.waterBuddy.getModel());
  assert.equal(runtime.runtime.notificationSupported, true);
  await window.evaluate(() => window.waterBuddy.saveSettings({
    targetMl: 2000,
    cupMl: 250,
    startTime: '08:00',
    endTime: '22:00',
    restEnabled: true,
    restStartTime: '12:30',
    restEndTime: '14:00',
    alwaysOnTop: false,
    launchAtLogin: false,
    petScale: 100
  }));
  await waitUntil(async () => (await window.locator('[data-target]').textContent()) === '2000', 'restored target');
  assert.equal(
    await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isAlwaysOnTop()),
    false
  );

  await window.locator('[data-show-tip]').click();
  assert.match(await window.locator('[data-bubble]').textContent(), /补水小贴士/);

  await window.locator('[data-drink]:not([disabled])').waitFor({ timeout: 10_000 });
  await window.locator('[data-drink]').click();
  await waitUntil(async () => (await window.locator('[data-consumed]').textContent()) === '250', 'drink progress');

  await window.locator('[data-open-settings]').click();
  await window.locator('[data-target-input]').fill('2000');
  await window.locator('[data-cup-input]').fill('300');
  await window.locator('[data-cup-input]').press('Tab');
  await waitUntil(async () => (await window.locator('[data-target-input]').inputValue()) === '2100', 'whole-cup target');
  assert.match(await window.locator('[data-preview-title]').textContent(), /7 杯/);

  await window.locator('[data-target-input]').fill('1800');
  await window.locator('[data-start-time]').fill('09:00');
  await window.locator('[data-end-time]').fill('21:00');
  await window.locator('[data-rest-start]').fill('12:00');
  await window.locator('[data-rest-end]').fill('14:00');
  await window.locator('[data-pet-scale]').evaluate((input) => {
    input.value = '130';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  assert.equal(await window.locator('[data-pet-scale-value]').textContent(), '130%');
  await waitUntil(async () => !(await window.locator('[data-save-settings]').isDisabled()), 'updated settings to become valid');
  await window.screenshot({ path: path.join(artifactsDir, 'settings.png') });
  await window.locator('[data-save-settings]').click();
  await waitUntil(async () => (await window.locator('[data-target]').textContent()) === '1800', 'saved target');
  await window.waitForTimeout(300);

  assert.equal(await window.locator('.time-item.is-rest').count(), 1);
  const reminderTimes = await window.locator('.time-item:not(.is-rest) .time-value').allTextContents();
  assert.ok(reminderTimes.every((time) => time < '12:00' || time >= '14:00'));
  await window.waitForTimeout(2600);
  await window.screenshot({ path: path.join(artifactsDir, 'main.png') });

  await window.locator('[data-hide-window]').click();
  await window.waitForTimeout(150);
  const hidden = await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible());
  assert.equal(hidden, false);
  await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show());

  await stopApp(electronApp);
  electronApp = await launchApp();
  window = await electronApp.firstWindow();
  observeWindow(window, errors);
  console.log('Smoke stage: compact mode');
  await waitUntil(async () => (await window.locator('[data-target]').textContent()) === '1800', 'persisted target');
  assert.equal(await window.locator('[data-consumed]').textContent(), '250');

  await window.locator('[data-compact-window]').click();
  await waitUntil(async () => (await window.locator('body.is-compact').count()) === 1, 'compact mode');
  await window.waitForTimeout(300);
  const compactBounds = await getWindowBounds(electronApp);
  assert.ok(Math.abs(compactBounds.width - 195) <= 2, `Unexpected compact width: ${compactBounds.width}`);
  assert.ok(Math.abs(compactBounds.height - 229) <= 2, `Unexpected compact height: ${compactBounds.height}`);
  assert.equal(
    await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isAlwaysOnTop()),
    true
  );
  await window.screenshot({ path: path.join(artifactsDir, 'compact.png'), omitBackground: true });

  const compactConsumed = Number(await window.locator('[data-consumed]').textContent());
  profileModel = await window.evaluate(() => window.waterBuddy.setMode('holiday'));
  assert.equal(profileModel.daily.consumedMl, compactConsumed);
  await waitUntil(async () => (await window.locator('body.is-holiday').count()) === 1, 'compact holiday theme');

  const mascot = window.locator('[data-show-tip]');
  await mascot.dispatchEvent('pointerenter', { pointerId: 2, pointerType: 'mouse' });
  await waitUntil(async () => (await window.locator('body.is-pet-peek').count()) === 1, 'pet status');
  await window.waitForTimeout(200);
  const peekBounds = await getWindowBounds(electronApp);
  assert.ok(Math.abs(peekBounds.width - 244) <= 2, `Unexpected status width: ${peekBounds.width}`);
  assert.ok(Math.abs(peekBounds.height - 280) <= 2, `Unexpected status height: ${peekBounds.height}`);
  assert.equal(await window.locator('.energy-cell').count(), 7);
  assert.equal(await window.locator('[data-pet-completed]').textContent(), '0');
  assert.equal(await window.locator('[data-pet-remaining]').textContent(), '还要 7 杯');
  assert.equal(
    await window.locator('[data-pet-status]').evaluate((element) => getComputedStyle(element).backgroundColor),
    'rgb(41, 33, 47)'
  );
  profileModel = await window.evaluate(() => window.waterBuddy.setMode('work'));
  assert.equal(profileModel.daily.consumedMl, compactConsumed);
  await waitUntil(async () => (await window.locator('body.is-holiday').count()) === 0, 'compact work theme');
  await window.locator('[data-pet-drink]').click();
  await waitUntil(async () => (await window.locator('[data-pet-completed]').textContent()) === '1', 'compact drink progress');
  assert.equal(await window.locator('.energy-cell.is-filled').count(), 1);
  assert.equal(await window.locator('[data-period-status]').textContent(), '已记录 +1 杯');
  await window.screenshot({ path: path.join(artifactsDir, 'compact-status.png'), omitBackground: true });
  console.log('Smoke stage: hover status rendered');

  await window.locator('[data-pet-status]').dispatchEvent('pointerleave', { pointerId: 2, pointerType: 'mouse' });
  await window.waitForTimeout(400);
  assert.equal(await window.locator('body.is-pet-peek').count(), 1);
  await mascot.click();
  await waitUntil(async () => (await window.locator('body.is-pet-peek').count()) === 0, 'closed pet status');
  await window.waitForTimeout(150);

  const beforeDrag = await getWindowBounds(electronApp);
  await mascot.dispatchEvent('pointerdown', {
    pointerId: 1,
    pointerType: 'mouse',
    button: 0,
    buttons: 1,
    screenX: 600,
    screenY: 500
  });
  await mascot.dispatchEvent('pointermove', {
    pointerId: 1,
    pointerType: 'mouse',
    button: 0,
    buttons: 1,
    screenX: 564,
    screenY: 472
  });
  await mascot.dispatchEvent('pointerup', {
    pointerId: 1,
    pointerType: 'mouse',
    button: 0,
    buttons: 0,
    screenX: 564,
    screenY: 472
  });
  await window.waitForTimeout(200);
  const afterDrag = await getWindowBounds(electronApp);
  assert.ok(
    afterDrag.x !== beforeDrag.x || afterDrag.y !== beforeDrag.y,
    'Dragging the compact pet did not move the window.'
  );
  await mascot.dispatchEvent('click');
  assert.equal(await window.locator('body.is-compact').count(), 1);
  await mascot.click();
  await waitUntil(async () => (await window.locator('body.is-pet-peek').count()) === 1, 'pinned pet status');
  await mascot.dispatchEvent('pointerleave', { pointerId: 3, pointerType: 'mouse' });
  await window.waitForTimeout(400);
  assert.equal(await window.locator('body.is-pet-peek').count(), 1);
  await window.locator('[data-expand-window]').click();
  console.log('Smoke stage: drag and pinned status passed');
  await waitUntil(async () => (await window.locator('body.is-compact').count()) === 0, 'expanded mode');
  await window.waitForTimeout(300);
  const expandedBounds = await getWindowBounds(electronApp);
  assert.ok(Math.abs(expandedBounds.width - 360) <= 2, `Unexpected expanded width: ${expandedBounds.width}`);
  assert.ok(Math.abs(expandedBounds.height - 660) <= 2, `Unexpected expanded height: ${expandedBounds.height}`);
  assert.equal(
    await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isAlwaysOnTop()),
    false
  );

  await window.locator('[data-compact-window]').click();
  await waitUntil(async () => (await window.locator('body.is-compact').count()) === 1, 'compact mode before restart');
  await stopApp(electronApp);

  electronApp = await launchApp();
  window = await electronApp.firstWindow();
  observeWindow(window, errors);
  console.log('Smoke stage: persisted compact restart');
  await waitUntil(async () => (await window.locator('body.is-compact').count()) === 1, 'restored compact mode');
  const restoredCompactBounds = await getWindowBounds(electronApp);
  assert.ok(Math.abs(restoredCompactBounds.width - 195) <= 2);
  assert.ok(Math.abs(restoredCompactBounds.height - 229) <= 2);
  assert.equal(
    await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isAlwaysOnTop()),
    true
  );
  await window.locator('[data-show-tip]').dispatchEvent('pointerenter', { pointerId: 4, pointerType: 'mouse' });
  await waitUntil(async () => (await window.locator('body.is-pet-peek').count()) === 1, 'restored pet status');
  assert.equal(await window.locator('[data-pet-completed]').textContent(), '1');

  const nextDayDate = new Date(runtimeDay);
  nextDayDate.setDate(nextDayDate.getDate() + 1);
  const nextDay = { timestamp: nextDayDate.getTime(), key: dateKey(nextDayDate) };
  const rolledModel = await window.evaluate((value) => window.waterBuddy.testSetNow(value), nextDay.timestamp);
  const previousDateKey = dateKey(new Date(nextDay.timestamp - 24 * 60 * 60 * 1000));
  assert.equal(rolledModel.daily.date, nextDay.key);
  assert.equal(rolledModel.daily.consumedMl, 0);
  assert.deepEqual(rolledModel.daily.notifiedTimes, []);
  assert.ok(rolledModel.history[previousDateKey]);
  assert.equal(rolledModel.history[previousDateKey].closed, false);
  await waitUntil(async () => {
    return (await window.locator('[data-pet-completed]').textContent()) === '0' &&
      (await window.locator('.energy-cell.is-filled').count()) === 0 &&
      (await window.locator('body').getAttribute('data-date')) === nextDay.key;
  }, 'next-day pet reset');
  assert.equal(await window.locator('[data-pet-remaining]').textContent(), `还要 ${rolledModel.plan.cupCount} 杯`);
  await window.locator('[data-pet-drink]').click();
  await waitUntil(async () => (await window.locator('[data-pet-completed]').textContent()) === '1', 'next-day drink progress');
  assert.equal(await window.locator('.energy-cell.is-filled').count(), 1);
  assert.equal(await window.locator('[data-period-status]').textContent(), '已记录 +1 杯');
  console.log('Smoke stage: next-day reset and pet drink passed');

  await window.locator('[data-hide-pet]').click();
  await waitUntil(async () => {
    return !(await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()));
  }, 'compact pet hidden to tray');
  assert.equal(
    await electronApp.evaluate(({ app, BrowserWindow }) => app.isReady() && BrowserWindow.getAllWindows().length === 1),
    true
  );
  console.log('Smoke stage: compact pet minimize-to-tray passed');

  // Exercise real scheduled reminders; capture native notification requests without
  // filling the user's Windows notification center with test messages.
  await electronApp.evaluate(({ Notification }) => {
    globalThis.smokeNotificationCount = 0;
    Notification.prototype.show = function () {
      globalThis.smokeNotificationCount += 1;
    };
  });
  await window.evaluate(() => {
    window.smokeReminders = [];
    window.waterBuddy.onReminder((reminder) => window.smokeReminders.push(reminder));
  });
  try {
    const cases = [
      { label: 'hidden pet', visible: false, compact: true },
      { label: 'hidden pet again', visible: false, compact: true },
      { label: 'visible pet', visible: true, compact: true },
      { label: 'visible full window', visible: true, compact: false },
      { label: 'hidden full window', visible: false, compact: false }
    ];
    let delivered = 0;
    for (const scenario of cases) {
      if (!scenario.compact) await window.evaluate(() => window.waterBuddy.windowAction('expand'));
      await electronApp.evaluate(({ BrowserWindow }, visible) => {
        const mainWindow = BrowserWindow.getAllWindows()[0];
        if (visible) mainWindow.showInactive();
        else mainWindow.hide();
      }, scenario.visible);
      await window.waitForTimeout(400);

      const model = await window.evaluate(() => window.waterBuddy.getModel());
      const reminder = model.plan.reminders.find((item) =>
        (item.index + 1) * model.plan.cupMl > model.daily.consumedMl &&
        !model.daily.notifiedTimes.includes(item.time)
      );
      assert.ok(reminder, `No pending reminder for ${scenario.label}`);
      const dueAt = new Date(nextDay.timestamp);
      const [hour, minute] = reminder.time.split(':').map(Number);
      dueAt.setHours(hour, minute, 0, 0);
      await window.evaluate((timestamp) => window.waterBuddy.testSetNow(timestamp), dueAt.getTime());
      const saved = await window.evaluate((settings) => window.waterBuddy.saveSettings(settings), model.settings);
      assert.equal(saved.ok, true);
      const before = await getReminderWindowState(electronApp, window);
      assert.equal(before.visible, scenario.visible);
      assert.equal(before.compact, scenario.compact);

      delivered += 1;
      await waitUntil(async () => (await window.evaluate(() => window.smokeReminders.length)) === delivered,
        `scheduled reminder in ${scenario.label}`);
      assert.deepEqual(await getReminderWindowState(electronApp, window), before,
        `Reminder changed the window state in ${scenario.label}`);
      const notifiedModel = await window.evaluate(() => window.waterBuddy.getModel());
      assert.ok(notifiedModel.daily.notifiedTimes.includes(reminder.time));
      assert.equal(await electronApp.evaluate(() => globalThis.smokeNotificationCount),
        model.runtime.notificationSupported ? delivered : 0);
      console.log(`Smoke stage: reminder preserves ${scenario.label}`);
    }
  } finally {
    await stopApp(electronApp);
  }

  if (errors.length) throw new Error(`Renderer errors: ${errors.join(' | ')}`);
  console.log('Electron smoke test passed: scalable pet mode, hover status grid, minimize-to-tray, dragging, reminders, and persistence.');
})()
  .finally(() => {
    const tempRoot = path.resolve(os.tmpdir());
    const resolvedUserData = path.resolve(userDataDir);
    if (resolvedUserData.startsWith(`${tempRoot}${path.sep}`)) {
      try {
        fs.rmSync(resolvedUserData, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
      } catch (error) {
        console.warn(`Could not remove smoke-test data: ${error.message}`);
      }
    }
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
