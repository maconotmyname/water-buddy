'use strict';

const DEFAULT_SETTINGS = Object.freeze({
  targetMl: 2000,
  cupMl: 250,
  startTime: '08:00',
  endTime: '22:00',
  restEnabled: true,
  restStartTime: '12:30',
  restEndTime: '14:00',
  alwaysOnTop: true,
  launchAtLogin: false,
  petScale: 100
});

const MIN_TARGET_ML = 500;
const MAX_TARGET_ML = 5000;
const MIN_CUP_ML = 100;
const MAX_CUP_ML = 1000;
const MIN_PET_SCALE = 70;
const MAX_PET_SCALE = 140;
const PET_SCALE_STEP = 10;

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function normalizeCup(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_SETTINGS.cupMl;
  return clamp(Math.round(parsed), MIN_CUP_ML, MAX_CUP_ML);
}

function normalizeTarget(targetMl, cupMl) {
  const normalizedCup = normalizeCup(cupMl);
  const parsedTarget = Number(targetMl);
  const preferredTarget = Number.isFinite(parsedTarget) ? parsedTarget : DEFAULT_SETTINGS.targetMl;
  const minCups = Math.ceil(MIN_TARGET_ML / normalizedCup);
  const maxCups = Math.floor(MAX_TARGET_ML / normalizedCup);
  const cupCount = clamp(Math.round(preferredTarget / normalizedCup), minCups, maxCups);
  return cupCount * normalizedCup;
}

function normalizePetScale(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_SETTINGS.petScale;
  const stepped = Math.round(parsed / PET_SCALE_STEP) * PET_SCALE_STEP;
  return clamp(stepped, MIN_PET_SCALE, MAX_PET_SCALE);
}

function normalizeSettings(raw = {}) {
  const cupMl = normalizeCup(raw.cupMl);
  return {
    targetMl: normalizeTarget(raw.targetMl, cupMl),
    cupMl,
    startTime: typeof raw.startTime === 'string' ? raw.startTime : DEFAULT_SETTINGS.startTime,
    endTime: typeof raw.endTime === 'string' ? raw.endTime : DEFAULT_SETTINGS.endTime,
    restEnabled: raw.restEnabled == null ? DEFAULT_SETTINGS.restEnabled : Boolean(raw.restEnabled),
    restStartTime: typeof raw.restStartTime === 'string' ? raw.restStartTime : DEFAULT_SETTINGS.restStartTime,
    restEndTime: typeof raw.restEndTime === 'string' ? raw.restEndTime : DEFAULT_SETTINGS.restEndTime,
    alwaysOnTop: raw.alwaysOnTop == null ? DEFAULT_SETTINGS.alwaysOnTop : Boolean(raw.alwaysOnTop),
    launchAtLogin: raw.launchAtLogin == null ? DEFAULT_SETTINGS.launchAtLogin : Boolean(raw.launchAtLogin),
    petScale: normalizePetScale(raw.petScale)
  };
}

function timeToMinutes(value) {
  const match = /^(\d{2}):(\d{2})$/.exec(value || '');
  if (!match) throw new Error('时间格式必须为 HH:MM。');
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) throw new Error('时间超出有效范围。');
  return hours * 60 + minutes;
}

function minutesToTime(value) {
  const rounded = Math.round(value);
  const hours = Math.floor(rounded / 60) % 24;
  const minutes = rounded % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

function formatInterval(minutes) {
  const rounded = Math.round(minutes);
  if (rounded < 60) return `${rounded} 分钟`;
  const hours = Math.floor(rounded / 60);
  const remainder = rounded % 60;
  return remainder ? `${hours} 小时 ${remainder} 分钟` : `${hours} 小时`;
}

function buildDailyPlan(rawSettings = {}) {
  const settings = normalizeSettings(rawSettings);
  const startMinutes = timeToMinutes(settings.startTime);
  const endMinutes = timeToMinutes(settings.endTime);
  if (endMinutes <= startMinutes) throw new Error('结束时间需要晚于开始时间。');

  let restStartMinutes = null;
  let restEndMinutes = null;
  let activeBeforeRest = endMinutes - startMinutes;
  let activeMinutes = activeBeforeRest;

  if (settings.restEnabled) {
    restStartMinutes = timeToMinutes(settings.restStartTime);
    restEndMinutes = timeToMinutes(settings.restEndTime);
    if (
      restStartMinutes <= startMinutes ||
      restEndMinutes <= restStartMinutes ||
      restEndMinutes >= endMinutes
    ) {
      throw new Error('休息时间需要完整位于喝水时段内。');
    }
    activeBeforeRest = restStartMinutes - startMinutes;
    activeMinutes = activeBeforeRest + (endMinutes - restEndMinutes);
  }

  const cupCount = settings.targetMl / settings.cupMl;
  const intervalMinutes = cupCount > 1 ? activeMinutes / (cupCount - 1) : 0;
  if (cupCount > 1 && intervalMinutes < 30) {
    throw new Error('当前提醒过于密集，请增大单杯水量或延长喝水时段。');
  }

  const reminders = Array.from({ length: cupCount }, (_, index) => {
    const activeOffset = intervalMinutes * index;
    const clockMinutes = settings.restEnabled && activeOffset >= activeBeforeRest
      ? restEndMinutes + (activeOffset - activeBeforeRest)
      : startMinutes + activeOffset;
    return {
      index,
      time: minutesToTime(clockMinutes),
      minuteOfDay: Math.round(clockMinutes),
      amountMl: settings.cupMl
    };
  });

  return {
    settings,
    targetMl: settings.targetMl,
    cupMl: settings.cupMl,
    cupCount,
    intervalMinutes,
    intervalLabel: formatInterval(intervalMinutes),
    startMinutes,
    endMinutes,
    restStartMinutes,
    restEndMinutes,
    reminders
  };
}

function localDateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

module.exports = {
  DEFAULT_SETTINGS,
  MAX_TARGET_ML,
  MAX_PET_SCALE,
  MIN_TARGET_ML,
  MIN_PET_SCALE,
  buildDailyPlan,
  formatInterval,
  localDateKey,
  minutesToTime,
  normalizePetScale,
  normalizeSettings,
  normalizeTarget,
  timeToMinutes
};
