/**
 * Recorded-audio diagnostics, not a validated attainment scale.
 * The same fixed windows are used for both signals; UI/RAF timing never enters a score.
 * Reference and accompaniment must have the same timeline. One global vocal-register offset is recorded separately.
 */
import { aggregateSteadyPitch, type SteadyPitchAggregation } from './singing-steady-pitch';
import { analyzeExpressionMatch, type ExpressionMatchEvidence } from "./singing-expression-match";
import { analyzeRhythmFeedback, describeSingingExpression, type RhythmEvidence, type ExpressionEvidence } from "./singing-temporal-feedback";

export const SINGING_DIAGNOSTIC_VERSION = "v3.7-feedback" as const;
export const PITCH_HOP_SECONDS = 0.05;
export const PITCH_WINDOW_SECONDS = 0.05;
export function isSingingDiagnosticVersion(version: unknown): boolean {
  return version === "v3.0-diagnostic" || version === "v3.1-diagnostic" || version === "v3.2-feedback" || version === "v3.3-feedback" || version === "v3.4-feedback" || version === "v3.5-feedback" || version === "v3.6-feedback" || version === SINGING_DIAGNOSTIC_VERSION;
}
export interface AudioSignal { samples: Float32Array; sampleRate: number }
export interface PitchFrame { time: number; midi: number | null; rms: number; clipped: boolean; ambiguous?: boolean; candidateMidi?: number }
export interface SingingPitchPair { referenceMidi: number; singingMidi: number }
export interface SingingOctaveCalibration {
  status: "calibrated" | "pending";
  shiftSemitones: -12 | 0 | 12 | null;
  sampleCount: number;
  supportRatio: number | null;
}
export interface SingingOctaveEvidence extends SingingOctaveCalibration {
  rawMedianAbsErrorCents: number | null;
  localOctaveDeviationRatio: number | null;
}
export const OCTAVE_CALIBRATION_SAMPLES = 40;

/** The earliest consistent window fixes one register; a poor opening may recover. */
export function inferSingingOctave(pairs: readonly SingingPitchPair[]): SingingOctaveCalibration {
  const pending: SingingOctaveCalibration = { status: "pending", shiftSemitones: null, sampleCount: Math.min(pairs.length, OCTAVE_CALIBRATION_SAMPLES), supportRatio: null };
  for (let start = 0; start + OCTAVE_CALIBRATION_SAMPLES <= pairs.length; start++) {
    const differences = pairs.slice(start, start + OCTAVE_CALIBRATION_SAMPLES)
      .map(pair => pair.singingMidi - pair.referenceMidi).sort((a, b) => a - b);
    const shift = Math.round(differences[Math.floor(differences.length / 2)] / 12) * 12;
    if (shift !== -12 && shift !== 0 && shift !== 12) continue;
    const supportRatio = differences.filter(value => Math.abs(value - shift) <= 3).length / differences.length;
    if (start === 0) pending.supportRatio = supportRatio;
    if (supportRatio >= 0.8) return { status: "calibrated", shiftSemitones: shift, sampleCount: differences.length, supportRatio };
  }
  return pending;
}
export interface SingingEvidence extends Omit<Partial<SteadyPitchAggregation>, "pitch" | "steadyAggregationApplied"> {
  hopSeconds: number;
  recordingSeconds: number;
  referenceVoicedSeconds: number;
  pairedVoicedSeconds: number;
  voicedCoverage: number;
  within50CentsRatio: number | null;
  medianAbsErrorCents: number | null;
  recordingLeadSeconds: number;
  qualityFlags: string[];
  /** Conditional accuracy at the stored tolerance is separate from full-reference coverage. */
  withinToleranceAmongPairedRatio?: number | null;
  signalActivityCoverage?: number;
  toleranceCents?: number;
  zeroCreditCents?: number;
  scoreScope?: "measured_segments" | "whole_reference";
}
export interface SingingDiagnosticResult {
  total: null; pitch: number | null; rhythm: number | null; emotion: number | null;
  scoringVersion: typeof SINGING_DIAGNOSTIC_VERSION;
  evaluationStatus: "diagnostic_only" | "insufficient_evidence";
  comments: { pitch: string; rhythm: string; emotion: string };
  phraseScores: [];
  diagnosticEvidence: SingingEvidence;
  octaveEvidence: SingingOctaveEvidence;
  rhythmEvidence?: RhythmEvidence;
  expressionEvidence?: ExpressionEvidence;
  expressionMatchEvidence?: ExpressionMatchEvidence;
  captureSettings?: { echoCancellation?: boolean; noiseSuppression?: boolean; autoGainControl?: boolean; channelCount?: number; sampleRate?: number };
  attemptId?: string;
  recordedAt?: string;
  completedAt?: string;
  audioSha256?: string;
  recordingMimeType?: string;
}

