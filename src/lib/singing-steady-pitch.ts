import type { PitchFrame } from './singing-evidence';
import { SINGING_PRACTICE_TOLERANCE } from './singing-practice-octave';

/** Reference-only note centres on the original time axis; these are practice parameters. */
export const STEADY_PITCH_AGGREGATION = 'reference_steady_centres_guarded_v1' as const;
const HOP_SECONDS = 0.05;
const MIN_SEGMENT_SECONDS = 0.2;
const REFERENCE_CENTRE_BAND_SEMITONES = 0.6;
const EPSILON = 1e-7;
const FULL_CREDIT_CENTS = SINGING_PRACTICE_TOLERANCE * 100;
const ZERO_CREDIT_CENTS = 200;

export interface TimedPitchDifference {
  referenceTime: number;
  /** Signed difference from the closest permitted octave of the reference note. */
  differenceSemitones: number;
}
export interface SteadyPitchAggregation {
  aggregationAlgorithm: typeof STEADY_PITCH_AGGREGATION;
  rawFramePitch: number | null;
  steadyCentrePitch: number | null;
  steadySegmentCount: number;
  steadyPairedFrameCount: number;
  /** Fraction of all actual reliable pairs represented in measured steady segments. */
  steadyPairCoverage: number | null;
  steadyMinSegmentSeconds: number;
  severeErrorRatio: number | null;
  severeErrorCap: number | null;
  dispersionCap: number | null;
  /** Original frame-credit loss from >=200ms runs at least one semitone away. */
  sustainedErrorCap: number | null;
  pitch: number | null;
  /** Internal decision; the caller records a fallback quality flag. */
  steadyAggregationApplied: boolean;
}
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
function usable(frame: PitchFrame): boolean {
  return frame.midi !== null && Number.isFinite(frame.midi) && Number.isFinite(frame.rms)
    && frame.rms > 0 && !frame.clipped && !frame.ambiguous;
}
function credit(cents: number): number {
  return cents <= FULL_CREDIT_CENTS + EPSILON ? 1 : Math.max(0, (ZERO_CREDIT_CENTS - cents) / (ZERO_CREDIT_CENTS - FULL_CREDIT_CENTS));
}

/**
 * A centre is formed using only a continuous reference plateau (>=200 ms).
 * Segmentation uses only the reference, and each pair already carries its
 * measured pitch difference. Large errors in every reliable pair still
 * limit the result, including pairs outside these plateaus.
 */
export function aggregateSteadyPitch(
  reference: readonly PitchFrame[], differences: readonly TimedPitchDifference[], rawFramePitch: number | null,
): SteadyPitchAggregation {
  const pairs = differences.filter(pair => Number.isFinite(pair.referenceTime) && Number.isFinite(pair.differenceSemitones));
  const validRaw = typeof rawFramePitch === 'number' && Number.isFinite(rawFramePitch) && rawFramePitch >= 0 && rawFramePitch <= 100;
  const result: SteadyPitchAggregation = {
    aggregationAlgorithm: STEADY_PITCH_AGGREGATION, rawFramePitch: validRaw ? rawFramePitch : null,
    steadyCentrePitch: null, steadySegmentCount: 0, steadyPairedFrameCount: 0,
    steadyPairCoverage: pairs.length ? 0 : null, steadyMinSegmentSeconds: MIN_SEGMENT_SECONDS,
    severeErrorRatio: null, severeErrorCap: null, dispersionCap: null, sustainedErrorCap: null,
    pitch: validRaw ? rawFramePitch : null, steadyAggregationApplied: false,
  };
  if (!pairs.length || !validRaw) return result;
  result.severeErrorRatio = pairs.filter(pair => Math.abs(pair.differenceSemitones) * 100 >= ZERO_CREDIT_CENTS - EPSILON).length / pairs.length;
  result.severeErrorCap = 100 * (1 - result.severeErrorRatio);
  result.dispersionCap = 100 * (1 - (1 - rawFramePitch / 100) ** 2);
  // A correct majority cannot erase a sustained wrong portion of each note.
  // Count only actual adjacent observed windows; missing/unknown frames break
  // the run. Short natural slides retain the centre-based classroom tolerance.
  let sustainedLoss = 0, runLoss = 0, runCount = 0, previousTime = -Infinity;
  const finishRun = () => {
    if (runCount * HOP_SECONDS >= MIN_SEGMENT_SECONDS - EPSILON) sustainedLoss += runLoss;
    runLoss = 0; runCount = 0; previousTime = -Infinity;
  };
  for (const pair of pairs) {
    const cents = Math.abs(pair.differenceSemitones) * 100;
    if (cents < 100 - EPSILON) { finishRun(); continue; }
    if (pair.referenceTime - previousTime > HOP_SECONDS + EPSILON) finishRun();
    runCount++; runLoss += 1 - credit(cents); previousTime = pair.referenceTime;
  }
  finishRun();
  result.sustainedErrorCap = 100 * (1 - sustainedLoss / pairs.length);
  const byTime = new Map(pairs.map(pair => [Math.floor((pair.referenceTime + EPSILON) / HOP_SECONDS), pair]));
  const segments: PitchFrame[][] = [];
  let segment: PitchFrame[] = [];
  const finish = () => { if (segment.length) segments.push(segment); segment = []; };
  for (const frame of reference) {
    if (!usable(frame)) { finish(); continue; }
    if (segment.length && (frame.time - segment.at(-1)!.time > HOP_SECONDS + EPSILON
      || Math.abs(frame.midi! - median(segment.map(point => point.midi!))) > REFERENCE_CENTRE_BAND_SEMITONES + EPSILON)) finish();
    segment.push(frame);
  }
  finish();
  let weightedCredit = 0;
  for (const candidate of segments) {
    if (candidate.length * HOP_SECONDS < MIN_SEGMENT_SECONDS - EPSILON) continue;
    const measured = candidate.map(point => byTime.get(Math.floor((point.time + EPSILON) / HOP_SECONDS))).filter((pair): pair is TimedPitchDifference => !!pair);
    // A minority of observations cannot stand in for this reference plateau.
    if (measured.length < 3 || measured.length / candidate.length < 0.5) continue;
    // Opposite deviations must not cancel (e.g. alternating +100/-100 cents).
    const error = median(measured.map(pair => Math.abs(pair.differenceSemitones))) * 100;
    weightedCredit += measured.length * credit(error);
    result.steadySegmentCount++;
    result.steadyPairedFrameCount += measured.length;
  }
  result.steadyPairCoverage = result.steadyPairedFrameCount / pairs.length;
  if (result.steadyPairedFrameCount) {
    result.steadyCentrePitch = 100 * weightedCredit / result.steadyPairedFrameCount;
    if (result.steadyPairedFrameCount >= 20 && result.steadyPairCoverage >= .5) {
      result.steadyAggregationApplied = true;
      result.pitch = Math.round(10 * Math.min(result.steadyCentrePitch, result.severeErrorCap, result.dispersionCap, result.sustainedErrorCap)) / 10;
    }
  }
  return result;
}
