'use strict';

function draggedWindowPosition(startBounds, startCursor, cursor) {
  return {
    x: Math.round(startBounds.x + cursor.x - startCursor.x),
    y: Math.round(startBounds.y + cursor.y - startCursor.y)
  };
}

function fitWindowToWorkArea(bounds, workArea) {
  return {
    x: Math.min(Math.max(bounds.x, workArea.x), Math.max(workArea.x, workArea.x + workArea.width - bounds.width)),
    y: Math.min(Math.max(bounds.y, workArea.y), Math.max(workArea.y, workArea.y + workArea.height - bounds.height))
  };
}

module.exports = { draggedWindowPosition, fitWindowToWorkArea };