function interpolatePeriod(differences: Float64Array, lag: number) {
  const before = differences[lag - 1];
  const middle = differences[lag];
  const after = differences[lag + 1];
  const curvature = before - 2 * middle + after;
  const offset = curvature > 0 ? Math.max(-0.5, Math.min(0.5, (before - after) / (2 * curvature))) : 0;
  return { period: lag + offset, error: middle + (after - before) * offset / 4 };
}

function harmonicPower(samples: Float32Array, period: number, harmonic: number): number {
  const step = 2 * Math.PI * harmonic / period;
  let real = 0, imaginary = 0;
  for (let i = 0; i < samples.length; i++) {
    const weighted = samples[i] * (1 - Math.cos(2 * Math.PI * i / (samples.length - 1)));
    real += weighted * Math.cos(step * i);
    imaginary += weighted * Math.sin(step * i);
  }
  return real * real + imaginary * imaginary;
}

// Estimate the period from the waveform before comparing it with any reference.
export function detectPitch(samples: Float32Array, sampleRate: number): Omit<PitchFrame, "time"> {
  let sum = 0, mean = 0, clips = 0;
  for (const value of samples) { sum += value * value; mean += value; if (Math.abs(value) >= 0.98) clips++; }
  const rms = Math.sqrt(sum / Math.max(1, samples.length));
  const clipped = clips / Math.max(1, samples.length) > 0.02;
  if (!Number.isFinite(sampleRate) || sampleRate < 4000 || rms < 0.01 || samples.length < 64) return { midi: null, rms, clipped };
  mean /= samples.length;
  // Average downsampling bounds the work per window and reduces high-frequency content.
  // Use the same 8 kHz analysis grid on every device. Integer stride
  // previously yielded 8.82 kHz at44.1k and8k at48k, changing ambiguity gates.
  // Area averaging retains the existing anti-aliasing behaviour without
  // selecting notes or resampling either timeline to fit a performance.
  const rate = 8000;
  const sourceStep = sampleRate / rate;
  const data = new Float32Array(Math.floor(samples.length / sourceStep));
  for (let i = 0; i < data.length; i++) {
    const start = i * sourceStep, end = (i + 1) * sourceStep;
    let value = 0;
    for (let j = Math.floor(start); j < Math.ceil(end); j++) {
      const weight = Math.max(0, Math.min(end, j + 1) - Math.max(start, j));
      value += (samples[j] - mean) * weight;
    }
    data[i] = value / sourceStep;
  }
  const minLag = Math.max(2, Math.floor(rate / 1000));
  const maxLag = Math.min(Math.ceil(rate / 70) + 1, Math.floor(data.length / 2));
  const size = data.length - maxLag;
  const differences = new Float64Array(maxLag + 1);
  let cumulative = 0;
  for (let lag = 1; lag <= maxLag; lag++) {
    let difference = 0;
    for (let i = 0; i < size; i++) difference += (data[i] - data[i + lag]) ** 2;
    cumulative += difference;
    differences[lag] = cumulative > 0 ? difference * lag / cumulative : 1;
  }
  for (let lag = minLag; lag < maxLag; lag++) {
    if (differences[lag] >= 0.15) continue;
    while (lag + 1 <= maxLag && differences[lag + 1] < differences[lag]) lag++;
    if (lag === maxLag) break;
    const selected = interpolatePeriod(differences, lag);
    const frequency = rate / selected.period;
    // This waveform-selected position is not a confirmed vocal F0 in a mixture.
    const candidateMidi = frequency >= 70 && frequency <= 1000 ? 69 + 12 * Math.log2(frequency / 440) : undefined;
    const doubled = selected.period * 2;
    const lowerLag = Math.max(lag + 1, Math.floor(doubled * 0.96));
    const upperLag = Math.min(maxLag - 1, Math.ceil(doubled * 1.04));
    for (let candidate = lowerLag; candidate <= upperLag; candidate++) {
      if (differences[candidate] > differences[candidate - 1] || differences[candidate] > differences[candidate + 1]) continue;
      const lower = interpolatePeriod(differences, candidate);
      const improvement = selected.error - lower.error;
      if (Math.abs(lower.period - doubled) > doubled * 0.04
        || rate / lower.period < 70
        || improvement < 0.003
        || lower.error > selected.error * 0.55) continue;
      // A slight gain can also come from vibrato on a true high note.
      // For weak candidates, look for odd harmonics unique to the longer period.
      if (improvement < 0.02) {
        const odd = harmonicPower(data, lower.period, 1) + harmonicPower(data, lower.period, 3);
        if (odd < 0.0025 * harmonicPower(data, lower.period, 2)) continue;
      }
      // A weak fundamental and a high voice plus low accompaniment can
      // produce the same waveform. Preserve uncertainty instead of choosing an octave.
      return { midi: null, rms, clipped, ambiguous: true, candidateMidi };
    }
    // The first accepted period may itself be the low source in a mixture.
    // A dominant second harmonic with little first/third energy remains ambiguous.
    const firstPower = harmonicPower(data, selected.period, 1);
    const secondPower = harmonicPower(data, selected.period, 2);
    const thirdPower = harmonicPower(data, selected.period, 3);
    if (secondPower > 4 * (firstPower + thirdPower)) {
      return { midi: null, rms, clipped, ambiguous: true, candidateMidi };
    }
    return { midi: candidateMidi ?? null, rms, clipped };
  }
  return { midi: null, rms, clipped };
}

