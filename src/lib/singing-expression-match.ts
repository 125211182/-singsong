import type { PitchFrame } from "./singing-evidence";

const WINDOW_SECONDS = 1;
const VOICE_ANCHOR_RADIUS_SECONDS = 0.25;
const ERROR_TOLERANCE_DB = 6;
// Practice rubric, not an empirically validated perceptual/emotional scale.
const FULL_CREDIT_DB = 2.5;
const FULL_DIRECTION_CORRELATION = 0.7;
const MIN_DYNAMIC_SCALE = 0.25;
const MAX_DYNAMIC_SCALE = 1.5;
const DYNAMIC_RANGE_ALLOWANCE_DB = 2 * FULL_CREDIT_DB;

export interface ExpressionMatchEvidence {
  status: "measured" | "insufficient_evidence";
  basis: "relative_loudness_contour";
  windowSeconds: number;
  errorToleranceDb: number;
  referenceWindowCount: number;
  recordingWindowCount: number;
  pairedWindowCount: number;
  pairedCoverage: number | null;
  referenceDynamicRangeDb: number | null;
  pairedReferenceDynamicRangeDb: number | null;
  recordingDynamicRangeDb: number | null;
  contourCorrelation: number | null;
  medianContourErrorDb: number | null;
  qualityFlags: string[];
  scoreScope?: "measured_segments" | "whole_reference";
  fullCreditToleranceDb?: number;
  directionFullCreditCorrelation?: number;
  recordingClearVoiceFraction?: number | null;
  recordingClippedFraction?: number | null;
  comparisonAlgorithm?: "reference_trend_shape_v2";
  contourSmoothingSeconds?: 1 | 3;
  phraseTrendCorrelation?: number;
  phraseTrendErrorDb?: number;
  phraseReferenceDynamicRangeDb?: number;
  phraseRecordingDynamicRangeDb?: number;
  relativeDynamicRangeRatio?: number;
  appliedDynamicScale?: number;
  dynamicScaleMin?: number;
  dynamicScaleMax?: number;
  dynamicRangeAllowanceDb?: number;
  levelMatchCredit?: number;
  directionMatchCredit?: number;
  contrastMatchCredit?: number;
  recordingContrastFloorDb?: number;
  contrastEvidenceCredit?: number;
  upperContrastCredit?: number;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function dynamicRange(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) * 0.9)] - sorted[Math.floor((sorted.length - 1) * 0.1)];
}

function valid(track: PitchFrame[]): boolean {
  return track.every((frame, index) => Number.isFinite(frame.time) && frame.time >= 0
    && Number.isFinite(frame.rms) && frame.rms >= 0
    && Number.isFinite(frame.rms ** 2) && (frame.rms === 0 || frame.rms ** 2 > 0)
    && (frame.midi === null || Number.isFinite(frame.midi))
    && (index === 0 || frame.time > track[index - 1].time));
}

function variance(values: number[]): number {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
}

function correlation(target: number[], actual: number[]): number {
  const targetMean = target.reduce((sum, value) => sum + value, 0) / target.length;
  const actualMean = actual.reduce((sum, value) => sum + value, 0) / actual.length;
  let covariance = 0, targetVariance = 0, actualVariance = 0;
  for (let index = 0; index < target.length; index++) {
    const x = target[index] - targetMean, y = actual[index] - actualMean;
    covariance += x * y; targetVariance += x * x; actualVariance += y * y;
  }
  return actualVariance / target.length < 0.0625 || targetVariance === 0 ? 0
    : Math.max(-1, Math.min(1, covariance / Math.sqrt(targetVariance * actualVariance)));
}

type EnergyPair = { index: number; target: number; actual: number };
/** Both tracks use identical paired neighbours; a missing second is a hard boundary. */
function smoothPairedEnergy(pairs: EnergyPair[]): EnergyPair[] {
  const byIndex = new Map(pairs.map(pair => [pair.index, pair]));
  const meanEnergyDb = (values: number[]) => {
    const peak = Math.max(...values);
    return peak + 10 * Math.log10(values.reduce((sum, value) => sum + 10 ** ((value - peak) / 10), 0) / values.length);
  };
  return pairs.map(pair => {
    const neighbours = [byIndex.get(pair.index - 1), pair, byIndex.get(pair.index + 1)]
      .filter((value): value is EnergyPair => value !== undefined);
    return { index: pair.index, target: meanEnergyDb(neighbours.map(value => value.target)),
      actual: meanEnergyDb(neighbours.map(value => value.actual)) };
  });
}

