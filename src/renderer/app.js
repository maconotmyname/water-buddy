'use strict';

const tipMessages = [
  '规律补水有助于维持注意力，也能帮助身体调节体温。',
  '多数成年人每天可饮用约 1500–2000 mL 水，并根据活动量和天气调整。',
  '小口、分次喝水通常比一次喝很多更轻松。',
  '运动、出汗或天气炎热时，记得适当增加饮水量。',
  '尿液颜色较深时，可能是在提醒你需要补水了。'
];

const ringCircumference = 2 * Math.PI * 36;
const monthRingCircumference = 2 * Math.PI * 11;
const MIN_CUP_ML = 100;
const MAX_CUP_ML = 1000;
const CUP_STEP_ML = 50;
let model = null;
let draftCupMl = 250;
let draftTargetMl = 2000;
let previewRequest = 0;
let tipIndex = 0;
let tipTimer = null;
let tipRestoreTimer = null;
let toastTimer = null;
let showingTip = false;
let petDrag = null;
let suppressPetClick = false;
let petPeekOpen = false;
let petPeekPinned = false;
let petPeekCloseTimer = null;
let petDrinkBusy = false;
let modelSyncBusy = false;
let settingsProfile = 'work';
let scheduleView = 'today';
let calendarMonth = null;

function getElement(selector) {
  return document.querySelector(selector);
}

function getElements(selector) {
  return [...document.querySelectorAll(selector)];
}

function currentClock() {
  const now = new Date();
  return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
}

function normalizeTarget(value, cupMl) {
  const numeric = Number(value) || 2000;
  const minCups = Math.ceil(500 / cupMl);
  const maxCups = Math.floor(5000 / cupMl);
  const cups = Math.min(Math.max(Math.round(numeric / cupMl), minCups), maxCups);
  return cups * cupMl;
}

function clampCupMl(value) {
  const numeric = Number(value);
  const fallback = Number.isFinite(draftCupMl) ? draftCupMl : 250;
  return Math.min(Math.max(Math.round(Number.isFinite(numeric) ? numeric : fallback), MIN_CUP_ML), MAX_CUP_ML);
}

function completedCups() {
  if (!model) return 0;
  return Math.min(model.plan.cupCount, Math.floor(model.daily.consumedMl / model.plan.cupMl));
}

function renderPetStatus() {
  if (!model) return;
  const complete = completedCups();
  const total = model.plan.cupCount;
  const now = currentClock();
  const dueCount = model.plan.reminders.filter((reminder) => reminder.time <= now).length;
  const inRest = model.plan.restEnabled &&
    now >= model.plan.restStartTime &&
    now < model.plan.restEndTime;
  const periodIndex = Math.max(0, Math.min(total - 1, dueCount - 1));
  const remaining = Math.max(0, total - complete);

  getElement('[data-pet-completed]').textContent = complete;
  getElement('[data-pet-total]').textContent = total;
  getElement('[data-pet-remaining]').textContent = remaining ? `还要 ${remaining} 杯` : '今日已完成';
  getElement('[data-pet-drink]').disabled = remaining === 0 || petDrinkBusy;

  const periodStatus = getElement('[data-period-status]');
  if (remaining === 0) {
    periodStatus.textContent = '今日已达标';
    periodStatus.dataset.state = 'complete';
  } else if (inRest) {
    periodStatus.textContent = '午休免打扰';
    periodStatus.dataset.state = 'rest';
  } else if (dueCount === 0) {
    periodStatus.textContent = `首杯 ${model.plan.reminders[0].time}`;
    periodStatus.dataset.state = 'upcoming';
  } else if (complete >= dueCount) {
    periodStatus.textContent = '本时段已喝';
    periodStatus.dataset.state = 'done';
  } else {
    periodStatus.textContent = '本时段待喝';
    periodStatus.dataset.state = 'pending';
  }

  const grid = getElement('[data-energy-grid]');
  grid.replaceChildren();
  grid.style.gridTemplateColumns = `repeat(${Math.min(total, 12)}, minmax(0, 1fr))`;
  grid.setAttribute('aria-label', `今天已喝 ${complete} 杯，还要喝 ${remaining} 杯`);
  model.plan.reminders.forEach((reminder) => {
    const cell = document.createElement('span');
    const isDone = reminder.index < complete;
    const isDue = reminder.index < dueCount && !isDone;
    const isPeriod = reminder.index === periodIndex;
    cell.className = [
      'energy-cell',
      isDone ? 'is-filled' : '',
      isDue ? 'is-due' : '',
      isPeriod ? 'is-period' : ''
    ].filter(Boolean).join(' ');
    cell.title = `第 ${reminder.index + 1} 杯 · ${reminder.time} · ${isDone ? '已喝' : isDue ? '待补' : '未到时间'}`;
    grid.append(cell);
  });
}

