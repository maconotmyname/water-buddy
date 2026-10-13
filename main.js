'use strict';

const {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  powerMonitor,
  screen,
  Tray
} = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const {
  DEFAULT_SETTINGS,
  buildDailyPlan,
  localDateKey,
  normalizeSettings,
  timeToMinutes
} = require('./src/shared/schedule');
const {
  createHistoryRecord,
  normalizeHistory,
  pruneHistory
} = require('./src/shared/history');

const APP_ID = 'com.byai.waterbuddy';
const PROFILE_MODES = new Set(['work', 'holiday']);
const REMINDER_GRACE_MS = 10 * 60 * 1000;
const MAX_TIMEOUT_MS = 2_147_000_000;
const FULL_WINDOW = Object.freeze({ width: 360, height: 660 });
const COMPACT_WINDOW = Object.freeze({ width: 150, height: 176 });
const PET_PEEK_WIDTH = 244;
const PET_PEEK_PANEL_HEIGHT = 104;
const HOLIDAY_DEFAULT_SETTINGS = Object.freeze({
  ...DEFAULT_SETTINGS,
  startTime: '09:30',
  endTime: '22:30',
  restStartTime: '13:00',
  restEndTime: '14:30'
});

let mainWindow = null;
let tray = null;
let reminderTimer = null;
let maintenanceTimer = null;
let dayRolloverTimer = null;
let isQuitting = false;
let petPeekOpen = false;
let store = null;
let storePath = null;
const initialTestNowMs = Number(process.env.WATER_BUDDY_TEST_NOW);
let testNowMs = process.env.WATER_BUDDY_TEST_MODE === 'true' && Number.isFinite(initialTestNowMs)
  ? initialTestNowMs
  : null;

if (process.env.WATER_BUDDY_USER_DATA_DIR) {
  app.setPath('userData', path.resolve(process.env.WATER_BUDDY_USER_DATA_DIR));
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => showMainWindow(false, true));
}

function defaultStore() {
  const mode = automaticMode();
  const profiles = {
    work: { ...DEFAULT_SETTINGS },
    holiday: { ...HOLIDAY_DEFAULT_SETTINGS }
  };
  return {
    profiles,
    ui: { compact: false, modeOverride: null },
    daily: {
      date: localDateKey(currentDate()),
      consumedMl: 0,
      notifiedTimes: [],
      targetMl: profiles[mode].targetMl,
      mode
    },
    history: {}
  };
}

function currentDate() {
  return testNowMs == null ? new Date() : new Date(testNowMs);
}

function automaticMode(date = currentDate()) {
  return date.getDay() === 0 || date.getDay() === 6 ? 'holiday' : 'work';
}

function activeMode() {
  const override = store?.ui?.modeOverride;
  if (
    override?.date === localDateKey(currentDate()) &&
    PROFILE_MODES.has(override.mode)
  ) {
    return override.mode;
  }
  return automaticMode();
}

function activeSettings() {
  return store.profiles[activeMode()];
}

function modeForDateKey(dateKey) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey || '');
  if (!match) return 'work';
  return automaticMode(new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12));
}

function historyRecordForDaily(daily) {
  const mode = PROFILE_MODES.has(daily?.mode) ? daily.mode : modeForDateKey(daily?.date);
  const fallbackTarget = store.profiles[mode]?.targetMl || DEFAULT_SETTINGS.targetMl;
  return createHistoryRecord({
    consumedMl: daily?.consumedMl,
    targetMl: Number(daily?.targetMl) || fallbackTarget,
    mode
  });
}

function syncTodayHistory() {
  const plan = serializedPlan();
  const mode = activeMode();
  store.daily.targetMl = plan.targetMl;
  store.daily.mode = mode;
  store.history[store.daily.date] = createHistoryRecord({
    consumedMl: store.daily.consumedMl,
    targetMl: plan.targetMl,
    mode
  });
  store.history = pruneHistory(store.history, currentDate());
}