export function extractPitchTrack(signal: AudioSignal): PitchFrame[] {
  if (!Number.isFinite(signal.sampleRate) || signal.sampleRate < 4000) return [];
  const duration = signal.samples.length / signal.sampleRate;
  const windowSamples = Math.round(signal.sampleRate * PITCH_WINDOW_SECONDS);
  const halfWindow = Math.floor(windowSamples / 2);
  const frames: PitchFrame[] = [];
  for (let index = 0; index < Math.floor(duration / PITCH_HOP_SECONDS); index++) {
    const time = (index + 0.5) * PITCH_HOP_SECONDS;
    const center = Math.round(time * signal.sampleRate);
    const start = Math.max(0, center - halfWindow);
    const window = signal.samples.subarray(start, start + windowSamples);
    frames.push({ time, ...detectPitch(window, signal.sampleRate) });
  }
  return frames;
}

const pitchEvidenceReasons: Record<string, string> = {
  track_timing_invalid: "录音或范唱时间信息异常，请先试听并重新打开题目。",
  reference_missing: "未能读取这道题的范唱，请联系老师检查题目音频。",
  recording_decode_failed: "这次录音暂时无法读取音高。请先试听录音，再决定是否重唱。",
  recording_analysis_failed: "音高分析未完成。可以试听并提交录音，由老师听评。",
  recording_too_short: "录音时间过短，暂时无法给出音高参考。",
  reference_pitch_insufficient: "范唱中可识别的音高片段太少，请联系老师检查范唱。",
  recording_pitch_insufficient: "录音中可识别的音高片段太少，请先试听并检查麦克风。",
  octave_calibration_pending: "正在核对演唱音区，请结合录音复听起始乐句。",
  octave_candidates_ambiguous: "部分声音含有难以区分的高低音，请减小伴奏外放音量或使用耳机后再唱。",
  paired_coverage_insufficient: "录音与范唱中可同时比较的音高片段太少，请复听起唱和伴奏。",
};