function envelope(track: PitchFrame[], lead: number): Map<number, number> {
  const windows = new Map<number, number[]>();
  const anchors = track.filter(frame => frame.midi !== null && frame.rms > 0 && !frame.ambiguous && !frame.clipped);
  let anchorIndex = 0;
  for (const frame of track) {
    if ((frame.midi === null && !frame.ambiguous) || frame.rms <= 0 || frame.clipped) continue;
    // F0 ambiguity need not destroy amplitude, but only bridge a short interruption
    // beside a clear voice anchor. Never infer voice from unpitched noise.
    while (anchorIndex < anchors.length && anchors[anchorIndex].time < frame.time - VOICE_ANCHOR_RADIUS_SECONDS) anchorIndex++;
    if (frame.ambiguous && (anchorIndex >= anchors.length || anchors[anchorIndex].time > frame.time + VOICE_ANCHOR_RADIUS_SECONDS)) continue;
    const index = Math.floor((frame.time - lead + 1e-8) / WINDOW_SECONDS);
    if (index < 0) continue;
    const values = windows.get(index) ?? [];
    values.push(frame.rms ** 2);
    windows.set(index, values);
  }
  // At least 12 of 20 expected 50 ms samples support each one-second energy window.
  return new Map([...windows].filter(([, values]) => values.length >= 12).map(([key, values]) => {
    const peak = Math.max(...values);
    const relativeMean = values.reduce((sum, energy) => sum + energy / peak, 0) / values.length;
    return [key, 10 * Math.log10(peak) + 10 * Math.log10(relativeMean)];
  }));
}