function loadStore() {
  storePath = path.join(app.getPath('userData'), 'water-buddy.json');
  let loaded = defaultStore();
  try {
    if (fs.existsSync(storePath)) {
      const parsed = JSON.parse(fs.readFileSync(storePath, 'utf8'));
      const migratedWork = normalizeSettings({
        ...DEFAULT_SETTINGS,
        ...(parsed.profiles?.work || parsed.settings)
      });
      const migratedHoliday = normalizeSettings({
        ...HOLIDAY_DEFAULT_SETTINGS,
        alwaysOnTop: migratedWork.alwaysOnTop,
        launchAtLogin: migratedWork.launchAtLogin,
        petScale: migratedWork.petScale,
        ...parsed.profiles?.holiday
      });
      const savedOverride = parsed.ui?.modeOverride;
      loaded = {
        profiles: {
          work: migratedWork,
          holiday: migratedHoliday
        },
        ui: {
          compact: Boolean(parsed.ui?.compact),
          modeOverride: savedOverride && PROFILE_MODES.has(savedOverride.mode)
            ? { date: savedOverride.date, mode: savedOverride.mode }
            : null
        },
        daily: {
          date: parsed.daily?.date,
          consumedMl: Number(parsed.daily?.consumedMl) || 0,
          notifiedTimes: Array.isArray(parsed.daily?.notifiedTimes)
            ? parsed.daily.notifiedTimes.filter((value) => typeof value === 'string')
            : [],
          targetMl: Number(parsed.daily?.targetMl) || 0,
          mode: PROFILE_MODES.has(parsed.daily?.mode) ? parsed.daily.mode : null
        },
        history: normalizeHistory(parsed.history)
      };
      buildDailyPlan(loaded.profiles.work);
      buildDailyPlan(loaded.profiles.holiday);
    }
  } catch (error) {
    console.warn('Could not read saved settings; using defaults.', error);
    loaded = defaultStore();
  }
  store = loaded;
  ensureCurrentDay();
  syncTodayHistory();
  saveStore();
}

function saveStore() {
  if (!storePath || !store) return;
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(storePath, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
}

function ensureCurrentDay() {
  const today = localDateKey(currentDate());
  let changed = false;
  if (store.daily.date !== today) {
    if (store.daily.date) store.history[store.daily.date] = historyRecordForDaily(store.daily);
    store.ui.modeOverride = null;
    const mode = automaticMode();
    store.daily = {
      date: today,
      consumedMl: 0,
      notifiedTimes: [],
      targetMl: store.profiles[mode].targetMl,
      mode
    };
    changed = true;
  }
  if (store.ui.modeOverride && store.ui.modeOverride.date !== today) {
    store.ui.modeOverride = null;
    changed = true;
  }
  if (changed) {
    syncTodayHistory();
    saveStore();
  }
  return changed;
}

function serializedPlan() {
  const plan = buildDailyPlan(activeSettings());
  return {
    targetMl: plan.targetMl,
    cupMl: plan.cupMl,
    cupCount: plan.cupCount,
    intervalMinutes: plan.intervalMinutes,
    intervalLabel: plan.intervalLabel,
    restEnabled: plan.settings.restEnabled,
    restStartTime: plan.settings.restStartTime,
    restEndTime: plan.settings.restEndTime,
    reminders: plan.reminders
  };
}

function viewModel() {
  const plan = serializedPlan();
  const mode = activeMode();
  return {
    settings: { ...store.profiles[mode] },
    profiles: {
      work: { ...store.profiles.work },
      holiday: { ...store.profiles.holiday }
    },
    daily: {
      date: store.daily.date,
      consumedMl: Math.min(store.daily.consumedMl, plan.targetMl),
      notifiedTimes: [...store.daily.notifiedTimes],
      targetMl: store.daily.targetMl,
      mode: store.daily.mode
    },
    history: { ...store.history },
    plan,
    runtime: {
      notificationSupported: Notification.isSupported(),
      packaged: app.isPackaged,
      compact: Boolean(store.ui.compact),
      mode,
      automaticMode: automaticMode(),
      modeOverridden: Boolean(store.ui.modeOverride)
    }
  };
}

function refreshCurrentDay(broadcast = true) {
  if (!ensureCurrentDay()) return false;
  scheduleNextReminder();
  if (broadcast) broadcastModel();
  else updateTrayMenu();
  scheduleDayRollover();
  return true;
}

function broadcastModel() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('water-buddy:model', viewModel());
  }
  updateTrayMenu();
}

function positionMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const bounds = mainWindow.getBounds();
  const x = Math.round(display.workArea.x + display.workArea.width - bounds.width - 18);
  const y = Math.round(display.workArea.y + display.workArea.height - bounds.height - 18);
  mainWindow.setPosition(x, y, false);
}

function compactWindowSize() {
  const scale = (store ? activeSettings().petScale : DEFAULT_SETTINGS.petScale) / 100;
  return {
    width: Math.round(COMPACT_WINDOW.width * scale),
    height: Math.round(COMPACT_WINDOW.height * scale)
  };
}

function petPeekWindowSize() {
  const compact = compactWindowSize();
  return {
    width: Math.max(compact.width, PET_PEEK_WIDTH),
    height: compact.height + PET_PEEK_PANEL_HEIGHT
  };
}

function resizeMainWindow(target, compact, animate = false) {
  const previous = mainWindow.getBounds();
  mainWindow.setMinimumSize(100, 100);
  mainWindow.setMaximumSize(1000, 1000);
  mainWindow.setResizable(!compact);
  mainWindow.setSkipTaskbar(compact);

  const display = screen.getDisplayMatching(previous);
  const minX = display.workArea.x;
  const minY = display.workArea.y;
  const maxX = Math.max(minX, display.workArea.x + display.workArea.width - target.width);
  const maxY = Math.max(minY, display.workArea.y + display.workArea.height - target.height);
  const desiredX = previous.x + previous.width - target.width;
  const desiredY = previous.y + previous.height - target.height;
  const x = Math.min(Math.max(desiredX, minX), maxX);
  const y = Math.min(Math.max(desiredY, minY), maxY);
  mainWindow.setBounds({ x, y, width: target.width, height: target.height }, animate);
  mainWindow.setMinimumSize(compact ? target.width : 330, compact ? target.height : 600);
  mainWindow.setMaximumSize(compact ? target.width : 420, compact ? target.height : 760);
}

function applyAlwaysOnTop() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.setAlwaysOnTop(Boolean(store.ui.compact || activeSettings().alwaysOnTop), 'floating');
}

function setActiveMode(mode) {
  if (!PROFILE_MODES.has(mode)) throw new Error('未知的喝水模式。');
  ensureCurrentDay();
  const automatic = automaticMode();
  store.ui.modeOverride = mode === automatic
    ? null
    : { date: localDateKey(currentDate()), mode };
  store.daily.notifiedTimes = [];
  syncTodayHistory();
  saveStore();
  applyRuntimeSettings();
  if (mainWindow && !mainWindow.isDestroyed() && store.ui.compact) {
    resizeMainWindow(petPeekOpen ? petPeekWindowSize() : compactWindowSize(), true, true);
  }
  scheduleNextReminder();
  broadcastModel();
  return viewModel();
}

function setCompactMode(compact, persist = true) {
  const nextCompact = Boolean(compact);
  store.ui.compact = nextCompact;
  petPeekOpen = false;
  if (persist) saveStore();
  if (!mainWindow || mainWindow.isDestroyed()) return;

  const target = nextCompact ? compactWindowSize() : FULL_WINDOW;
  resizeMainWindow(target, nextCompact, true);
  applyAlwaysOnTop();
  mainWindow.webContents.send('water-buddy:window-mode', { compact: nextCompact });
  broadcastModel();
}

