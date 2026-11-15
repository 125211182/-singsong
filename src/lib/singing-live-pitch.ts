import { inferSingingOctave, type PitchFrame, type SingingOctaveCalibration, type SingingPitchPair } from "./singing-evidence";

type Measurement = Pick<PitchFrame, "midi" | "clipped" | "ambiguous" | "candidateMidi">;
export interface LivePitchMarker {
  midi: number;
  tone: "hit" | "miss" | "pending";
  difference: number | null;
}
export interface LivePitchGuide {
  midi: number;
  tone: "neutral" | "selected";
}
export type LivePitchStatus = "calibrating" | "no_reference" | "matched" | "deviated" | "no_signal" | "ambiguous" | "clipped";

/** A visible measurement is independent from permission to judge its accuracy. */
export function getLivePitchDisplay(
  detected: Measurement | null | undefined,
  calibration: SingingOctaveCalibration,
  reference: Measurement | null | undefined,
  tolerance = 0.6,
): { marker: LivePitchMarker | null; status: LivePitchStatus } {
  if (detected?.clipped) return { marker: null, status: "clipped" };
  if (detected?.ambiguous) {
    const candidate = detected.candidateMidi;
    return { marker: candidate !== undefined && Number.isFinite(candidate)
      ? { midi: candidate, tone: "pending", difference: null } : null, status: "ambiguous" };
  }
  if (detected?.midi === null || detected?.midi === undefined || !Number.isFinite(detected.midi)) return { marker: null, status: "no_signal" };
  const calibrated = calibration.status === "calibrated" && calibration.shiftSemitones !== null;
  const midi = detected.midi;
  const pending: LivePitchMarker = { midi, tone: "pending", difference: null };
  if (!calibrated) return { marker: pending, status: "calibrating" };
  if (reference?.midi === null || reference?.midi === undefined || !Number.isFinite(reference.midi) || reference.clipped || reference.ambiguous) return { marker: pending, status: "no_reference" };
  const difference = midi - (reference.midi + calibration.shiftSemitones!);
  const matched = Math.abs(difference) <= tolerance + 1e-9;
  return { marker: { midi, tone: matched ? "hit" : "miss", difference }, status: matched ? "matched" : "deviated" };
}

/** Project the reference into candidate registers; measured pitches never move. */
export function getLivePitchGuides(
  reference: Measurement | null | undefined,
  calibration: SingingOctaveCalibration,
): LivePitchGuide[] {
  if (reference?.midi === null || reference?.midi === undefined || !Number.isFinite(reference.midi) || reference.clipped || reference.ambiguous) return [];
  const referenceMidi = reference.midi;
  const calibrated = calibration.status === "calibrated" && calibration.shiftSemitones !== null;
  const shifts = calibrated ? [calibration.shiftSemitones!] : [-12, 0, 12];
  return shifts.map(shift => ({ midi: referenceMidi + shift, tone: calibrated ? "selected" : "neutral" }));
}

const LIVE_OCTAVE_MIN_PAIRS = 12;

/** A strict early UI lock; recorded-audio scoring retains its original 40-pair inference. */
export function inferLiveSingingOctave(pairs: readonly SingingPitchPair[]): SingingOctaveCalibration {
  if (pairs.length >= LIVE_OCTAVE_MIN_PAIRS) {
    const differences = pairs.map(pair => pair.singingMidi - pair.referenceMidi).sort((a, b) => a - b);
    if (differences.every(Number.isFinite)) {
      const quantile = (fraction: number) => {
        const index = (differences.length - 1) * fraction;
        const lower = Math.floor(index);
        return differences[lower] + (differences[Math.ceil(index)] - differences[lower]) * (index - lower);
      };
      const candidates = ([-12, 0, 12] as const).map(shift => ({
        shift, supportRatio: differences.filter(value => Math.abs(value - shift) <= 1.5 + 1e-9).length / differences.length,
      })).filter(candidate => candidate.supportRatio >= 0.95);
      if (candidates.length === 1 && quantile(0.75) - quantile(0.25) <= 0.5 + 1e-9) {
        return { status: "calibrated", shiftSemitones: candidates[0].shift, sampleCount: differences.length, supportRatio: candidates[0].supportRatio };
      }
    }
  }
  return inferSingingOctave(pairs);
}

export const LIVE_PITCH_STATUS_TEXT: Record<LivePitchStatus, string> = {
  calibrating: "音区核对中 · 显示实际音高，暂不判准",
  no_reference: "当前无可比较范唱音 · 显示拾音位置",
  matched: "音高吻合",
  deviated: "音高有偏差 · 跟随旋律调整",
  no_signal: "等待清晰人声 · 波形显示拾音活动",
  ambiguous: "拾音位置待确认 · 空心点暂不判准，可适当调低外放音量",
  clipped: "录音过载 · 请降低麦克风音量",
};

export function getLivePitchRange(reference: readonly PitchFrame[], markerMidi?: number) {
  let min = 45, max = 85;
  for (const frame of reference) {
    if (frame.midi === null || !Number.isFinite(frame.midi) || frame.clipped || frame.ambiguous) continue;
    // Reserve all candidate registers plus padding before and after the lock.
    min = Math.min(min, frame.midi - 12 - 3);
    max = Math.max(max, frame.midi + 12 + 3);
  }
  if (markerMidi !== undefined && Number.isFinite(markerMidi)) {
    min = Math.min(min, markerMidi - 3);
    max = Math.max(max, markerMidi + 3);
  }
  return { min, max };
}

export function livePitchY(midi: number, height: number, range: { min: number; max: number }) {
  return height - (midi - range.min) / (range.max - range.min) * height;
}
