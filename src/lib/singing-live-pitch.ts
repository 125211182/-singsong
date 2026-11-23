import type { PitchFrame } from "./singing-evidence";
import { singingPracticePitchDifference, SINGING_PRACTICE_TOLERANCE } from "./singing-practice-octave";

type Measurement = Pick<PitchFrame, "midi" | "clipped" | "ambiguous" | "candidateMidi">;
export interface LivePitchMarker {
  midi: number;
  tone: "hit" | "miss" | "pending";
  difference: number | null;
}
export type LivePitchStatus = "no_reference" | "matched" | "deviated" | "no_signal" | "ambiguous" | "clipped";

/** A visible measurement is independent from permission to judge its accuracy. */
export function getLivePitchDisplay(
  detected: Measurement | null | undefined,
  reference: Measurement | null | undefined,
  tolerance = SINGING_PRACTICE_TOLERANCE,
): { marker: LivePitchMarker | null; status: LivePitchStatus } {
  if (detected?.clipped) return { marker: null, status: "clipped" };
  if (detected?.ambiguous) {
    const candidate = detected.candidateMidi;
    return { marker: candidate !== undefined && Number.isFinite(candidate)
      ? { midi: candidate, tone: "pending", difference: null } : null, status: "ambiguous" };
  }
  if (detected?.midi === null || detected?.midi === undefined || !Number.isFinite(detected.midi)) return { marker: null, status: "no_signal" };
  const midi = detected.midi;
  const pending: LivePitchMarker = { midi, tone: "pending", difference: null };
  if (reference?.midi === null || reference?.midi === undefined || !Number.isFinite(reference.midi) || reference.clipped || reference.ambiguous) return { marker: pending, status: "no_reference" };
  const difference = singingPracticePitchDifference(midi, reference.midi);
  const matched = Math.abs(difference) <= tolerance + 1e-9;
  return { marker: { midi, tone: matched ? "hit" : "miss", difference }, status: matched ? "matched" : "deviated" };
}

export const LIVE_PITCH_STATUS_TEXT: Record<LivePitchStatus, string> = {
  no_reference: "当前无可比较范唱音 · 显示拾音位置",
  matched: "唱准了，继续保持！",
  deviated: "音高有偏差 · 跟随旋律调整",
  no_signal: "等待清晰人声 · 波形显示拾音活动",
  ambiguous: "拾音位置待确认 · 空心点暂不判准，可适当调低外放音量",
  clipped: "录音过载 · 请降低麦克风音量",
};

export function getLivePitchRange(reference: readonly PitchFrame[], markerMidi?: number) {
  let min = 45, max = 85;
  for (const frame of reference) {
    if (frame.midi === null || !Number.isFinite(frame.midi) || frame.clipped || frame.ambiguous) continue;
    // Give the original melody and both practice guides a shared vertical scale.
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