function setPetPeek(open) {
  if (!mainWindow || mainWindow.isDestroyed() || !store.ui.compact) return;
  const nextOpen = Boolean(open);
  if (petPeekOpen === nextOpen) return;
  petPeekOpen = nextOpen;
  resizeMainWindow(nextOpen ? petPeekWindowSize() : compactWindowSize(), true);
}

function moveMainWindow(deltaX, deltaY) {
  if (!mainWindow || mainWindow.isDestroyed() || !store.ui.compact) return;
  if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY)) return;
  const bounds = mainWindow.getBounds();
  const display = screen.getDisplayMatching(bounds);
  const x = Math.min(
    Math.max(bounds.x + Math.round(deltaX), display.workArea.x),
    display.workArea.x + display.workArea.width - bounds.width
  );
  const y = Math.min(
    Math.max(bounds.y + Math.round(deltaY), display.workArea.y),
    display.workArea.y + display.workArea.height - bounds.height
  );
  mainWindow.setPosition(x, y, false);
}

function showMainWindow(openSettings = false, expand = false) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if ((openSettings || expand) && store.ui.compact) setCompactMode(false);
  positionMainWindow();
  mainWindow.show();
  applyAlwaysOnTop();
  mainWindow.focus();
  if (openSettings) mainWindow.webContents.send('water-buddy:open-settings');
}

function createMainWindow() {
  const initialWindow = store.ui.compact ? compactWindowSize() : FULL_WINDOW;
  mainWindow = new BrowserWindow({
    width: initialWindow.width,
    height: initialWindow.height,
    minWidth: store.ui.compact ? initialWindow.width : 330,
    minHeight: store.ui.compact ? initialWindow.height : 600,
    maxWidth: store.ui.compact ? initialWindow.width : 420,
    maxHeight: store.ui.compact ? initialWindow.height : 760,
    frame: false,
    transparent: true,
    resizable: !store.ui.compact,
    show: false,
    alwaysOnTop: Boolean(store.ui.compact || activeSettings().alwaysOnTop),
    skipTaskbar: store.ui.compact,
    fullscreenable: false,
    maximizable: false,
    backgroundColor: '#00000000',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: !app.isPackaged
    }
  });

  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  mainWindow.loadFile(path.join(__dirname, 'src', 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => {
    positionMainWindow();
    mainWindow.show();
  });
  mainWindow.on('close', (event) => {
    if (isQuitting) return;
    event.preventDefault();
    mainWindow.hide();
  });
  mainWindow.on('show', applyAlwaysOnTop);
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
}

function trayIcon() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray.png'));
  return icon.resize({ width: 24, height: 24 });
}

function createTray() {
  tray = new Tray(trayIcon());
  tray.setToolTip('水滴搭子');
  tray.on('click', () => {
    if (mainWindow?.isVisible()) mainWindow.hide();
    else showMainWindow();
  });
  tray.on('double-click', () => showMainWindow(false, true));
  updateTrayMenu();
}

function updateTrayMenu() {
  if (!tray || !store) return;
  const plan = serializedPlan();
  const consumed = Math.min(store.daily.consumedMl, plan.targetMl);
  tray.setToolTip(`水滴搭子 · ${consumed}/${plan.targetMl} mL`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `今日 ${consumed}/${plan.targetMl} mL`, enabled: false },
    { label: '喝了一杯', click: recordDrink },
    { label: '撤销上一杯', click: undoDrink, enabled: consumed > 0 },
    { type: 'separator' },
    { label: '显示完整窗口', click: () => showMainWindow(false, true) },
    {
      label: store.ui.compact ? '当前：仅显示桌宠' : '切换到桌宠模式',
      enabled: !store.ui.compact,
      click: () => {
        setCompactMode(true);
        mainWindow.show();
      }
    },
    { label: '喝水设置', click: () => showMainWindow(true) },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ]));
}

