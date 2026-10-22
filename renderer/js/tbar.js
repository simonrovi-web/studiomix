// T-bar as on a hardware switcher: the bar has a physical position (0–100)
// that stays where it is left. A transition runs from the end the bar rests at
// to the other end; reaching it completes the transition and the bar stays
// there, so the next one goes back the other way. Used by the on-screen T-bar
// and by MIDI faders.
//
// transition fields: bar (position), barFrom (0 or 100: where the current
// transition started), barLocked (the bar was left mid-way by AUTO/CUT and is
// ignored until it reaches an end, so the picture never jumps), manual (0–100).

/** Movement ignored at rest: MIDI faders jitter by a step or two. */
export const TBAR_DEADBAND = 1.5;
/** Close enough to the far end to complete (many faders never send exactly 127). */
export const TBAR_COMPLETE = 99;

const atEnd = (pos) => pos <= TBAR_DEADBAND || pos >= 100 - TBAR_DEADBAND;

/**
 * Moves the bar to `pos` (0–100). Updates t.manual and returns 'commit' when
 * the transition should complete, else null.
 */
export function moveTbar(t, pos) {
  const next = Math.min(100, Math.max(0, Number(pos) || 0));
  const previous = t.bar ?? 0;
  t.bar = next;
  if (t.running) return null;
  if (t.barLocked) {
    // Picked up again once it reaches an end; that end is the new origin.
    if (atEnd(next)) {
      t.barLocked = false;
      t.barFrom = next < 50 ? 0 : 100;
    }
    return null;
  }
  // At rest the transition starts from the end the bar was resting at.
  if (!(t.manual > 0)) t.barFrom = previous < 50 ? 0 : 100;
  const progress = Math.abs(next - t.barFrom);
  if (!(t.manual > 0) && progress < TBAR_DEADBAND) return null;
  if (progress >= TBAR_COMPLETE) return 'commit';
  t.manual = progress;
  return null;
}

/**
 * After a transition completes, by `how`: 'bar' (the bar reached the far
 * end), 'auto' or 'cut'. The on-screen bar is the app's to move: AUTO carries
 * it to the far end like a motorised T-bar, and a CUT leaves a resting bar
 * alone. A MIDI fader stays where the hand left it; if that is mid-way it is
 * locked until picked up at an end, so the picture never jumps.
 */
export function settleTbar(t, how) {
  const target = (t.barFrom ?? 0) === 0 ? 100 : 0;
  const bar = t.bar ?? 0;
  if (how === 'bar') {
    t.barFrom = target;
    t.barLocked = false;
  } else if (t.barSource === 'midi') {
    if (atEnd(bar)) t.barFrom = bar < 50 ? 0 : 100;
    else t.barLocked = true;
  } else if (how === 'cut' && atEnd(bar)) {
    t.barFrom = bar < 50 ? 0 : 100;
  } else {
    t.bar = target;
    t.barFrom = target;
    t.barLocked = false;
  }
}

/**
 * Where to draw the on-screen handle: the physical position, or during AUTO
 * on an app-owned bar, travelling with the transition.
 */
export function displayedBar(t) {
  if (t.running && t.barSource !== 'midi') {
    const p = Math.min(1, Math.max(0, t.progress ?? 0));
    return t.barFrom === 0 ? p * 100 : 100 - p * 100;
  }
  return t.bar ?? 0;
}
