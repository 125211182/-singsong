import type { PitchFrame } from "./singing-evidence";

const EPSILON = 1e-6;
const MAX_SHORT_BOUNDARY_SECONDS = 0.15;

type EventKind = "entry" | "attack" | "change" | "short_gap";
interface Event {
  time: number;
  midi: number;
  index: number;
  kind: EventKind;
  /** A pitch anchor supporting this same earlier observed acoustic boundary. */
  recoveryPitchAnchorIndex?: number;
}
export interface SingingEventExtraction {
  rawCount: number;
  suppressedUnresolvedEntryCount: number;
  events: number[];
  recoveredEnergyEntryCount: number;
  replacedDelayedEntryCount: number;
  recoveredShortBoundaryCount: number;
  consolidatedExcursionEventCount: number;
  consolidatedSlideEventCount: number;
}

function usable(frame: PitchFrame | undefined): frame is PitchFrame & { midi: number } {
  return !!frame && frame.midi !== null && Number.isFinite(frame.midi)
    && Number.isFinite(frame.rms) && frame.rms > 0 && !frame.clipped && !frame.ambiguous;
}
function quiet(frame: PitchFrame | undefined): boolean {
  return !!frame && !frame.ambiguous && !frame.clipped && Number.isFinite(frame.rms)
    && frame.rms >= 0 && frame.rms < 0.01;
}
function stableMidi(track: PitchFrame[], index: number): number | null {
  const a = track[index], b = track[index + 1], c = track[index + 2];
  if (!usable(a) || !usable(b) || !usable(c) || c.time - a.time > 0.1 + EPSILON) return null;
  const low = Math.min(a.midi, b.midi, c.midi), high = Math.max(a.midi, b.midi, c.midi);
  return high - low <= 1 ? a.midi + b.midi + c.midi - low - high : null;
}

/** The pre-v3.5 baseline is retained solely to report raw detector counts. */
function baselineEvents(track: PitchFrame[]): Event[] {
  const events: Event[] = [];
  let lastVoicedTime = -Infinity, activeMidi: number | null = null, uncertain = false;
  for (let index = 0; index < track.length - 2; index++) {
    const frame = track[index];
    if (frame.ambiguous || frame.clipped) {
      lastVoicedTime = frame.time; uncertain = true; continue;
    }
    if (!usable(frame)) continue;
    if (frame.time - lastVoicedTime > 0.15 + EPSILON) { activeMidi = null; uncertain = false; }
    lastVoicedTime = frame.time;
    const b = track[index + 1], c = track[index + 2];
    if (!usable(b) || !usable(c) || c.time - frame.time > 0.1 + EPSILON) continue;
    const low = Math.min(frame.midi, b.midi, c.midi), high = Math.max(frame.midi, b.midi, c.midi);
    const midi = frame.midi + b.midi + c.midi - low - high;
    const before = track[index - 2], valley = track[index - 1];
    const attack = usable(before) && valley && !valley.ambiguous && !valley.clipped
      && Number.isFinite(valley.rms) && valley.rms >= 0 && frame.time - before.time <= 0.1 + EPSILON
      && valley.rms <= before.rms * 0.5 && Math.min(frame.rms, b.rms, c.rms) >= valley.rms * 2.5
      && frame.time - (events.at(-1)?.time ?? -Infinity) >= 0.2 - EPSILON;
    // Existing supported voice attacks do not require exact F0 stability.
    if (!uncertain && (activeMidi === null || attack)) {
      events.push({ time: frame.time, midi, index, kind: activeMidi === null ? "entry" : "attack" });
      activeMidi = midi; continue;
    }
    if (high - low > 1) continue;
    if (uncertain) { activeMidi = midi; uncertain = false; continue; }
    if (activeMidi !== null && Math.abs(midi - activeMidi) >= 1) {
      events.push({ time: frame.time, midi, index, kind: "change" }); activeMidi = midi;
    }
  }
  return events;
}

