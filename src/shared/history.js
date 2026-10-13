'use strict';

const { localDateKey } = require('./schedule');

const MAX_HISTORY_DAYS = 730;
const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const HISTORY_MODES = new Set(['work', 'holiday']);

function createHistoryRecord({ consumedMl, targetMl, mode }) {
  const normalizedConsumed = Math.max(0, Number(consumedMl) || 0);
  const normalizedTarget = Math.max(1, Number(targetMl) || 1);
  const percent = Math.min(100, Math.round((normalizedConsumed / normalizedTarget) * 100));
  return {
    consumedMl: normalizedConsumed,
    targetMl: normalizedTarget,
    percent,
    closed: normalizedConsumed >= normalizedTarget,
    mode: HISTORY_MODES.has(mode) ? mode : 'work'
  };
}

function normalizeHistory(rawHistory = {}) {
  if (!rawHistory || typeof rawHistory !== 'object' || Array.isArray(rawHistory)) return {};
  return Object.fromEntries(
    Object.entries(rawHistory)
      .filter(([date, record]) => DATE_KEY_PATTERN.test(date) && record && typeof record === 'object')
      .map(([date, record]) => [date, createHistoryRecord(record)])
  );
}

function pruneHistory(history, currentDate = new Date()) {
  const cutoff = new Date(currentDate);
  cutoff.setHours(12, 0, 0, 0);
  cutoff.setDate(cutoff.getDate() - (MAX_HISTORY_DAYS - 1));
  const cutoffKey = localDateKey(cutoff);
  return Object.fromEntries(
    Object.entries(history).filter(([date]) => date >= cutoffKey)
  );
}

module.exports = {
  MAX_HISTORY_DAYS,
  createHistoryRecord,
  normalizeHistory,
  pruneHistory
};