function setPetPeek(open) {
  const nextOpen = Boolean(open && model?.runtime.compact);
  if (petPeekOpen === nextOpen) return;
  petPeekOpen = nextOpen;
  document.body.classList.toggle('is-pet-peek', nextOpen);
  getElement('[data-pet-status]').setAttribute('aria-hidden', String(!nextOpen));
  window.waterBuddy.setPetPeek(nextOpen);
}

function schedulePetPeekClose() {
  clearTimeout(petPeekCloseTimer);
  if (petPeekPinned || petDrinkBusy) return;
  petPeekCloseTimer = setTimeout(() => {
    if (!petPeekPinned && !petDrinkBusy) setPetPeek(false);
  }, 280);
}

async function syncModel() {
  if (modelSyncBusy) return;
  modelSyncBusy = true;
  try {
    const nextModel = await window.waterBuddy.getModel();
    if (!model || nextModel.daily.date !== model.daily.date) render(nextModel);
  } finally {
    modelSyncBusy = false;
  }
}

function createIcon(name) {
  const icon = document.createElement('i');
  icon.dataset.lucide = name;
  icon.setAttribute('aria-hidden', 'true');
  return icon;
}

function refreshIcons() {
  globalThis.lucide?.createIcons({ attrs: { width: 16, height: 16 } });
}

function renderReminderBubble() {
  if (!model) return;
  showingTip = false;
  const complete = completedCups();
  const bubble = getElement('[data-bubble]');
  if (complete >= model.plan.cupCount) {
    bubble.innerHTML = '今天达标啦，<strong>做得很好</strong>';
    return;
  }
  const reminder = model.plan.reminders[complete];
  const overdue = reminder.time <= currentClock();
  bubble.innerHTML = overdue
    ? `到时间啦，喝一杯 <strong>${model.plan.cupMl} mL</strong> 吧`
    : `下一杯在 <strong>${reminder.time}</strong>，到时叫你`;
}

function showTip() {
  if (!model) return;
  clearTimeout(tipTimer);
  clearTimeout(tipRestoreTimer);
  const personalized = `你的 ${model.plan.cupMl} mL 水杯每天喝 ${model.plan.cupCount} 杯，就是 ${model.plan.targetMl} mL。`;
  const tips = [personalized, ...tipMessages];
  tipIndex = (tipIndex + 1 + Math.floor(Math.random() * (tips.length - 1))) % tips.length;
  showingTip = true;
  getElement('[data-bubble]').innerHTML = `<span class="tip-label">补水小贴士</span>${tips[tipIndex]}`;
  tipRestoreTimer = setTimeout(() => {
    renderReminderBubble();
    scheduleTip();
  }, 6500);
}

function scheduleTip() {
  clearTimeout(tipTimer);
  tipTimer = setTimeout(showTip, 12_000 + Math.round(Math.random() * 13_000));
}

function animateMascot() {
  const mascot = getElement('[data-mascot]');
  mascot.classList.remove('is-cheering');
  void mascot.getBoundingClientRect();
  mascot.classList.add('is-cheering');
}

