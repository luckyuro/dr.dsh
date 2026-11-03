import assert from 'node:assert/strict';
import { test } from 'node:test';
import { controlCoordinates, moveControl, readControlPosition, snapControl } from './floating-control.ts';

test('saved position tolerates missing, invalid and out-of-range preferences', () => {
  for (const value of [null, '', '{broken', 'null', '{"side":"middle","fraction":0.5}', '{"side":"left","fraction":"bottom"}']) {
    assert.deepEqual(readControlPosition(value), { side: 'right', fraction: 0.45 });
  }
  assert.deepEqual(readControlPosition('{"side":"left","fraction":-10}'), { side: 'left', fraction: 0 });
  assert.deepEqual(readControlPosition('{"side":"right","fraction":7}'), { side: 'right', fraction: 1 });
});

test('dragging beyond every edge snaps to an accessible side and clamps its vertical position', () => {
  const viewport = { width: 390, height: 844 };
  assert.deepEqual(snapControl(-500, -500, viewport), { side: 'left', fraction: 0 });
  assert.deepEqual(snapControl(1000, 1000, viewport), { side: 'right', fraction: 1 });
  assert.deepEqual(controlCoordinates({ side: 'left', fraction: 0 }, viewport), { left: 12, top: 12 });
  assert.deepEqual(controlCoordinates({ side: 'right', fraction: 1 }, viewport), { left: 334, top: 788 });
});

test('viewport resizing preserves the chosen side and proportional vertical position', () => {
  const position = { side: 'right', fraction: 0.5 } as const;
  assert.deepEqual(controlCoordinates(position, { width: 1280, height: 900 }), { left: 1224, top: 428 });
  assert.deepEqual(controlCoordinates(position, { width: 390, height: 844 }), { left: 334, top: 400 });
  assert.deepEqual(controlCoordinates(position, { width: 40, height: 40 }), { left: 12, top: 12 });
});

test('keyboard arrows dock and move the button while Enter and Space remain native activation', () => {
  const initial = { side: 'right', fraction: 0.5 } as const;
  assert.deepEqual(moveControl(initial, 'ArrowLeft'), { side: 'left', fraction: 0.5 });
  assert.deepEqual(moveControl({ side: 'left', fraction: 0 }, 'ArrowRight'), { side: 'right', fraction: 0 });
  assert.deepEqual(moveControl({ side: 'left', fraction: 0 }, 'ArrowUp'), { side: 'left', fraction: 0 });
  assert.deepEqual(moveControl({ side: 'right', fraction: 1 }, 'ArrowDown'), { side: 'right', fraction: 1 });
  assert.deepEqual(moveControl(initial, 'Home'), { side: 'right', fraction: 0 });
  assert.deepEqual(moveControl(initial, 'End'), { side: 'right', fraction: 1 });
  assert.equal(moveControl(initial, 'Enter'), undefined);
  assert.equal(moveControl(initial, ' '), undefined);
});