export function insufficientSingingEvidence(reason: string): SingingDiagnosticResult {
  return {
    total: null, pitch: null, rhythm: null, emotion: null,
    scoringVersion: SINGING_DIAGNOSTIC_VERSION, evaluationStatus: "insufficient_evidence",
    phraseScores: [],
    octaveEvidence: { status: "pending", shiftSemitones: null, sampleCount: 0, supportRatio: null, rawMedianAbsErrorCents: null, localOctaveDeviationRatio: null },
    comments: { pitch: pitchEvidenceReasons[reason] ?? "请教师结合录音复核音高。", rhythm: "节奏由教师按四级标准听评。", emotion: "情绪表现由教师按四级标准听评。" },
    diagnosticEvidence: { hopSeconds: PITCH_HOP_SECONDS, recordingSeconds: 0, referenceVoicedSeconds: 0, pairedVoicedSeconds: 0, voicedCoverage: 0, within50CentsRatio: null, medianAbsErrorCents: null, recordingLeadSeconds: 0, qualityFlags: [reason, "scale_not_validated", "aligned_reference_required"] },
  };
}

function reliablePitch(frame: PitchFrame | undefined): frame is PitchFrame & { midi: number } {
  return !!frame && frame.midi !== null && Number.isFinite(frame.midi)
    && !frame.clipped && !frame.ambiguous;
}

