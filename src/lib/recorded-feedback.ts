import { analyzeSingingTracks, extractPitchTrack, PITCH_HOP_SECONDS, type AudioSignal, type PitchFrame } from './singing-evidence';
import { getLivePitchDisplay } from './singing-live-pitch';

const PHRASE_GAP_SECONDS = 0.45;
const MIN_PHRASE_SECONDS = 0.75;

function referencePhrases(reference: readonly PitchFrame[]) {
  const phrases: { startTime: number; endTime: number }[] = [];
  let start: number | undefined;
  let last: number | undefined;
  function closePhrase() {
    if (start === undefined || last === undefined || last - start < MIN_PHRASE_SECONDS) return;
    phrases.push({ startTime: Math.max(0, start - PITCH_HOP_SECONDS / 2), endTime: last + PITCH_HOP_SECONDS / 2 });
  }
  for (const frame of reference) {
    if (frame.midi === null || frame.ambiguous || frame.clipped) continue;
    if (last === undefined || frame.time - last >= PHRASE_GAP_SECONDS) {
      closePhrase();
      start = frame.time;
    }
    last = frame.time;
  }
  closePhrase();
  return phrases;
}

export function analyzeRecordedFeedback(reference: PitchFrame[], signal: AudioSignal, lead: number) {
  const recording = extractPitchTrack(signal);
  const duration = signal.samples.length / signal.sampleRate;
  const result = analyzeSingingTracks(reference, recording, duration, lead);
  const phraseScores = referencePhrases(reference).map(({ startTime, endTime }, index) => {
    const interval = (track: readonly PitchFrame[], start: number, end: number) =>
      track.filter(frame => frame.time >= start && frame.time < end);
    // Keep the original time axes and require each phrase to pass the same evidence gates.
    const phrase = analyzeSingingTracks(interval(reference, startTime, endTime),
      interval(recording, startTime + lead, endTime + lead), Math.max(0, Math.min(duration - lead, endTime) - startTime), lead);
    // A local octave switch cannot count as a successful new register calibration.
    const consistentRegister = result.octaveEvidence.status === 'calibrated'
      && phrase.octaveEvidence.shiftSemitones === result.octaveEvidence.shiftSemitones;
    return { id: index + 1, startTime, endTime, pitch: consistentRegister ? phrase.pitch : null,
      rhythm: phrase.rhythm, emotion: phrase.emotion };
  });

  const sampleData = recording.filter(frame => frame.time >= lead).map(frame => {
    const time = frame.time - lead;
    const target = reference[Math.floor((time + 1e-8) / PITCH_HOP_SECONDS)];
    const { marker } = getLivePitchDisplay(frame, result.octaveEvidence, target);
    const midi = marker && !frame.ambiguous ? marker.midi : undefined;
    return { time, volume: frame.rms, midi, hasPitch: midi !== undefined,
      tone: marker?.tone, isHit: marker?.tone === 'hit', pitchDiff: marker?.difference == null ? undefined : Math.abs(marker.difference) };
  });
  return { result, phraseScores, sampleData };
}

export function buildRecordedFeedback(reference: PitchFrame[], recording: AudioBuffer, lead: number) {
  return analyzeRecordedFeedback(reference, { samples: recording.getChannelData(0), sampleRate: recording.sampleRate }, lead);
}