function applyRuntimeSettings() {
  applyAlwaysOnTop();
  if (app.isPackaged) {
    app.setLoginItemSettings({ openAtLogin: activeSettings().launchAtLogin });
  }
}

function recordDrink() {
  ensureCurrentDay();
  const plan = serializedPlan();
  const remaining = Math.max(0, plan.targetMl - store.daily.consumedMl);
  store.daily.consumedMl += Math.min(plan.cupMl, remaining);
  syncTodayHistory();
  saveStore();
  scheduleNextReminder();
  broadcastModel();
  return viewModel();
}

function undoDrink() {
  ensureCurrentDay();
  const plan = serializedPlan();
  store.daily.consumedMl = Math.max(0, store.daily.consumedMl - plan.cupMl);
  syncTodayHistory();
  saveStore();
  scheduleNextReminder();
  broadcastModel();
  return viewModel();
}

function reminderDate(time, baseDate = currentDate()) {
  const minuteOfDay = timeToMinutes(time);
  const result = new Date(baseDate);
  result.setHours(Math.floor(minuteOfDay / 60), minuteOfDay % 60, 0, 0);
  return result;
}

function nextPendingReminder() {
  ensureCurrentDay();
  const plan = serializedPlan();
  const now = currentDate();
  for (const reminder of plan.reminders) {
    const requiredMl = (reminder.index + 1) * plan.cupMl;
    if (store.daily.consumedMl >= requiredMl) continue;
    if (store.daily.notifiedTimes.includes(reminder.time)) continue;
    const dueAt = reminderDate(reminder.time, now);
    const delay = dueAt.getTime() - now.getTime();
    if (delay < -REMINDER_GRACE_MS) continue;
    return { reminder, delay: Math.max(750, delay) };
  }
  return null;
}

function scheduleNextReminder() {
  if (reminderTimer) clearTimeout(reminderTimer);
  const next = nextPendingReminder();
  if (!next) {
    reminderTimer = null;
    return;
  }
  reminderTimer = setTimeout(
    () => fireReminder(next.reminder),
    Math.min(next.delay, MAX_TIMEOUT_MS)
  );
}

function scheduleDayRollover() {
  if (dayRolloverTimer) clearTimeout(dayRolloverTimer);
  const now = currentDate();
  const nextDay = new Date(now);
  nextDay.setHours(24, 0, 0, 0);
  const delay = Math.max(1000, nextDay.getTime() - now.getTime() + 250);
  dayRolloverTimer = setTimeout(handleDayRollover, Math.min(delay, MAX_TIMEOUT_MS));
}

function handleDayRollover() {
  const changed = refreshCurrentDay();
  if (!changed) scheduleDayRollover();
  return changed;
}

function fireReminder(reminder) {
  ensureCurrentDay();
  const plan = serializedPlan();
  const currentReminder = plan.reminders.find((item) => item.time === reminder.time);
  if (!currentReminder) {
    scheduleNextReminder();
    return;
  }
  const requiredMl = (currentReminder.index + 1) * plan.cupMl;
  if (
    store.daily.consumedMl >= requiredMl ||
    store.daily.notifiedTimes.includes(currentReminder.time)
  ) {
    scheduleNextReminder();
    return;
  }

  store.daily.notifiedTimes.push(currentReminder.time);
  saveStore();
  const body = `现在喝一杯 ${plan.cupMl} mL 水吧。今日已完成 ${store.daily.consumedMl}/${plan.targetMl} mL。`;
  if (Notification.isSupported()) {
    const notification = new Notification({
      title: '水滴搭子提醒你喝水',
      body,
      icon: path.join(__dirname, 'assets', 'icon.png'),
      timeoutType: 'default'
    });
    notification.on('click', () => showMainWindow(false, true));
    notification.show();
  }

  if (mainWindow && !mainWindow.isDestroyed()) {
    if (!mainWindow.isVisible()) {
      positionMainWindow();
      mainWindow.showInactive();
    }
    mainWindow.flashFrame(true);
    mainWindow.webContents.send('water-buddy:reminder', {
      time: currentReminder.time,
      amountMl: plan.cupMl,
      message: body
    });
  }
  broadcastModel();
  scheduleNextReminder();
}