function showToast(message) {
  const toast = getElement('[data-toast]');
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.classList.add('is-visible');
  toastTimer = setTimeout(() => toast.classList.remove('is-visible'), 2600);
}

function appendTimeItem(container, data) {
  const row = document.createElement('div');
  row.className = `time-item ${data.className || ''}`.trim();
  const dot = document.createElement('span');
  dot.className = 'time-dot';
  if (data.icon) dot.append(createIcon(data.icon));
  const time = document.createElement('span');
  time.className = 'time-value';
  time.textContent = data.time;
  const status = document.createElement('span');
  status.className = 'time-status';
  status.textContent = data.status;
  row.append(dot, time, status);
  container.append(row);
}

function renderTimeline() {
  const container = getElement('[data-timeline]');
  container.replaceChildren();
  const complete = completedCups();
  const reminders = model.plan.reminders;
  const visibleStart = Math.max(0, Math.min(complete - 1, Math.max(0, reminders.length - 5)));
  const visible = reminders.slice(visibleStart, visibleStart + 5);
  let restInserted = false;

  visible.forEach((reminder) => {
    if (
      model.plan.restEnabled &&
      !restInserted &&
      reminder.time >= model.plan.restEndTime
    ) {
      appendTimeItem(container, {
        className: 'is-rest',
        icon: 'coffee',
        time: `${model.plan.restStartTime}–${model.plan.restEndTime}`,
        status: '午休'
      });
      restInserted = true;
    }
    const isDone = reminder.index < complete;
    const isNext = reminder.index === complete;
    appendTimeItem(container, {
      className: isDone ? 'is-done' : isNext ? 'is-next' : '',
      icon: isDone ? 'check' : null,
      time: reminder.time,
      status: isDone ? '已完成' : isNext ? '下一杯' : `${reminder.amountMl} mL`
    });
  });

  if (model.plan.restEnabled && !restInserted && visible.length) {
    const first = visible[0].time;
    const last = visible.at(-1).time;
    if (first < model.plan.restStartTime && last < model.plan.restEndTime) {
      appendTimeItem(container, {
        className: 'is-rest',
        icon: 'coffee',
        time: `${model.plan.restStartTime}–${model.plan.restEndTime}`,
        status: '午休'
      });
    }
  }

  const hidden = Math.max(0, reminders.length - visible.length);
  getElement('[data-remaining]').textContent = hidden
    ? `还有 ${hidden} 次提醒，最后一杯 ${reminders.at(-1).time}`
    : '';
}

function monthKeyFromDateKey(dateKey) {
  return dateKey.slice(0, 7);
}

function shiftMonth(monthKey, offset) {
  const [year, month] = monthKey.split('-').map(Number);
  const shifted = new Date(year, month - 1 + offset, 1, 12);
  return `${shifted.getFullYear()}-${String(shifted.getMonth() + 1).padStart(2, '0')}`;
}

function calendarDateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function renderMonthCalendar() {
  if (!model || !calendarMonth) return;
  const [year, month] = calendarMonth.split('-').map(Number);
  const currentMonth = monthKeyFromDateKey(model.daily.date);
  const firstDay = new Date(year, month - 1, 1, 12);
  const mondayOffset = (firstDay.getDay() + 6) % 7;
  const grid = getElement('[data-month-grid]');
  grid.replaceChildren();

  let recordedDays = 0;
  let closedDays = 0;
  let percentTotal = 0;

  for (let index = 0; index < 42; index += 1) {
    const date = new Date(year, month - 1, 1 - mondayOffset + index, 12);
    const dateKey = calendarDateKey(date);
    const inMonth = date.getFullYear() === year && date.getMonth() === month - 1;
    const record = model.history[dateKey];
    if (inMonth && record) {
      recordedDays += 1;
      closedDays += record.closed ? 1 : 0;
      percentTotal += record.percent;
    }

    const day = document.createElement('div');
    day.className = [
      'month-day',
      inMonth ? '' : 'is-outside',
      dateKey === model.daily.date ? 'is-today' : '',
      record?.closed ? 'is-closed' : '',
      record ? 'has-record' : ''
    ].filter(Boolean).join(' ');
    day.dataset.date = dateKey;
    day.setAttribute('role', 'gridcell');
    const status = record ? `${record.percent}% · ${record.consumedMl}/${record.targetMl} mL` : '无记录';
    day.setAttribute('aria-label', `${date.getMonth() + 1}月${date.getDate()}日，${status}`);
    day.title = `${date.getMonth() + 1}月${date.getDate()}日 · ${status}`;

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 28 28');
    svg.setAttribute('aria-hidden', 'true');
    const track = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    track.setAttribute('class', 'month-ring-track');
    track.setAttribute('cx', '14');
    track.setAttribute('cy', '14');
    track.setAttribute('r', '11');
    const progress = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    progress.setAttribute('class', 'month-ring-value');
    progress.setAttribute('cx', '14');
    progress.setAttribute('cy', '14');
    progress.setAttribute('r', '11');
    progress.style.strokeDasharray = monthRingCircumference.toFixed(2);
    progress.style.strokeDashoffset = (monthRingCircumference * (1 - (record?.percent || 0) / 100)).toFixed(2);
    svg.append(track, progress);
    const number = document.createElement('span');
    number.className = 'month-day-number';
    const numberText = document.createElement('span');
    numberText.textContent = date.getDate();
    number.append(numberText);
    day.append(svg, number);
    grid.append(day);
  }

  getElement('[data-month-label]').textContent = `${year}年${month}月`;
  const nextButton = getElement('[data-month-shift="1"]');
  nextButton.disabled = calendarMonth >= currentMonth;
  getElement('[data-month-summary]').textContent = recordedDays
    ? `闭环 ${closedDays} 天 · 平均 ${Math.round(percentTotal / recordedDays)}%`
    : '暂无饮水记录';
}

function setScheduleView(view) {
  scheduleView = view === 'month' ? 'month' : 'today';
  const isMonth = scheduleView === 'month';
  getElements('[data-schedule-view]').forEach((button) => {
    button.setAttribute('aria-selected', String(button.dataset.scheduleView === scheduleView));
  });
  getElement('[data-today-view]').classList.toggle('is-hidden', isMonth);
  getElement('[data-month-view]').classList.toggle('is-hidden', !isMonth);
  getElement('[data-plan-summary]').classList.toggle('is-hidden', isMonth);
  getElement('[data-month-navigation]').classList.toggle('is-hidden', !isMonth);
  if (isMonth) renderMonthCalendar();
}

