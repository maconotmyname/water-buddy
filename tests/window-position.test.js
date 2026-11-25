'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { draggedWindowPosition, fitWindowToWorkArea } = require('../src/shared/window-position');

test('dragging can straddle a screen edge and continue onto the next screen', () => {
  const start = { x: 1760, y: 400, width: 150, height: 176 };
  const origin = { x: 1835, y: 450 };
  assert.deepEqual(draggedWindowPosition(start, origin, { x: 1880, y: 450 }), { x: 1805, y: 400 });
  assert.deepEqual(draggedWindowPosition(start, origin, { x: 2050, y: 500 }), { x: 1975, y: 450 });
});

test('dragging supports screens left, above and below the primary screen', () => {
  const start = { x: 100, y: 100 };
  const origin = { x: 125, y: 130 };
  for (const cursor of [{ x: -700, y: 300 }, { x: 400, y: -500 }, { x: 500, y: 1500 }]) {
    assert.deepEqual(draggedWindowPosition(start, origin, cursor), { x: cursor.x - 25, y: cursor.y - 30 });
  }
});

test('absolute cursor movement does not accumulate rounding drift', () => {
  const start = { x: 100, y: 100 };
  const origin = { x: 125, y: 130 };
  for (let step = 1; step <= 20; step++) {
    const position = draggedWindowPosition(start, origin, { x: 125 + step * 0.4, y: 130 });
    assert.equal(position.x, 100 + Math.round(step * 0.4));
  }
});

test('drop snaps a straddling window onto the destination screen, avoiding its taskbar', () => {
  const area = { x: 1920, y: 200, width: 1280, height: 984 };
  assert.deepEqual(fitWindowToWorkArea({ x: 1870, y: 100, width: 150, height: 176 }, area), { x: 1920, y: 200 });
  assert.deepEqual(fitWindowToWorkArea({ x: 3150, y: 1150, width: 150, height: 176 }, area), { x: 3050, y: 1008 });
});

test('drop in a desktop gap is constrained to the selected real work area', () => {
  assert.deepEqual(fitWindowToWorkArea({ x: -100, y: -100, width: 150, height: 176 },
    { x: -1280, y: 200, width: 1280, height: 984 }), { x: -150, y: 200 });
});

test('work area smaller than the window keeps its top left accessible', () => {
  assert.deepEqual(fitWindowToWorkArea({ x: -500, y: 400, width: 244, height: 350 },
    { x: -200, y: 0, width: 200, height: 300 }), { x: -200, y: 0 });
});