/** Recover only observed local boundaries; this function never sees a target track. */
export function extractStableSingingEvents(track: PitchFrame[]): SingingEventExtraction {
  const baseline = baselineEvents(track);
  let events = baseline.filter(event => {
    if (event.kind !== "entry" || event.index === 0) return true;
    if (quiet(track[event.index - 1]) && quiet(track[event.index - 2])
      && event.time - track[event.index - 2].time <= 0.1 + EPSILON) return true;
    let index = event.index - 1;
    while (index >= 0 && !usable(track[index])) {
      if (!quiet(track[index])) return false;
      index--;
    }
    // Missing timestamp intervals are unknown, even when no flag was stored.
    return event.index === 0 || track[event.index].time - track[event.index - 1].time <= 0.15 + EPSILON;
  });
  const suppressedUnresolvedEntryCount = baseline.length - events.length;
  let recoveredEnergyEntryCount = 0, recoveredShortBoundaryCount = 0, replacedDelayedEntryCount = 0;
  for (let index = 2; index < track.length - 2; index++) {
    const frame = track[index], before = track[index - 2], valley = track[index - 1];
    const recovery = track.slice(index, index + 3);
    const activeRecovery = recovery.every(point => !point.clipped && Number.isFinite(point.rms) && point.rms >= 0.01)
      && recovery[2].time - frame.time <= 0.1 + EPSILON;
    const quietEntry = quiet(before) && quiet(valley) && frame.time - before.time <= 0.1 + EPSILON;
    const valleyEntry = usable(before) && before.rms >= 0.01 && valley && !valley.ambiguous && !valley.clipped
      && Number.isFinite(valley.rms) && valley.rms >= 0 && valley.rms <= before.rms * 0.5
      && frame.time - before.time <= 0.1 + EPSILON
      && recovery.every(point => point.rms >= valley.rms * 2.5)
      && !events.some(event => event.time < frame.time && frame.time - event.time < 0.2 - EPSILON);
    if (!activeRecovery || (!quietEntry && !valleyEntry)) continue;
    let anchorIndex = index, midi: number | null = null;
    for (; anchorIndex < track.length && track[anchorIndex].time - frame.time <= 0.5 + EPSILON; anchorIndex++) {
      // The acoustic entry is observed now; an uncertain F0 may settle later.
      // Never carry an anchor across a quiet/damaged interruption.
      if (track[anchorIndex].clipped || !Number.isFinite(track[anchorIndex].rms) || track[anchorIndex].rms < 0.01
        || (anchorIndex > index && track[anchorIndex].time - track[anchorIndex - 1].time > 0.05 + EPSILON)) break;
      if (!usable(track[anchorIndex])) continue;
      const notes: number[] = [];
      for (let next = anchorIndex; next < track.length && track[next].time - frame.time <= 0.6 + EPSILON; next++) {
        const point = track[next], previous = track[next - 1];
        if (point.clipped || !Number.isFinite(point.rms) || point.rms < 0.01
          || (next > anchorIndex && point.time - previous.time > 0.05 + EPSILON)) break;
        if (usable(point)) notes.push(point.midi!);
        if (notes.length === 3) break;
      }
      if (notes.length !== 3) continue;
      const low = Math.min(...notes), high = Math.max(...notes);
      if (high - low <= 1) { midi = notes[0] + notes[1] + notes[2] - low - high; break; }
    }
    if (midi === null) continue;
    if (events.some(event => Math.abs(event.time - frame.time) <= EPSILON)) continue;
    // A later baseline point describing this recovery is replaced by the observed RMS entry.
    const previousCount = events.length;
    events = events.filter(event => event.time < frame.time - EPSILON || event.time > track[anchorIndex].time + EPSILON);
    replacedDelayedEntryCount += previousCount - events.length;
    events.push({ time: frame.time, midi, index, kind: "entry", recoveryPitchAnchorIndex: anchorIndex }); recoveredEnergyEntryCount++;
  }
  for (let index = 2; index < track.length - 2; index++) {
    const midi = stableMidi(track, index);
    if (midi === null || events.some(event => Math.abs(event.time - track[index].time) <= EPSILON
      || event.recoveryPitchAnchorIndex === index)) continue;
    let lastOld = index - 1;
    while (lastOld >= 0 && !usable(track[lastOld]) && !quiet(track[lastOld])) lastOld--;
    if (lastOld < 1 || quiet(track[lastOld])
      || track[index].time - track[lastOld].time > MAX_SHORT_BOUNDARY_SECONDS + EPSILON) continue;
    let previousOld = lastOld - 1;
    while (previousOld >= 0 && !usable(track[previousOld]) && !quiet(track[previousOld])) previousOld--;
    if (previousOld < 0 || quiet(track[previousOld])
      || track[lastOld].time - track[previousOld].time > MAX_SHORT_BOUNDARY_SECONDS + EPSILON) continue;
    const localGap = track.slice(previousOld, index).some((point, offset) => !usable(point)
      || (offset > 0 && point.time - track[previousOld + offset - 1].time > 0.05 + EPSILON));
    if (!localGap) continue;
    const oldA = track[lastOld].midi!, oldB = track[previousOld].midi!;
    if (Math.abs(oldA - oldB) > 1 || Math.abs(midi - (oldA + oldB) / 2) < 1) continue;
    // Two nearby agreeing old observations bound the old side, even if an
    // earlier unknown interval prevented the baseline from locking that note.
    events.push({ time: track[index].time, midi, index, kind: "short_gap" }); recoveredShortBoundaryCount++;
  }
  events.sort((a, b) => a.time - b.time);
  let consolidatedExcursionEventCount = 0;
  for (let index = 1; index < events.length - 1;) {
    const previous = events[index - 1], excursion = events[index], returned = events[index + 1];
    if (excursion.kind === "change" && returned.kind === "change"
      && returned.time - excursion.time <= 0.15 + EPSILON
      && Math.abs(excursion.midi - previous.midi) > 6 && Math.abs(returned.midi - previous.midi) <= 1
      && stableMidi(track, excursion.index - 3) !== null && stableMidi(track, returned.index) !== null) {
      events.splice(index, 2); consolidatedExcursionEventCount += 2;
    } else index++;
  }
  let consolidatedSlideEventCount = 0;
  // Require continuous intermediate motion and stable endpoints. Abrupt short
  // notes, same-note attacks and an unfinished slide remain separate evidence.
  for (let index = 1; index < events.length - 1;) {
    const previous = events[index - 1];
    let end = index;
    const direction = Math.sign(events[index].midi - previous.midi);
    while (end + 1 < events.length && events[end].kind === "change" && events[end + 1].kind === "change"
      && events[end + 1].time - events[end].time < 0.15 - EPSILON
      && direction * (events[end + 1].midi - events[end].midi) > 0) end++;
    const arrival = events[end];
    const path = track.slice(Math.max(previous.index + 2, events[index].index - 3), arrival.index + 3);
    const monotone = direction !== 0 && path.every((point, i) => usable(point)
      && (i === 0 || (direction * (point.midi! - path[i - 1].midi!) >= -EPSILON
        && Math.abs(point.midi! - path[i - 1].midi!) < 1 - EPSILON)));
    const gradual = path.some((point, i) => i > 0 && Math.abs(point.midi! - path[i - 1].midi!) > EPSILON);
    const settled = track.filter(point => point.time >= arrival.time - EPSILON && point.time <= arrival.time + 0.15 + EPSILON);
    const stableArrival = settled.length >= 3 && settled.at(-1)!.time - arrival.time >= 0.15 - EPSILON
      && settled.every(usable) && Math.max(...settled.map(point => point.midi!)) - Math.min(...settled.map(point => point.midi!)) <= 1;
    if (end > index && stableMidi(track, events[index].index - 3) !== null && monotone && gradual && stableArrival) {
      events.splice(index, end - index); consolidatedSlideEventCount += end - index;
    } else index++;
  }
  return { rawCount: baseline.length, suppressedUnresolvedEntryCount, events: events.map(event => event.time), recoveredEnergyEntryCount, replacedDelayedEntryCount,
    recoveredShortBoundaryCount, consolidatedExcursionEventCount, consolidatedSlideEventCount };
}
