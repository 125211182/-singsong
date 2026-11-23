const OCTAVE_SEMITONES = 12;
export const SINGING_PRACTICE_OCTAVE_SHIFTS = [-OCTAVE_SEMITONES, 0, OCTAVE_SEMITONES] as const;
export const SINGING_PRACTICE_TOLERANCE = 0.6;

/** Signed distance to the closest reference in the same or either adjacent octave. */
export function singingPracticePitchDifference(singingMidi: number, referenceMidi: number): number {
  const difference = singingMidi - referenceMidi;
  if (Math.abs(difference) <= OCTAVE_SEMITONES / 2) return difference;
  return difference - Math.sign(difference) * OCTAVE_SEMITONES;
}
