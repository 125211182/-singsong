import type { PitchFrame } from "./singing-evidence";
import { extractStableSingingEvents } from "./singing-rhythm-events";

const HOP_SECONDS = 0.05;
const MAX_EVENT_ERROR_SECONDS = 0.5;
// Versioned classroom practice rubric, not validated attainment norms.
// Fixed acquisition timeline: 200ms full, 300ms 95%, 400ms 80%, 500ms zero.
const FULL_CREDIT_SECONDS = 0.2;
const UNKNOWN_BOUNDARY_SPAN_SECONDS = 0.4;
const ZERO_CREDIT_SECONDS = 0.5;

export interface RhythmEvidence {
  status: "measured" | "insufficient_evidence";
  /** Pre-v3.5 baseline candidates, before boundary recovery/consolidation. */
  rawReferenceEventCount?: number;
  /** Recording events outside the reference vocal range, excluded from song timing. */
  preludeRecordingEventCount?: number;
  energyEntryAnchorSeconds?: number;
  rawRecordingEventCount?: number;
  referenceUnstableBoundaryFrameCount?: number;
  recordingUnstableBoundaryFrameCount?: number;
  excludedUnobservableReferenceEventCount?: number;
  excludedUnobservableRecordingEventCount?: number;
  eventExtractionAlgorithm?: "stable_main_events_v2";
  matchingAlgorithm?: "monotonic_max_credit_v1";
  aggregationAlgorithm?: "min_timing_recall_event_f1_v1" | "classroom_event_rubric_v1";
  timingCurve?: "classroom_timing_v1";
  eventCountCurve?: "classroom_event_count_v1";
  eventRecallCredit?: number;
  eventF1Credit?: number;
  rawTimingMatchCredit?: number;
  rawRhythmScore?: number;
  clearMissingEventCount?: number;
  clearMissingEventCap?: number;
  timingMatchCredit?: number;
  eventF1Coverage?: number;
  fullCreditSeconds?: number;
  zeroCreditSeconds?: number;
  boundarySearchSeconds?: number;
  unknownBoundarySpanSeconds?: number;
  maxBoundaryUncertaintySeconds?: number;
  suppressedReferenceUnresolvedEntryCount?: number;
  suppressedRecordingUnresolvedEntryCount?: number;
  recoveredReferenceEnergyEntryCount?: number;
  recoveredRecordingEnergyEntryCount?: number;
  replacedReferenceDelayedEntryCount?: number;
  replacedRecordingDelayedEntryCount?: number;
  recoveredReferenceShortBoundaryCount?: number;
  recoveredRecordingShortBoundaryCount?: number;
  consolidatedReferenceExcursionEventCount?: number;
  consolidatedRecordingExcursionEventCount?: number;
  consolidatedReferenceSlideEventCount?: number;
  consolidatedRecordingSlideEventCount?: number;
  /** Processed stable-main-event sets; scorable counts below describe measurable scope. */
  referenceEventCount: number;
  recordingEventCount: number;
  matchedEventCount: number;
  onsetCoverage: number | null;
  medianOnsetErrorSeconds: number | null;
  tempoRatio: number | null;
  qualityFlags: string[];
  startOffsetSeconds?: number;
  detectedEntryOffsetSeconds?: number;
  observableFrameCoverage?: number;
  /** Reliable fraction of active frames (RMS >= .01 or flagged uncertain/clipped); excludes quiet rests. */
  referenceObservableCoverage?: number;
  recordingObservableCoverage?: number;
  excludedClippedFrameCount?: number;
  eventObservationCoverage?: number;
  scorableReferenceEventCount?: number;
  scorableRecordingEventCount?: number;
  scorableMatchedEventCount?: number;
  conditionalMatchCoverage?: number;
  scoreScope?: "whole_reference" | "measured_segments";
}

export interface ExpressionEvidence {
  status: "described" | "insufficient_evidence";
  voicedSeconds: number;
  dynamicRangeDb: number | null;
  phraseCount: number;
  qualityFlags: string[];
}

function usable(frame: PitchFrame & { ambiguous?: boolean }): boolean {
  return frame.midi !== null && Number.isFinite(frame.midi)
    && Number.isFinite(frame.rms) && frame.rms > 0
    && !frame.clipped && !frame.ambiguous;
}