/** A transparent practice index for reference-relative dynamics, not emotion recognition. */
export function analyzeExpressionMatch(reference: PitchFrame[], recording: PitchFrame[], recordingLeadSeconds: number) {
  const evidence: ExpressionMatchEvidence = {
    status: "insufficient_evidence", basis: "relative_loudness_contour",
    windowSeconds: WINDOW_SECONDS, errorToleranceDb: ERROR_TOLERANCE_DB,
    referenceWindowCount: 0, recordingWindowCount: 0, pairedWindowCount: 0,
    pairedCoverage: null, referenceDynamicRangeDb: null, pairedReferenceDynamicRangeDb: null, recordingDynamicRangeDb: null,
    contourCorrelation: null, medianContourErrorDb: null,
    fullCreditToleranceDb: FULL_CREDIT_DB, directionFullCreditCorrelation: FULL_DIRECTION_CORRELATION,
    comparisonAlgorithm: "reference_trend_shape_v2", dynamicScaleMin: MIN_DYNAMIC_SCALE,
    dynamicScaleMax: MAX_DYNAMIC_SCALE, dynamicRangeAllowanceDb: DYNAMIC_RANGE_ALLOWANCE_DB,
    recordingContrastFloorDb: 1,
    qualityFlags: ["reference_dynamics_proxy_not_emotional_understanding", "expression_shape_not_absolute_intensity"],
  };
  const insufficient = (flag: string, comment: string) => {
    evidence.qualityFlags.push(flag);
    return { emotion: null as number | null, comment, evidence };
  };
  if (!valid(reference) || !valid(recording)) return insufficient("expression_track_invalid", "声音分析数据不完整，请先试听录音，再完整演唱一个乐句。");
  const voiceQuality = (track: PitchFrame[]) => {
    // Quiet room tone must not dilute damaged active audio. Include damage and
    // detector ambiguity even when pitch is null or amplitude is below the gate.
    const active = track.filter(frame => frame.rms >= 0.01 || frame.ambiguous || frame.clipped);
    return {
      clear: active.length ? active.filter(frame => frame.midi !== null && !frame.ambiguous && !frame.clipped).length / active.length : 0,
      clipped: active.length ? active.filter(frame => frame.clipped).length / active.length : 0,
    };
  };
  const refQuality = voiceQuality(reference), recQuality = voiceQuality(recording);
  evidence.recordingClearVoiceFraction = recQuality.clear;
  evidence.recordingClippedFraction = recQuality.clipped;
  // A quarter of clear anchors supports short ambiguity bridges; majority damage
  // or near-total ambiguity cannot support a confident dynamics comparison.
  if (refQuality.clipped > 0.5 || recQuality.clipped > 0.5) {
    return insufficient("expression_clipped", "范唱或录音多数人声片段过载，强弱处理暂无法可靠比较，请降低麦克风音量后再唱。");
  }
  if (refQuality.clear < 0.25 || recQuality.clear < 0.25) {
    return insufficient("expression_voice_anchors_insufficient", refQuality.clear < 0.25
      ? "干声范唱的清晰人声不足，暂无法比较强弱，请核对范唱与伴奏。"
      : "录音的清晰人声不足，暂无法比较强弱，请先回听录音并检查外放干扰。");
  }
  if (reference.some(frame => frame.clipped) || recording.some(frame => frame.clipped)) evidence.qualityFlags.push("expression_local_clipping_excluded");
  const lead = Number.isFinite(recordingLeadSeconds) ? Math.max(0, recordingLeadSeconds) : 0;
  const ref = envelope(reference, 0), rec = envelope(recording, lead);
  evidence.referenceWindowCount = ref.size;
  evidence.recordingWindowCount = rec.size;
  if (ref.size < 4 || rec.size < 4) return insufficient("expression_windows_insufficient", "可比较的完整声音片段不足，请跟伴奏完整演唱后再看情绪表现参考分。");
  evidence.referenceDynamicRangeDb = dynamicRange([...ref.values()]);
  evidence.recordingDynamicRangeDb = dynamicRange([...rec.values()]);
  if (evidence.referenceDynamicRangeDb < 3 - 1e-9) {
    return insufficient("reference_dynamics_insufficient", "范唱的强弱变化不足以建立比较依据，本次情绪表现请结合录音由教师复核。");
  }
  const pairs = [...ref].flatMap(([index, target]) => rec.has(index) ? [{ index, target, actual: rec.get(index)! }] : []);
  evidence.pairedWindowCount = pairs.length;
  evidence.pairedCoverage = pairs.length / ref.size;
  if (pairs.length < 4 || evidence.pairedCoverage < 0.25) {
    return insufficient("expression_pairs_insufficient", "人声与范唱可对应的强弱片段不足，请检查外放干扰并分句练习后再试。");
  }
  evidence.pairedReferenceDynamicRangeDb = dynamicRange(pairs.map(pair => pair.target));
  if (evidence.pairedReferenceDynamicRangeDb < 3 - 1e-9) {
    return insufficient("paired_reference_dynamics_insufficient", "已对应的范唱片段强弱变化不足，本次情绪表现请结合完整录音由教师复核。");
  }
  if (reference.some(frame => frame.ambiguous) || recording.some(frame => frame.ambiguous)) evidence.qualityFlags.push("expression_uncertain_segments");
  // Preserve the old raw statistics, independently of the new scoring protocol.
  const gainOffset = median(pairs.map(pair => pair.actual - pair.target));
  evidence.contourCorrelation = correlation(pairs.map(pair => pair.target), pairs.map(pair => pair.actual));
  evidence.medianContourErrorDb = median(pairs.map(pair => Math.abs(pair.actual - pair.target - gainOffset)));

  const smoothed = smoothPairedEnergy(pairs);
  const smoothedTargets = smoothed.map(pair => pair.target);
  // Reference information alone selects the scale. Never select the result that
  // best fits a recording, or erase a fast accurate reference by always smoothing.
  const useTrend = dynamicRange(smoothedTargets) >= evidence.pairedReferenceDynamicRangeDb * 0.5 - 1e-9
    && variance(smoothedTargets) >= 0.0625;
  const selected = useTrend ? smoothed : pairs;
  const targets = selected.map(pair => pair.target), actuals = selected.map(pair => pair.actual);
  const referenceRange = dynamicRange(targets), recordingRange = dynamicRange(actuals);
  if (!Number.isFinite(referenceRange) || referenceRange <= 0 || variance(targets) < 0.0625) {
    return insufficient("paired_reference_dynamics_insufficient", "已对应的范唱走势不足以可靠比较，请结合录音由教师复核。");
  }
  evidence.contourSmoothingSeconds = useTrend ? 3 : 1;
  evidence.phraseReferenceDynamicRangeDb = referenceRange;
  evidence.phraseRecordingDynamicRangeDb = recordingRange;
  const ratio = recordingRange / referenceRange;
  const scale = Math.max(MIN_DYNAMIC_SCALE, Math.min(MAX_DYNAMIC_SCALE, ratio));
  const targetCentre = median(targets), actualCentre = median(actuals);
  const errors = selected.map(pair => Math.abs((pair.actual - actualCentre) / scale - (pair.target - targetCentre)));
  const levelCredit = errors.reduce((sum, error) => sum
    + Math.max(0, Math.min(1, (ERROR_TOLERANCE_DB - error) / (ERROR_TOLERANCE_DB - FULL_CREDIT_DB))), 0) / errors.length;
  const trendCorrelation = correlation(targets, actuals);
  const directionCredit = Math.min(1, Math.max(0, trendCorrelation) / FULL_DIRECTION_CORRELATION);
  // Weak-reference dynamics can legitimately expand by a modest absolute amount.
  // Keep a separate lower/upper range cap so flat, tiny or extreme contours do
  // not become high merely through the bounded contrast normalization.
  const contrastCredit = recordingRange === 0 ? 0 : Math.min(1, ratio / (2 / 3),
    Math.max(MAX_DYNAMIC_SCALE * referenceRange, referenceRange + DYNAMIC_RANGE_ALLOWANCE_DB) / recordingRange);
  evidence.phraseTrendCorrelation = trendCorrelation;
  evidence.phraseTrendErrorDb = median(errors);
  evidence.relativeDynamicRangeRatio = ratio;
  evidence.appliedDynamicScale = scale;
  evidence.levelMatchCredit = levelCredit;
  evidence.directionMatchCredit = directionCredit;
  // Keep the historical amplitude-ratio diagnostic separate. Microphone
  // compression/range is not identified as artistic expression failure.
  evidence.contrastMatchCredit = contrastCredit;
  const contrastEvidenceCredit = Math.min(1, recordingRange / evidence.recordingContrastFloorDb!);
  const upperContrastCredit = recordingRange === 0 ? 0 : Math.min(1,
    Math.max(MAX_DYNAMIC_SCALE * referenceRange, referenceRange + DYNAMIC_RANGE_ALLOWANCE_DB) / recordingRange);
  evidence.contrastEvidenceCredit = contrastEvidenceCredit;
  evidence.upperContrastCredit = upperContrastCredit;
  evidence.status = "measured";
  const emotion = Math.round(1000 * Math.min(levelCredit, directionCredit, contrastEvidenceCredit, upperContrastCredit)) / 10;
  evidence.scoreScope = evidence.pairedCoverage >= 0.95 ? "whole_reference" : "measured_segments";
  if (evidence.scoreScope === "measured_segments") evidence.qualityFlags.push("expression_measurable_segments_only");
  const scope = evidence.scoreScope === "measured_segments" ? "仅可测片段的范唱强弱处理匹配参考" : "范唱强弱处理匹配参考";
  const practice = emotion >= 75 ? "继续保持乐句强弱的方向，结合歌词复听表达效果。"
    : "请复听范唱的渐强、渐弱位置，再跟唱并比较自己的强弱处理。";
  const short = pairs.length <= 12;
  if (short) evidence.qualityFlags.push("expression_short_trend_reference_only");
  return { emotion, evidence, comment: `${scope}（约${evidence.contourSmoothingSeconds}秒强弱走势）：与范唱可对应的片段覆盖 ${(evidence.pairedCoverage * 100).toFixed(0)}%，适度幅度校正后的典型差异约 ${evidence.phraseTrendErrorDb.toFixed(1)} 分贝。${practice}${short ? "片段较短，请结合教师试听复核。" : ""}此项只反映强弱走势匹配，音量幅度比例单独记录，不代表对内心情绪的识别。` };
}