function render(nextModel) {
  const previousDate = model?.daily?.date;
  model = nextModel;
  const currentMonth = monthKeyFromDateKey(model.daily.date);
  if (!calendarMonth || (previousDate && calendarMonth === monthKeyFromDateKey(previousDate) && previousDate !== model.daily.date)) {
    calendarMonth = currentMonth;
  }
  document.body.dataset.date = model.daily.date;
  document.body.dataset.mode = model.runtime.mode;
  document.body.classList.toggle('is-holiday', model.runtime.mode === 'holiday');
  const compact = Boolean(model.runtime.compact);
  document.body.classList.toggle('is-compact', compact);
  const scale = model.settings.petScale / 100;
  document.body.style.setProperty('--compact-pet-width', `${Math.round(150 * scale)}px`);
  document.body.style.setProperty('--compact-pet-height', `${Math.round(176 * scale)}px`);
  if (!compact) {
    clearTimeout(petPeekCloseTimer);
    petPeekOpen = false;
    petPeekPinned = false;
    document.body.classList.remove('is-pet-peek');
    getElement('[data-pet-status]').setAttribute('aria-hidden', 'true');
  }
  const mascotButton = getElement('[data-show-tip]');
  mascotButton.setAttribute('aria-label', compact ? '拖动桌宠，单击查看饮水状态，双击打开完整窗口' : '查看补水小贴士');
  mascotButton.title = compact ? '单击查看状态 · 双击完整窗口' : '补水小贴士';
  const consumed = Math.min(model.daily.consumedMl, model.plan.targetMl);
  const percent = Math.min(100, Math.round((consumed / model.plan.targetMl) * 100));
  getElement('[data-consumed]').textContent = consumed;
  getElement('[data-target]').textContent = model.plan.targetMl;
  getElement('[data-percent]').textContent = `${percent}%`;
  getElement('[data-progress-summary]').setAttribute('aria-label', `今日完成 ${percent}%`);
  getElement('[data-ring]').style.strokeDasharray = ringCircumference.toFixed(2);
  getElement('[data-ring]').style.strokeDashoffset = (ringCircumference * (1 - percent / 100)).toFixed(2);
  getElement('[data-plan-summary]').textContent = model.plan.restEnabled
    ? `${model.plan.cupCount} 杯 · 避开午休`
    : `${model.plan.cupCount} 杯 · 每 ${model.plan.intervalLabel}`;
  getElements('[data-mode]').forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.mode === model.runtime.mode));
  });
  getElement('[data-undo]').disabled = consumed <= 0;
  const drinkButton = getElement('[data-drink]');
  drinkButton.disabled = consumed >= model.plan.targetMl;
  drinkButton.querySelector('span').innerHTML = consumed >= model.plan.targetMl
    ? '今日目标已完成'
    : `喝了一杯 · <span data-cup>${model.plan.cupMl}</span> mL`;
  renderTimeline();
  if (scheduleView === 'month') renderMonthCalendar();
  renderPetStatus();
  if (!showingTip || consumed >= model.plan.targetMl) renderReminderBubble();
  refreshIcons();
}

function settingsDraft() {
  return {
    targetMl: Number(getElement('[data-target-input]').value),
    cupMl: draftCupMl,
    startTime: getElement('[data-start-time]').value,
    endTime: getElement('[data-end-time]').value,
    restEnabled: getElement('[data-rest-enabled]').checked,
    restStartTime: getElement('[data-rest-start]').value,
    restEndTime: getElement('[data-rest-end]').value,
    alwaysOnTop: getElement('[data-always-on-top]').checked,
    launchAtLogin: getElement('[data-launch-at-login]').checked,
    petScale: Number(getElement('[data-pet-scale]').value)
  };
}

function syncRestInputs() {
  const disabled = !getElement('[data-rest-enabled]').checked;
  getElement('[data-rest-start]').disabled = disabled;
  getElement('[data-rest-end]').disabled = disabled;
}

async function refreshPreview() {
  const requestId = ++previewRequest;
  const result = await window.waterBuddy.previewSettings(settingsDraft());
  if (requestId !== previewRequest) return;
  const error = getElement('[data-form-error]');
  const save = getElement('[data-save-settings]');
  if (!result.ok) {
    error.textContent = result.error;
    save.disabled = true;
    return;
  }
  error.textContent = '';
  save.disabled = false;
  getElement('[data-target-multiple]').textContent = `${result.plan.cupCount} 杯`;
  getElement('[data-preview-title]').textContent = `${result.plan.cupCount} 杯 × ${result.plan.cupMl} mL = ${result.plan.targetMl} mL`;
  getElement('[data-preview-detail]').textContent = settingsDraft().restEnabled
    ? `${settingsDraft().startTime} 至 ${settingsDraft().endTime} · 每 ${result.plan.intervalLabel} · 避开午休`
    : `${settingsDraft().startTime} 至 ${settingsDraft().endTime} · 每 ${result.plan.intervalLabel}`;
}