function validTimeline(track: PitchFrame[]): boolean {
  return track.every((frame, index) => Number.isFinite(frame.time) && frame.time >= 0
    && (index === 0 || frame.time > track[index - 1].time));
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** Stable main entries and note boundaries on the observed acquisition timeline. */
export function extractSingingEvents(track: PitchFrame[]): number[] {
  return extractStableSingingEvents(track).events;
}

function rawTimingCredit(error: number): number {
  if (error <= FULL_CREDIT_SECONDS + 1e-6) return 1;
  if (error >= ZERO_CREDIT_SECONDS - 1e-6) return 0;
  return (ZERO_CREDIT_SECONDS - error) / (ZERO_CREDIT_SECONDS - FULL_CREDIT_SECONDS);
}

function interpolateCredit(value: number, points: readonly (readonly [number, number])[]): number {
  if (value <= points[0][0]) return points[0][1];
  for (let i = 1; i < points.length; i++) {
    const [x, y] = points[i], [beforeX, beforeY] = points[i - 1];
    if (value <= x + 1e-9) return beforeY + Math.min(1, (value - beforeX) / (x - beforeX)) * (y - beforeY);
  }
  return points.at(-1)![1];
}

function timingCredit(error: number): number {
  if (error >= ZERO_CREDIT_SECONDS - 1e-6) return 0;
  if (error <= FULL_CREDIT_SECONDS + 1e-6) return 1;
  return interpolateCredit(error, [[0, 1], [.2, 1], [.3, .95], [.4, .8], [.5, 0]]);
}

function eventCountCredit(ratio: number): number {
  // Raw recall/F1 remain stored. Modest count disagreements receive classroom
  // tolerance; half or less corresponding evidence is never lifted above 50.
  return interpolateCredit(ratio, [[0, 0], [.5, .5], [.7, .9], [.8, .95], [.9, .98], [1, 1]]);
}

interface EventPair { reference: number; recording: number }

/** Hirschberg reconstruction: linear numeric-row memory, no object per DP cell.
 * Objective: maximum credit, then more pairs, then smaller total absolute error. */
function matchEvents(targets: number[], observations: number[]): EventPair[] {
  const better = (credit: number, count: number, error: number, bestCredit: number, bestCount: number, bestError: number) =>
    credit > bestCredit + 1e-9 || (Math.abs(credit - bestCredit) <= 1e-9
      && (count > bestCount || (count === bestCount && error < bestError - 1e-9)));
  const row = (start: number, end: number, left: number, right: number, reverse: boolean) => {
    const size = right - left;
    const credits = new Float64Array(size + 1), counts = new Uint32Array(size + 1), errors = new Float64Array(size + 1);
    for (let i = 0; i < end - start; i++) {
      let diagonalCredit = 0, diagonalCount = 0, diagonalError = 0;
      const target = targets[reverse ? end - i - 1 : start + i];
      for (let j = 1; j <= size; j++) {
        const oldCredit = credits[j], oldCount = counts[j], oldError = errors[j];
        if (better(credits[j - 1], counts[j - 1], errors[j - 1], credits[j], counts[j], errors[j])) {
          credits[j] = credits[j - 1]; counts[j] = counts[j - 1]; errors[j] = errors[j - 1];
        }
        const error = Math.abs(target - observations[reverse ? right - j : left + j - 1]);
        const credit = diagonalCredit + timingCredit(error);
        if (error <= MAX_EVENT_ERROR_SECONDS + 1e-6 && better(credit, diagonalCount + 1,
          diagonalError + error, credits[j], counts[j], errors[j])) {
          credits[j] = credit; counts[j] = diagonalCount + 1; errors[j] = diagonalError + error;
        }
        diagonalCredit = oldCredit; diagonalCount = oldCount; diagonalError = oldError;
      }
    }
    return { credits, counts, errors };
  };
  const pairs: EventPair[] = [];
  const solve = (start: number, end: number, left: number, right: number): void => {
    if (start >= end || left >= right) return;
    if (end - start === 1) {
      let best = -1, bestCredit = -1, bestError = Infinity;
      for (let j = left; j < right; j++) {
        const error = Math.abs(targets[start] - observations[j]), credit = timingCredit(error);
        if (error <= MAX_EVENT_ERROR_SECONDS + 1e-6 && better(credit, 1, error, bestCredit, best >= 0 ? 1 : 0, bestError)) {
          best = j; bestCredit = credit; bestError = error;
        }
      }
      if (best >= 0) pairs.push({ reference: targets[start], recording: observations[best] });
      return;
    }
    const middle = Math.floor((start + end) / 2);
    // Rows leave scope before recursion, keeping working memory linear.
    const split = (() => {
      const forward = row(start, middle, left, right, false), backward = row(middle, end, left, right, true);
      let best = 0, bestCredit = -1, bestCount = -1, bestError = Infinity;
      for (let j = 0; j <= right - left; j++) {
        const k = right - left - j;
        const credit = forward.credits[j] + backward.credits[k], count = forward.counts[j] + backward.counts[k];
        const error = forward.errors[j] + backward.errors[k];
        if (better(credit, count, error, bestCredit, bestCount, bestError)) {
          best = j; bestCredit = credit; bestCount = count; bestError = error;
        }
      }
      return left + best;
    })();
    solve(start, middle, left, split); solve(middle, end, split, right);
  };
  solve(0, targets.length, 0, observations.length);
  return pairs;
}

/** Explicit quiet and clear held notes are observed; corrupt/missing spans are unknown. */
function boundaryObservations(track: PitchFrame[], lead: number): { spans: [number, number][]; unstablePitchFrameCount: number } {
  const stable = new Uint8Array(track.length);
  for (let i = 0; i < track.length - 2; i++) {
    const a = track[i], b = track[i + 1], c = track[i + 2];
    if (usable(a) && usable(b) && usable(c) && c.time - a.time <= 0.1 + 1e-6
      && Math.max(a.midi!, b.midi!, c.midi!) - Math.min(a.midi!, b.midi!, c.midi!) <= 1) {
      stable[i] = 1; stable[i + 1] = 1; stable[i + 2] = 1;
    }
  }
  let unstablePitchFrameCount = 0;
  const spans: [number, number][] = [];
  const append = (start: number, end: number) => {
    const previous = spans.at(-1);
    if (previous && previous[1] >= start - 1e-6) previous[1] = Math.max(previous[1], end);
    else spans.push([start, end]);
  };
  for (let i = 0; i < track.length; i++) {
    const frame = track[i], previous = track[i - 1];
    if (previous && frame.time - previous.time > HOP_SECONDS + 1e-6) {
      append(previous.time + HOP_SECONDS / 2 - lead, frame.time - HOP_SECONDS / 2 - lead);
    }
    const quiet = !frame.ambiguous && !frame.clipped
      && Number.isFinite(frame.rms) && frame.rms >= 0 && frame.rms < 0.01;
    if (!quiet && (!usable(frame) || !stable[i])) {
      if (usable(frame) && !stable[i]) unstablePitchFrameCount++;
      append(frame.time - HOP_SECONDS / 2 - lead, frame.time + HOP_SECONDS / 2 - lead);
    }
  }
  if (track.length) {
    spans.unshift([-Infinity, track[0].time - HOP_SECONDS / 2 - lead]);
    spans.push([track.at(-1)!.time + HOP_SECONDS / 2 - lead, Infinity]);
  } else spans.push([-Infinity, Infinity]);
  return { spans, unstablePitchFrameCount };
}

function boundaryUnknown(spans: [number, number][], target: number): boolean {
  return spans.some(([start, end]) => Math.min(end, target + UNKNOWN_BOUNDARY_SPAN_SECONDS)
    - Math.max(start, Math.max(0, target - UNKNOWN_BOUNDARY_SPAN_SECONDS)) > 0.15 + 1e-6);
}

export function analyzeRhythmFeedback(
  reference: PitchFrame[],
  recording: PitchFrame[],
  recordingLeadSeconds: number,
): { rhythm: number | null; comment: string; evidence: RhythmEvidence } {
  const evidence: RhythmEvidence = {
    status: "insufficient_evidence", referenceEventCount: 0, recordingEventCount: 0,
    matchedEventCount: 0, onsetCoverage: null, medianOnsetErrorSeconds: null,
    tempoRatio: null, qualityFlags: [],
    eventExtractionAlgorithm: "stable_main_events_v2", matchingAlgorithm: "monotonic_max_credit_v1",
    aggregationAlgorithm: "classroom_event_rubric_v1",
    timingCurve: "classroom_timing_v1", eventCountCurve: "classroom_event_count_v1",
    energyEntryAnchorSeconds: 0.5,
    fullCreditSeconds: FULL_CREDIT_SECONDS, zeroCreditSeconds: ZERO_CREDIT_SECONDS,
    boundarySearchSeconds: MAX_EVENT_ERROR_SECONDS, unknownBoundarySpanSeconds: UNKNOWN_BOUNDARY_SPAN_SECONDS,
    maxBoundaryUncertaintySeconds: 0.15,
  };
  const insufficient = (reason: string, comment: string) => {
    evidence.qualityFlags.push(reason);
    return { rhythm: null, comment, evidence };
  };
  if (!validTimeline(reference) || !validTimeline(recording)) {
    return insufficient("track_timing_invalid", "录音时间信息不足，请试听录音并跟伴奏分句练习。");
  }
  const referenceExtraction = extractStableSingingEvents(reference);
  const recordingExtraction = extractStableSingingEvents(recording);
  const referenceEvents = referenceExtraction.events;
  const lead = Number.isFinite(recordingLeadSeconds) ? Math.max(0, recordingLeadSeconds) : 0;
  const allRecordingEvents = recordingExtraction.events.map(time => time - lead);
  const referenceVoice = reference.filter(usable);
  const firstVoice = referenceVoice[0]?.time ?? 0;
  const lastVoice = referenceVoice.at(-1)?.time ?? 0;
  // Prelude microphone checks are not missed/extra events in the sung task.
  // Retain a full search-bound margin so genuinely early/late entrances count.
  const recordingEvents = allRecordingEvents.filter(time =>
    time >= firstVoice - MAX_EVENT_ERROR_SECONDS - 1e-6
    && time <= lastVoice + MAX_EVENT_ERROR_SECONDS + 1e-6);
  evidence.preludeRecordingEventCount = allRecordingEvents.length - recordingEvents.length;
  evidence.rawReferenceEventCount = referenceExtraction.rawCount;
  evidence.rawRecordingEventCount = recordingExtraction.rawCount;
  evidence.suppressedReferenceUnresolvedEntryCount = referenceExtraction.suppressedUnresolvedEntryCount;
  evidence.suppressedRecordingUnresolvedEntryCount = recordingExtraction.suppressedUnresolvedEntryCount;
  evidence.recoveredReferenceEnergyEntryCount = referenceExtraction.recoveredEnergyEntryCount;
  evidence.recoveredRecordingEnergyEntryCount = recordingExtraction.recoveredEnergyEntryCount;
  evidence.replacedReferenceDelayedEntryCount = referenceExtraction.replacedDelayedEntryCount;
  evidence.replacedRecordingDelayedEntryCount = recordingExtraction.replacedDelayedEntryCount;
  evidence.recoveredReferenceShortBoundaryCount = referenceExtraction.recoveredShortBoundaryCount;
  evidence.recoveredRecordingShortBoundaryCount = recordingExtraction.recoveredShortBoundaryCount;
  evidence.consolidatedReferenceExcursionEventCount = referenceExtraction.consolidatedExcursionEventCount;
  evidence.consolidatedRecordingExcursionEventCount = recordingExtraction.consolidatedExcursionEventCount;
  evidence.consolidatedReferenceSlideEventCount = referenceExtraction.consolidatedSlideEventCount;
  evidence.consolidatedRecordingSlideEventCount = recordingExtraction.consolidatedSlideEventCount;
  evidence.referenceEventCount = referenceEvents.length;
  evidence.recordingEventCount = recordingEvents.length;
  const activeFrames = (track: PitchFrame[]) => track.filter(frame =>
    (Number.isFinite(frame.rms) && frame.rms >= 0.01) || frame.ambiguous || frame.clipped);
  const referenceActive = activeFrames(reference);
  const recordingActive = activeFrames(recording);
  const observableCoverage = (frames: PitchFrame[]) => frames.length ? frames.filter(usable).length / frames.length : 0;
  const clippedCount = recording.filter(frame => frame.clipped).length;
  evidence.excludedClippedFrameCount = clippedCount;
  evidence.referenceObservableCoverage = observableCoverage(referenceActive);
  evidence.recordingObservableCoverage = observableCoverage(recordingActive);
  evidence.observableFrameCoverage = evidence.recordingObservableCoverage;
  // Quiet rests/preludes do not dilute signal quality. Missing singing remains
  // penalized by unmatched reference events, independently of activity quality.
  if ([referenceActive, recordingActive].some(track => track.filter(frame => frame.clipped).length >= track.length * 0.5 && track.length > 0)) {
    return insufficient("rhythm_clipped", "录音或范唱大部分片段过载，请先试听并检查麦克风音量。");
  }
  if (clippedCount || reference.some(frame => frame.clipped)) evidence.qualityFlags.push("rhythm_clipped_segments_excluded");
  if ([referenceActive, recordingActive].some(track => observableCoverage(track) < 0.5)) {
    return insufficient("rhythm_observation_insufficient", "活动声音中可清晰测量的片段不足一半，请先试听，再完整练习一个乐句。");
  }
  if (recording.some(frame => frame.ambiguous)) evidence.qualityFlags.push("rhythm_uncertain_segments");
  if (reference.filter(usable).length < 40 || recording.filter(usable).length < 40
    || referenceEvents.length < 4 || recordingEvents.length < 1) {
    return insufficient("rhythm_events_insufficient", "可比较的进入与换音片段较少，请先试听，再跟伴奏完整练习一个乐句。");
  }
  // A supported fixed-axis candidate remains measurable even when its local gap
  // is unknown. Only unmatched events with no candidate can leave scoring scope.
  const pairs = matchEvents(referenceEvents, recordingEvents);
  evidence.matchedEventCount = pairs.length;
  evidence.onsetCoverage = pairs.length / referenceEvents.length;
  const recordingObservation = boundaryObservations(recording, lead), referenceObservation = boundaryObservations(reference, 0);
  const recordingUnknown = recordingObservation.spans, referenceUnknown = referenceObservation.spans;
  evidence.referenceUnstableBoundaryFrameCount = referenceObservation.unstablePitchFrameCount;
  evidence.recordingUnstableBoundaryFrameCount = recordingObservation.unstablePitchFrameCount;
  if (referenceObservation.unstablePitchFrameCount || recordingObservation.unstablePitchFrameCount) {
    evidence.qualityFlags.push("rhythm_unstable_boundary_segments");
  }
  const hasCandidate = (events: number[], target: number) => events.some(time => Math.abs(time - target) <= MAX_EVENT_ERROR_SECONDS + 1e-6);
  const eventObservable = (target: number) => hasCandidate(recordingEvents, target) || !boundaryUnknown(recordingUnknown, target);
  const scorableEvents = referenceEvents.filter(eventObservable);
  const matchedRecording = new Set(pairs.map(pair => pair.recording));
  const scorableRecordingEvents = recordingEvents.filter(time => matchedRecording.has(time)
    || hasCandidate(referenceEvents, time) || !boundaryUnknown(referenceUnknown, time));
  evidence.excludedUnobservableReferenceEventCount = referenceEvents.length - scorableEvents.length;
  evidence.excludedUnobservableRecordingEventCount = recordingEvents.length - scorableRecordingEvents.length;
  evidence.scorableReferenceEventCount = scorableEvents.length;
  evidence.scorableRecordingEventCount = scorableRecordingEvents.length;
  evidence.eventObservationCoverage = scorableEvents.length / referenceEvents.length;
  evidence.scoreScope = evidence.eventObservationCoverage >= 0.95 ? "whole_reference" : "measured_segments";
  if (scorableEvents.length < 3 || evidence.eventObservationCoverage < 0.25) {
    return insufficient("rhythm_event_observation_insufficient", "可清晰观察的进入与换音位置不足，请先试听并改善录音后再试。");
  }
  if (evidence.scoreScope === "measured_segments") evidence.qualityFlags.push("rhythm_measured_segments_only");
  // Stable note detection can lag behind actual phonation during natural vibrato.
  // Only a clearly observed late voice entrance, not one missed stable event,
  // may establish a whole-beat start mismatch on this fixed time axis.
  evidence.startOffsetSeconds = recordingEvents[0] - referenceEvents[0];
  const firstReferenceVoice = reference.find(usable)!.time;
  const firstRecordingVoice = recording.find(usable)!.time - lead;
  evidence.detectedEntryOffsetSeconds = firstRecordingVoice - firstReferenceVoice;
  if (Math.abs(evidence.startOffsetSeconds) > MAX_EVENT_ERROR_SECONDS) evidence.qualityFlags.push("rhythm_start_misaligned");
  if (eventObservable(referenceEvents[0]) && evidence.detectedEntryOffsetSeconds > MAX_EVENT_ERROR_SECONDS) {
    evidence.status = "measured";
    evidence.onsetCoverage = 0;
    evidence.matchedEventCount = 0;
    evidence.scorableMatchedEventCount = 0;
    evidence.conditionalMatchCoverage = 0;
    evidence.timingMatchCredit = 0;
    evidence.eventF1Coverage = 0;
    evidence.eventRecallCredit = 0;
    evidence.eventF1Credit = 0;
    evidence.rawTimingMatchCredit = 0;
    evidence.rawRhythmScore = 0;
    evidence.clearMissingEventCount = 0;
    evidence.clearMissingEventCap = 100;
    evidence.qualityFlags.push("rhythm_start_misaligned", "timing_contour_not_notated_rhythm");
    return { rhythm: 0, evidence, comment: "录音与范唱的起唱位置相差超过半秒，固定时间轴下未作跨音符移位配对。请复听进入时机，再跟伴奏练习起句。" };
  }
  // Unmeasurable targets must not consume a recording event needed by a later
  // observable target. Both match sets use the same fixed 500 ms search bound.
  const conditionalPairs = matchEvents(scorableEvents, scorableRecordingEvents);
  evidence.scorableMatchedEventCount = conditionalPairs.length;
  evidence.conditionalMatchCoverage = conditionalPairs.length / scorableEvents.length;
  if (conditionalPairs.length < 3 || evidence.conditionalMatchCoverage < 0.5) {
    evidence.qualityFlags.push("rhythm_observed_mismatch");
  }
  const errors = conditionalPairs.map(pair => Math.abs(pair.recording - pair.reference));
  evidence.medianOnsetErrorSeconds = median(errors);
  const ratios = conditionalPairs.slice(1).map((pair, index) =>
    (pair.recording - conditionalPairs[index].recording) / (pair.reference - conditionalPairs[index].reference));
  evidence.tempoRatio = median(ratios);
  evidence.status = "measured";
  evidence.qualityFlags.push("timing_contour_not_notated_rhythm");
  const credit = errors.reduce((sum, error) => sum + timingCredit(error), 0);
  evidence.timingMatchCredit = conditionalPairs.length ? credit / conditionalPairs.length : 0;
  evidence.eventF1Coverage = 2 * conditionalPairs.length / (scorableEvents.length + scorableRecordingEvents.length);
  evidence.rawTimingMatchCredit = conditionalPairs.length
    ? errors.reduce((sum, error) => sum + rawTimingCredit(error), 0) / conditionalPairs.length : 0;
  evidence.rawRhythmScore = Math.round(1000 * Math.min(evidence.rawTimingMatchCredit,
    evidence.conditionalMatchCoverage, evidence.eventF1Coverage)) / 10;
  evidence.eventRecallCredit = eventCountCredit(evidence.conditionalMatchCoverage);
  evidence.eventF1Credit = eventCountCredit(evidence.eventF1Coverage);
  const matchedReference = new Set(conditionalPairs.map(pair => pair.reference));
  // Explicitly quiet missed positions are evidence of missing singing, rather
  // than detector count uncertainty. Unknown/missing timestamps are not silence.
  const clearlyQuiet = (event: number) => {
    const window = recording.filter(frame => frame.time - lead - event >= .025 - 1e-6
      && frame.time - lead - event <= .375 + 1e-6);
    return window.length >= 7 && window.at(-1)!.time - window[0].time >= .3 - 1e-6
      && window.every((frame, index) => frame.midi === null && !frame.ambiguous && !frame.clipped
        && Number.isFinite(frame.rms) && frame.rms >= 0 && frame.rms < .01
        && (index === 0 || frame.time - window[index - 1].time <= HOP_SECONDS + 1e-6));
  };
  evidence.clearMissingEventCount = scorableEvents.filter(event => !matchedReference.has(event) && clearlyQuiet(event)).length;
  evidence.clearMissingEventCap = 100 * (1 - evidence.clearMissingEventCount / scorableEvents.length);
  // Three independent classroom credits, with an explicit-silence cap. No
  // score floor, event deletion, best-shift search or historical recomputation.
  const rhythm = Math.round(1000 * Math.min(evidence.timingMatchCredit,
    evidence.eventRecallCredit, evidence.eventF1Credit, evidence.clearMissingEventCap / 100)) / 10;
  const missing = scorableEvents.length - conditionalPairs.length;
  const extra = scorableRecordingEvents.length - conditionalPairs.length;
  const practice = missing || extra
    ? `本次有 ${missing} 处范唱位置和 ${extra} 处录音位置未对应，请结合伴奏复听这些位置，再分句练习。`
    : "继续跟随伴奏，保持进入与换音的时机稳定。";
  const comment = `进入与换音时机在可测位置已对应 ${conditionalPairs.length}/${scorableEvents.length} 处、可测录音 ${scorableRecordingEvents.length} 处（处理后范唱共 ${referenceEvents.length} 处、录音共 ${recordingEvents.length} 处），典型时间偏差约 ${(evidence.medianOnsetErrorSeconds ?? 0).toFixed(2)} 秒。` + practice;
  return { rhythm, comment, evidence };
}

export function describeSingingExpression(
  recording: PitchFrame[],
): { comment: string; evidence: ExpressionEvidence } {
  const voiced = recording.filter(usable);
  const evidence: ExpressionEvidence = {
    status: "insufficient_evidence", voicedSeconds: voiced.length * HOP_SECONDS,
    dynamicRangeDb: null, phraseCount: 0, qualityFlags: [],
  };
  if (!validTimeline(recording) || voiced.length < 40 || recording.some(frame => frame.clipped)) {
    evidence.qualityFlags.push(recording.some(frame => frame.clipped) ? "recording_clipped" : "expression_evidence_insufficient");
    return { evidence, comment: "这次可分析的声音片段不足或出现录音过载，请先试听并检查麦克风，再练习一个完整乐句。" };
  }
  if (recording.some(frame => frame.ambiguous)) evidence.qualityFlags.push("expression_uncertain_segments");
  let previousTime = -Infinity;
  for (const frame of recording) {
    if (frame.ambiguous) {
      previousTime = frame.time;
      continue;
    }
    if (!usable(frame)) continue;
    if (evidence.phraseCount === 0 || frame.time - previousTime > 0.15 + 1e-6) evidence.phraseCount++;
    previousTime = frame.time;
  }
  const levels = voiced.map(frame => frame.rms).sort((a, b) => a - b);
  const quiet = levels[Math.floor((levels.length - 1) * 0.1)];
  const loud = levels[Math.floor((levels.length - 1) * 0.9)];
  evidence.dynamicRangeDb = 20 * Math.log10(loud / quiet);
  evidence.status = "described";
  evidence.qualityFlags.push("acoustic_observation_requires_listening");
  return {
    evidence,
    comment: `本次可分析发声约 ${evidence.voicedSeconds.toFixed(1)} 秒，检测到 ${evidence.phraseCount} 段发声，录音音量起伏约 ${evidence.dynamicRangeDb.toFixed(1)} 分贝。`
      + "请结合歌曲情绪复听，尝试在一句中安排渐强或渐弱，再听听表达效果。",
  };
}
