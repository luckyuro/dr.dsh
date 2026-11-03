/** Keep the connection control reachable without taking space from Harness. */
export interface DockPosition {
  readonly side: 'left' | 'right';
  readonly fraction: number;
}
export interface ControlViewport { readonly width: number; readonly height: number }
const EDGE = 12;
const SIZE = 44;
export const CONTROL_POSITION_KEY = 'dr.dsh.control-position.v1';
const DEFAULT_POSITION: DockPosition = { side: 'right', fraction: 0.45 };
const clamp = (value: number, minimum: number, maximum: number): number => Math.max(minimum, Math.min(maximum, value));

export function readControlPosition(value: string | null): DockPosition {
  try {
    const parsed: unknown = JSON.parse(value ?? 'null');
    if (parsed !== null && typeof parsed === 'object') {
      const candidate = parsed as { side?: unknown; fraction?: unknown };
      if ((candidate.side === 'left' || candidate.side === 'right') && typeof candidate.fraction === 'number' && Number.isFinite(candidate.fraction)) {
        return { side: candidate.side, fraction: clamp(candidate.fraction, 0, 1) };
      }
    }
  } catch { /* A missing or old preference must not hide the control. */ }
  return DEFAULT_POSITION;
}

export function controlCoordinates(position: DockPosition, viewport: ControlViewport): { left: number; top: number } {
  const width = Math.max(0, viewport.width - SIZE - 2 * EDGE);
  const height = Math.max(0, viewport.height - SIZE - 2 * EDGE);
  return { left: EDGE + (position.side === 'right' ? width : 0), top: EDGE + clamp(position.fraction, 0, 1) * height };
}

export function snapControl(left: number, top: number, viewport: ControlViewport): DockPosition {
  const height = Math.max(0, viewport.height - SIZE - 2 * EDGE);
  return { side: left + SIZE / 2 < viewport.width / 2 ? 'left' : 'right', fraction: height === 0 ? 0 : clamp((top - EDGE) / height, 0, 1) };
}

export function moveControl(position: DockPosition, key: string): DockPosition | undefined {
  if (key === 'ArrowLeft') return { ...position, side: 'left' };
  if (key === 'ArrowRight') return { ...position, side: 'right' };
  if (key === 'ArrowUp') return { ...position, fraction: clamp(position.fraction - 0.05, 0, 1) };
  if (key === 'ArrowDown') return { ...position, fraction: clamp(position.fraction + 0.05, 0, 1) };
  if (key === 'Home') return { ...position, fraction: 0 };
  if (key === 'End') return { ...position, fraction: 1 };
  return undefined;
}

/** Pointer capture keeps a drag working while it crosses the embedded document. */
export function installFloatingControl(button: HTMLButtonElement): { refresh(): void; destroy(): void } {
  let saved: string | null = null;
  try { saved = localStorage.getItem(CONTROL_POSITION_KEY); } catch { /* Storage can be denied. */ }
  let position = readControlPosition(saved);
  let drag: { pointer: number; x: number; y: number; left: number; top: number; moved: boolean } | undefined;
  let suppressDragClick = false;
  const viewport = (): ControlViewport => ({ width: window.innerWidth, height: window.innerHeight });
  const place = (left: number, top: number): void => {
    button.style.setProperty('--control-left', `${left}px`);
    button.style.setProperty('--control-top', `${top}px`);
  };
  const refresh = (): void => {
    if (drag !== undefined) return;
    const point = controlCoordinates(position, viewport());
    button.dataset.side = position.side;
    place(point.left, point.top);
  };
  const save = (): void => {
    try { localStorage.setItem(CONTROL_POSITION_KEY, JSON.stringify(position)); } catch { /* The current visit still keeps its position. */ }
    refresh();
  };
  const down = (event: PointerEvent): void => {
    if (!event.isPrimary || event.button !== 0) return;
    suppressDragClick = false;
    const rect = button.getBoundingClientRect();
    drag = { pointer: event.pointerId, x: event.clientX, y: event.clientY, left: rect.left, top: rect.top, moved: false };
    button.setPointerCapture(event.pointerId);
  };
  const move = (event: PointerEvent): void => {
    if (drag?.pointer !== event.pointerId) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 6) return;
    drag.moved = true;
    button.dataset.dragging = 'true';
    event.preventDefault();
    const size = viewport();
    place(clamp(drag.left + dx, EDGE, Math.max(EDGE, size.width - SIZE - EDGE)),
      clamp(drag.top + dy, EDGE, Math.max(EDGE, size.height - SIZE - EDGE)));
  };
  const finish = (event: PointerEvent): void => {
    if (drag?.pointer !== event.pointerId) return;
    const previous = drag;
    drag = undefined;
    delete button.dataset.dragging;
    if (button.hasPointerCapture(event.pointerId)) button.releasePointerCapture(event.pointerId);
    if (previous.moved) {
      suppressDragClick = true;
      const rect = button.getBoundingClientRect();
      position = snapControl(rect.left, rect.top, viewport());
      save();
    }
  };
  const click = (event: MouseEvent): void => {
    // A drag can synthesize a click. A fresh pointerdown or keyboard activation is intentional.
    if (suppressDragClick && event.detail !== 0) { event.preventDefault(); event.stopImmediatePropagation(); }
    suppressDragClick = false;
  };
  const key = (event: KeyboardEvent): void => {
    const next = moveControl(position, event.key);
    if (next === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    position = next;
    save();
  };
  button.addEventListener('pointerdown', down);
  button.addEventListener('pointermove', move);
  button.addEventListener('pointerup', finish);
  button.addEventListener('pointercancel', finish);
  button.addEventListener('lostpointercapture', finish);
  button.addEventListener('click', click, true);
  button.addEventListener('keydown', key);
  window.addEventListener('resize', refresh);
  window.visualViewport?.addEventListener('resize', refresh);
  refresh();
  return { refresh, destroy() {
    button.removeEventListener('pointerdown', down);
    button.removeEventListener('pointermove', move);
    button.removeEventListener('pointerup', finish);
    button.removeEventListener('pointercancel', finish);
    button.removeEventListener('lostpointercapture', finish);
    button.removeEventListener('click', click, true);
    button.removeEventListener('keydown', key);
    window.removeEventListener('resize', refresh);
    window.visualViewport?.removeEventListener('resize', refresh);
  } };
}