function fillSettings() {
  const settings = model.profiles[settingsProfile];
  getElements('[data-settings-mode]').forEach((button) => {
    button.setAttribute('aria-selected', String(button.dataset.settingsMode === settingsProfile));
  });
  draftCupMl = settings.cupMl;
  draftTargetMl = settings.targetMl;
  getElement('[data-target-input]').value = settings.targetMl;
  getElement('[data-target-input]').step = settings.cupMl;
  getElement('[data-cup-input]').value = settings.cupMl;
  getElement('[data-start-time]').value = settings.startTime;
  getElement('[data-end-time]').value = settings.endTime;
  getElement('[data-rest-enabled]').checked = settings.restEnabled;
  getElement('[data-rest-start]').value = settings.restStartTime;
  getElement('[data-rest-end]').value = settings.restEndTime;
  getElement('[data-always-on-top]').checked = settings.alwaysOnTop;
  getElement('[data-launch-at-login]').checked = settings.launchAtLogin;
  getElement('[data-pet-scale]').value = settings.petScale;
  getElement('[data-pet-scale-value]').textContent = `${settings.petScale}%`;
  syncRestInputs();
  refreshPreview();
}

function openSettings() {
  if (!model) return;
  clearTimeout(toastTimer);
  getElement('[data-toast]').classList.remove('is-visible');
  settingsProfile = model.runtime.mode;
  fillSettings();
  const overlay = getElement('[data-settings-overlay]');
  overlay.classList.add('is-open');
  overlay.setAttribute('aria-hidden', 'false');
  requestAnimationFrame(() => getElement('[data-target-input]').focus());
}

function closeSettings() {
  const overlay = getElement('[data-settings-overlay]');
  overlay.classList.remove('is-open');
  overlay.setAttribute('aria-hidden', 'true');
  getElement('[data-open-settings]').focus();
}

function normalizeTargetInput() {
  const input = getElement('[data-target-input]');
  input.value = normalizeTarget(draftTargetMl, draftCupMl);
  input.step = draftCupMl;
  refreshPreview();
}

function normalizeCupInput() {
  const input = getElement('[data-cup-input]');
  draftCupMl = clampCupMl(input.value);
  input.value = draftCupMl;
  normalizeTargetInput();
}

function finishPetDrag(event) {
  if (!petDrag || event.pointerId !== petDrag.pointerId) return;
  suppressPetClick = petDrag.moved;
  petDrag = null;
  document.body.classList.remove('is-dragging-pet');
  try {
    event.currentTarget.releasePointerCapture(event.pointerId);
  } catch {
    // Synthetic pointer events may not own capture.
  }
}

function registerPetDrag(button) {
  button.addEventListener('pointerdown', (event) => {
    if (!model?.runtime.compact || event.button !== 0) return;
    petDrag = {
      pointerId: event.pointerId,
      lastX: event.screenX,
      lastY: event.screenY,
      distance: 0,
      moved: false
    };
    suppressPetClick = false;
    document.body.classList.add('is-dragging-pet');
    try {
      button.setPointerCapture(event.pointerId);
    } catch {
      // Pointer capture is unavailable for synthetic events used by tests.
    }
    event.preventDefault();
  });

  button.addEventListener('pointermove', (event) => {
    if (!petDrag || event.pointerId !== petDrag.pointerId) return;
    const deltaX = event.screenX - petDrag.lastX;
    const deltaY = event.screenY - petDrag.lastY;
    petDrag.lastX = event.screenX;
    petDrag.lastY = event.screenY;
    petDrag.distance += Math.abs(deltaX) + Math.abs(deltaY);
    petDrag.moved ||= petDrag.distance >= 5;
    if (deltaX || deltaY) window.waterBuddy.moveWindow({ deltaX, deltaY });
  });

  button.addEventListener('pointerup', finishPetDrag);
  button.addEventListener('pointercancel', finishPetDrag);
}