function registerIpc() {
  ipcMain.handle('water-buddy:get-model', () => {
    refreshCurrentDay(false);
    return viewModel();
  });
  ipcMain.handle('water-buddy:preview-settings', (_event, rawSettings) => {
    try {
      const plan = buildDailyPlan(rawSettings);
      return {
        ok: true,
        settings: plan.settings,
        plan: {
          targetMl: plan.targetMl,
          cupMl: plan.cupMl,
          cupCount: plan.cupCount,
          intervalMinutes: plan.intervalMinutes,
          intervalLabel: plan.intervalLabel,
          reminders: plan.reminders
        }
      };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });
  ipcMain.handle('water-buddy:save-settings', (_event, rawSettings, requestedMode) => {
    try {
      const plan = buildDailyPlan(rawSettings);
      const mode = PROFILE_MODES.has(requestedMode) ? requestedMode : activeMode();
      store.profiles[mode] = plan.settings;
      if (mode === activeMode()) syncTodayHistory();
      saveStore();
      if (mode === activeMode()) {
        applyRuntimeSettings();
        if (mainWindow && !mainWindow.isDestroyed() && store.ui.compact) {
          resizeMainWindow(petPeekOpen ? petPeekWindowSize() : compactWindowSize(), true, true);
        }
        scheduleNextReminder();
      }
      broadcastModel();
      return { ok: true, model: viewModel() };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });
  ipcMain.handle('water-buddy:drink', recordDrink);
  ipcMain.handle('water-buddy:undo-drink', undoDrink);
  ipcMain.handle('water-buddy:set-mode', (_event, mode) => setActiveMode(mode));
  ipcMain.handle('water-buddy:window-action', (_event, action) => {
    if (action === 'hide' || action === 'minimize') mainWindow?.hide();
    if (action === 'settings') showMainWindow(true);
    if (action === 'compact') setCompactMode(true);
    if (action === 'expand') showMainWindow(false, true);
    return viewModel();
  });
  ipcMain.on('water-buddy:move-window', (_event, movement) => {
    moveMainWindow(Number(movement?.deltaX), Number(movement?.deltaY));
  });
  ipcMain.on('water-buddy:pet-peek', (_event, open) => {
    setPetPeek(open);
  });
  if (process.env.WATER_BUDDY_TEST_MODE === 'true') {
    ipcMain.handle('water-buddy:test-set-now', (_event, timestamp) => {
      const parsed = Number(timestamp);
      if (!Number.isFinite(parsed)) throw new Error('Invalid test timestamp.');
      testNowMs = parsed;
      handleDayRollover();
      return viewModel();
    });
  }
}

function startMaintenance() {
  maintenanceTimer = setInterval(() => {
    refreshCurrentDay();
  }, 30_000);
  powerMonitor.on('resume', () => {
    handleDayRollover();
    applyAlwaysOnTop();
  });
}

app.whenReady().then(() => {
  app.setAppUserModelId(APP_ID);
  loadStore();
  registerIpc();
  createMainWindow();
  createTray();
  applyRuntimeSettings();
  scheduleNextReminder();
  scheduleDayRollover();
  startMaintenance();
});

app.on('before-quit', () => {
  isQuitting = true;
  if (reminderTimer) clearTimeout(reminderTimer);
  if (maintenanceTimer) clearInterval(maintenanceTimer);
  if (dayRolloverTimer) clearTimeout(dayRolloverTimer);
});

app.on('window-all-closed', () => {
  // The tray owns the application lifetime.
});