/** Pitch tolerance is evaluated on reliable measurements, not missed microphone observations. */
export function analyzeSingingPitchTracks(
  reference: readonly PitchFrame[], recording: readonly PitchFrame[], recordingLeadSeconds = 0,
  recordingSeconds = recording.length ? recording[recording.length - 1].time + PITCH_HOP_SECONDS / 2 : 0,
): { pitch: number | null; comment: string; evidence: SingingEvidence; octaveEvidence: SingingOctaveEvidence } {
  const lead = Number.isFinite(recordingLeadSeconds) ? Math.max(0, recordingLeadSeconds) : 0;
  const validTimeline = (track: readonly PitchFrame[]) => track.every((frame, index) =>
    Number.isFinite(frame.time) && frame.time >= 0 && Number.isFinite(frame.rms) && frame.rms >= 0
    && (frame.midi === null || Number.isFinite(frame.midi))
    && (index === 0 || frame.time > track[index - 1].time));
  const timelineValid = validTimeline(reference) && validTimeline(recording) && Number.isFinite(recordingSeconds);
  const target = reference.filter(reliablePitch);
  const referenceAt = new Map(reference.map(frame => [Math.floor(frame.time / PITCH_HOP_SECONDS), frame]));
  const recordingAt = new Map(recording.map(frame => [Math.floor(frame.time / PITCH_HOP_SECONDS), frame]));
  const initialPairs: SingingPitchPair[] = [];
  for (const frame of target) {
    const other = recordingAt.get(Math.floor((frame.time + lead + 1e-8) / PITCH_HOP_SECONDS));
    if (reliablePitch(other)) initialPairs.push({ referenceMidi: frame.midi, singingMidi: other.midi });
  }
  const calibration = inferSingingOctave(timelineValid ? initialPairs : []);
  const shift = calibration.shiftSemitones ?? 0;
  const pairs: (SingingPitchPair & { referenceTime: number })[] = [];
  let activeTargetFrames = 0;
  for (const frame of target) {
    const slot = Math.floor((frame.time + lead + 1e-8) / PITCH_HOP_SECONDS);
    const raw = recordingAt.get(slot);
    if (raw && Number.isFinite(raw.rms) && raw.rms >= 0.01 && !raw.clipped) activeTargetFrames++;
    const refSlot = Math.floor(frame.time / PITCH_HOP_SECONDS);
    const nearTransition = [-2, -1, 1, 2].some(offset => {
      const adjacent = referenceAt.get(refSlot + offset);
      return reliablePitch(adjacent) && Math.abs(adjacent.midi - frame.midi) > 0.5;
    });
    let other = raw;
    const isAdjacentReferenceTone = reliablePitch(raw) && [-2, -1, 1, 2].some(offset => {
      const adjacent = referenceAt.get(refSlot + offset);
      return reliablePitch(adjacent) && Math.abs(raw.midi - shift - adjacent.midi) <= 0.5;
    });
    if (nearTransition && reliablePitch(raw) && isAdjacentReferenceTone && Math.abs(raw.midi - shift - frame.midi) <= 6) {
      // Only the 100 ms transition neighbourhood may absorb a natural change of note.
      const candidates = [-2, -1, 0, 1, 2].map(offset => recordingAt.get(slot + offset)).filter(reliablePitch);
      const matched = candidates.find(candidate => Math.abs(candidate.midi - shift - frame.midi) <= 0.5 + 1e-9);
      if (matched) other = matched;
    }
    if (reliablePitch(other)) pairs.push({ referenceMidi: frame.midi, singingMidi: other.midi, referenceTime: frame.time });
  }
  const rawErrors = pairs.map(pair => Math.abs(pair.singingMidi - pair.referenceMidi) * 100).sort((a, b) => a - b);
  const errors: number[] = [];
  const toleranceCents = 60, zeroCreditCents = 200;
  let credit = 0, within50 = 0, withinTolerance = 0, octaveDeviations = 0;
  for (const pair of pairs) {
    const difference = pair.singingMidi - pair.referenceMidi - shift;
    const cents = Math.abs(difference) * 100;
    errors.push(cents);
    if (cents <= 50 + 1e-7) within50++;
    if (cents <= toleranceCents + 1e-7) withinTolerance++;
    if (Math.abs(Math.abs(difference) - 12) <= 3) octaveDeviations++;
    credit += cents <= toleranceCents + 1e-7 ? 1 : Math.max(0, 1 - (cents - toleranceCents) / (zeroCreditCents - toleranceCents));
  }
  const rawFramePitch = pairs.length ? credit / pairs.length * 100 : null;
  const aggregation = aggregateSteadyPitch(reference, pairs.map(pair => ({ referenceTime: pair.referenceTime,
    differenceSemitones: pair.singingMidi - pair.referenceMidi - shift })), rawFramePitch);
  const { pitch: aggregatedPitch, steadyAggregationApplied, ...aggregationEvidence } = aggregation;
  errors.sort((a, b) => a - b);
  const coverage = target.length ? pairs.length / target.length : 0;
  const flags = new Set(["scale_not_validated", "aligned_reference_required"]);
  if (!steadyAggregationApplied) flags.add("steady_pitch_fallback_insufficient_scope");
  if (!timelineValid) flags.add("track_timing_invalid");
  if (recordingSeconds < 2) flags.add("recording_too_short");
  if (target.length < 40) flags.add("reference_pitch_insufficient");
  if (recording.filter(reliablePitch).length < 20) flags.add("recording_pitch_insufficient");
  if (pairs.length < 20 || coverage < 0.25) flags.add("paired_coverage_insufficient");
  if (recording.some(frame => frame.clipped)) flags.add("recording_clipped");
  if (recording.some(frame => frame.ambiguous)) flags.add("octave_candidates_ambiguous");
  if (calibration.status === "pending") flags.add("octave_calibration_pending");
  if (octaveDeviations > 0) flags.add("local_octave_deviation");
  const scoreScope = coverage >= 0.95 ? "whole_reference" : "measured_segments";
  if (scoreScope === "measured_segments") flags.add("pitch_measurable_segments_only");
  const evidence: SingingEvidence = {
    ...aggregationEvidence,
    hopSeconds: PITCH_HOP_SECONDS, recordingSeconds,
    referenceVoicedSeconds: target.length * PITCH_HOP_SECONDS, pairedVoicedSeconds: pairs.length * PITCH_HOP_SECONDS,
    voicedCoverage: coverage, within50CentsRatio: pairs.length ? within50 / target.length : null,
    withinToleranceAmongPairedRatio: pairs.length ? withinTolerance / pairs.length : null,
    signalActivityCoverage: target.length ? activeTargetFrames / target.length : 0,
    toleranceCents, zeroCreditCents, scoreScope,
    medianAbsErrorCents: errors.length ? errors[Math.floor(errors.length / 2)] : null,
    recordingLeadSeconds: lead, qualityFlags: [...flags],
  };
  const octaveEvidence: SingingOctaveEvidence = { ...calibration,
    rawMedianAbsErrorCents: rawErrors.length ? rawErrors[Math.floor(rawErrors.length / 2)] : null,
    localOctaveDeviationRatio: pairs.length ? octaveDeviations / pairs.length : null,
  };
  const failure = [...flags].find(flag => flag !== "octave_candidates_ambiguous" && Object.hasOwn(pitchEvidenceReasons, flag));
  return {
    pitch: failure ? null : aggregatedPitch === null ? null : Math.round(aggregatedPitch * 10) / 10,
    evidence, octaveEvidence,
    comment: failure ? pitchEvidenceReasons[failure]
      : `${!steadyAggregationApplied ? "连续稳态音段覆盖不足，本次沿用逐帧匹配参考。" : "本次主要比较连续稳态音段的中心音，并保留严重偏差和不稳定片段的限制。"}已核对演唱音区，音高可比覆盖 ${(coverage * 100).toFixed(0)}%。${scoreScope === "measured_segments" ? "本分数仅对可测片段计分，不代表已唱完整曲。" : "已覆盖整段参考的主要音高。"}可测片段中符合 ±${evidence.toleranceCents} 音分容差的比例为 ${(withinTolerance / pairs.length * 100).toFixed(0)}%，容差内给足片段分。${octaveDeviations > 0 ? "局部八度差异仍保留，请分句复听。" : "请结合录音练习易偏高或偏低的位置。"}`,
  };
}