function registerEvents() {
  getElements('[data-schedule-view]').forEach((button) => {
    button.addEventListener('click', () => setScheduleView(button.dataset.scheduleView));
  });
  getElements('[data-month-shift]').forEach((button) => {
    button.addEventListener('click', () => {
      calendarMonth = shiftMonth(calendarMonth, Number(button.dataset.monthShift));
      renderMonthCalendar();
    });
  });
  getElements('[data-mode]').forEach((button) => {
    button.addEventListener('click', async () => {
      if (!model || button.dataset.mode === model.runtime.mode) return;
      const nextMode = button.dataset.mode;
      render(await window.waterBuddy.setMode(nextMode));
      if (getElement('[data-settings-overlay]').classList.contains('is-open')) {
        settingsProfile = nextMode;
        fillSettings();
      }
      showToast(`已切换到${nextMode === 'work' ? '工作版' : '假日版'}`);
    });
  });
  getElement('[data-open-settings]').addEventListener('click', openSettings);
  getElement('[data-close-settings]').addEventListener('click', closeSettings);
  getElement('[data-cancel-settings]').addEventListener('click', closeSettings);
  getElement('[data-hide-window]').addEventListener('click', () => window.waterBuddy.windowAction('hide'));
  getElement('[data-compact-window]').addEventListener('click', async () => {
    render(await window.waterBuddy.windowAction('compact'));
  });
  const mascotButton = getElement('[data-show-tip]');
  const petStatusPanel = getElement('[data-pet-status]');
  mascotButton.addEventListener('pointerenter', () => {
    clearTimeout(petPeekCloseTimer);
    if (model?.runtime.compact && !petDrag) setPetPeek(true);
  });
  mascotButton.addEventListener('pointerleave', schedulePetPeekClose);
  mascotButton.addEventListener('click', async () => {
    if (!model?.runtime.compact) {
      showTip();
      return;
    }
    if (suppressPetClick) {
      suppressPetClick = false;
      return;
    }
    petPeekPinned = !petPeekPinned;
    setPetPeek(petPeekPinned);
  });
  mascotButton.addEventListener('dblclick', async () => {
    petPeekPinned = false;
    petPeekOpen = false;
    render(await window.waterBuddy.windowAction('expand'));
  });
  petStatusPanel.addEventListener('pointerenter', () => clearTimeout(petPeekCloseTimer));
  petStatusPanel.addEventListener('pointerleave', schedulePetPeekClose);
  petStatusPanel.addEventListener('pointerdown', () => clearTimeout(petPeekCloseTimer));
  document.documentElement.addEventListener('mouseleave', schedulePetPeekClose);
  registerPetDrag(mascotButton);
  getElement('[data-pet-drink]').addEventListener('click', async () => {
    if (petDrinkBusy) return;
    petDrinkBusy = true;
    petPeekPinned = true;
    setPetPeek(true);
    clearTimeout(petPeekCloseTimer);
    renderPetStatus();
    const periodStatus = getElement('[data-period-status]');
    periodStatus.textContent = '记录中...';
    periodStatus.dataset.state = 'upcoming';
    try {
      const nextModel = await window.waterBuddy.drink();
      petDrinkBusy = false;
      render(nextModel);
      periodStatus.textContent = '已记录 +1 杯';
      periodStatus.dataset.state = 'done';
      animateMascot();
    } catch (error) {
      petDrinkBusy = false;
      renderPetStatus();
      periodStatus.textContent = '记录失败';
      periodStatus.dataset.state = 'pending';
      console.error('Could not record drink from pet mode.', error);
    }
  });
  getElement('[data-expand-window]').addEventListener('click', async () => {
    petPeekPinned = false;
    petPeekOpen = false;
    render(await window.waterBuddy.windowAction('expand'));
  });
  getElement('[data-hide-pet]').addEventListener('click', () => {
    window.waterBuddy.windowAction('hide');
  });
  getElement('[data-drink]').addEventListener('click', async () => {
    render(await window.waterBuddy.drink());
    animateMascot();
    showToast('已记录一杯水');
  });
  getElement('[data-undo]').addEventListener('click', async () => {
    render(await window.waterBuddy.undoDrink());
    showToast('已撤销上一杯');
  });
  getElement('[data-settings-overlay]').addEventListener('click', (event) => {
    if (event.target === getElement('[data-settings-overlay]')) closeSettings();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && getElement('[data-settings-overlay]').classList.contains('is-open')) {
      closeSettings();
    }
  });

  getElements('[data-target-step]').forEach((button) => {
    button.addEventListener('click', () => {
      const input = getElement('[data-target-input]');
      const current = normalizeTarget(input.value, draftCupMl);
      draftTargetMl = current + Number(button.dataset.targetStep) * draftCupMl;
      input.value = draftTargetMl;
      normalizeTargetInput();
    });
  });
  getElements('[data-settings-mode]').forEach((button) => {
    button.addEventListener('click', () => {
      settingsProfile = button.dataset.settingsMode;
      fillSettings();
    });
  });
  getElement('[data-target-input]').addEventListener('input', (event) => {
    const numeric = Number(event.currentTarget.value);
    if (event.currentTarget.value !== '' && Number.isFinite(numeric)) draftTargetMl = numeric;
    refreshPreview();
  });
  getElement('[data-target-input]').addEventListener('change', normalizeTargetInput);
  getElements('[data-cup-step]').forEach((button) => {
    button.addEventListener('click', () => {
      const input = getElement('[data-cup-input]');
      draftCupMl = clampCupMl(Number(input.value) + Number(button.dataset.cupStep) * CUP_STEP_ML);
      input.value = draftCupMl;
      normalizeTargetInput();
    });
  });
  getElement('[data-cup-input]').addEventListener('input', (event) => {
    const numeric = Number(event.currentTarget.value);
    if (Number.isFinite(numeric) && numeric >= MIN_CUP_ML && numeric <= MAX_CUP_ML) {
      draftCupMl = Math.round(numeric);
      normalizeTargetInput();
      return;
    }
    refreshPreview();
  });
  getElement('[data-cup-input]').addEventListener('change', normalizeCupInput);
  [
    '[data-start-time]',
    '[data-end-time]',
    '[data-rest-start]',
    '[data-rest-end]',
    '[data-always-on-top]',
    '[data-launch-at-login]'
  ].forEach((selector) => getElement(selector).addEventListener('input', refreshPreview));
  getElement('[data-rest-enabled]').addEventListener('change', () => {
    syncRestInputs();
    refreshPreview();
  });
  getElement('[data-pet-scale]').addEventListener('input', (event) => {
    getElement('[data-pet-scale-value]').textContent = `${event.currentTarget.value}%`;
    refreshPreview();
  });
  getElement('[data-save-settings]').addEventListener('click', async () => {
    normalizeCupInput();
    normalizeTargetInput();
    const result = await window.waterBuddy.saveSettings(settingsDraft(), settingsProfile);
    if (!result.ok) {
      getElement('[data-form-error]').textContent = result.error;
      return;
    }
    render(result.model);
    closeSettings();
    showToast(`${settingsProfile === 'work' ? '工作版' : '假日版'}计划已更新`);
  });

  window.waterBuddy.onModel(render);
  window.waterBuddy.onReminder((reminder) => {
    showingTip = false;
    getElement('[data-bubble]').innerHTML = `到点啦，喝一杯 <strong>${reminder.amountMl} mL</strong> 吧`;
    animateMascot();
    showToast('喝水时间到了');
  });
  window.waterBuddy.onOpenSettings(openSettings);
  window.waterBuddy.onWindowMode(({ compact }) => {
    if (!model) {
      document.body.classList.toggle('is-compact', Boolean(compact));
      return;
    }
    render({
      ...model,
      runtime: { ...model.runtime, compact: Boolean(compact) }
    });
  });
}

async function initialize() {
  registerEvents();
  render(await window.waterBuddy.getModel());
  scheduleTip();
  setInterval(() => {
    if (!showingTip) renderReminderBubble();
    renderPetStatus();
  }, 60_000);
  setInterval(syncModel, 15_000);
}

window.addEventListener('DOMContentLoaded', initialize, { once: true });