export function analyzeSingingRecording(reference: AudioSignal, recording: AudioSignal, recordingLeadSeconds = 0): SingingDiagnosticResult {
  return analyzeSingingTracks(extractPitchTrack(reference), extractPitchTrack(recording),
    recording.samples.length / recording.sampleRate, recordingLeadSeconds);
}

export function analyzeSingingTracks(ref: PitchFrame[], student: PitchFrame[],
  recordingSeconds: number, recordingLeadSeconds = 0): SingingDiagnosticResult {
  const result = insufficientSingingEvidence("scale_not_validated");
  const lead = Number.isFinite(recordingLeadSeconds) ? Math.max(0, recordingLeadSeconds) : 0;
  const pitch = analyzeSingingPitchTracks(ref, student, lead, recordingSeconds);
  result.pitch = pitch.pitch;
  result.octaveEvidence = pitch.octaveEvidence;
  result.diagnosticEvidence = pitch.evidence;
  result.comments.pitch = pitch.comment;
  if (pitch.pitch !== null) result.evaluationStatus = "diagnostic_only";
  const rhythm = analyzeRhythmFeedback(ref, student, lead);
  result.rhythm = rhythm.rhythm;
  result.rhythmEvidence = rhythm.evidence;
  result.comments.rhythm = (rhythm.evidence.referenceObservableCoverage ?? 1) < 0.5
    && rhythm.evidence.qualityFlags.includes('rhythm_observation_insufficient')
    ? '干声范唱中可测的节奏片段不足，请核对干声是否清晰，以及是否与伴奏对齐。'
    : rhythm.comment;
  result.expressionEvidence = describeSingingExpression(student).evidence;
  const expression = analyzeExpressionMatch(ref, student, lead);
  result.emotion = expression.emotion;
  result.expressionMatchEvidence = expression.evidence;
  result.comments.emotion = expression.comment;
  return result;
}
