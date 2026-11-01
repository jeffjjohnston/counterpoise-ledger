/**
 * The optional two-note chord that plays when the transaction form saves.
 *
 * The setting is per user and per device, so it lives in localStorage. The
 * sound is generated with the Web Audio API, so no audio file ships.
 */

export const SAVE_CHORD_KEY = "counterpoise.saveChord.enabled";

// A perfect fifth: C5 and G5.
export const SAVE_CHORD_FREQUENCIES = [523.25, 783.99] as const;

// Seconds. The whole chord stays under 400 ms.
const ATTACK = 0.02;
const LENGTH = 0.35;
const PEAK_GAIN = 0.06;

export function readSaveChordEnabled(): boolean {
  try {
    return localStorage.getItem(SAVE_CHORD_KEY) === "true";
  } catch {
    return false;
  }
}

export function writeSaveChordEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(SAVE_CHORD_KEY, String(enabled));
  } catch {
    // The setting is a convenience. Saving works without it.
  }
}

type AudioContextConstructor = new () => AudioContext;

let context: AudioContext | null = null;

function audioContext(): AudioContext | null {
  if (context && context.state !== "closed") return context;
  const Ctor: AudioContextConstructor | undefined =
    typeof window === "undefined"
      ? undefined
      : (window.AudioContext ??
        (window as unknown as { webkitAudioContext?: AudioContextConstructor }).webkitAudioContext);
  if (!Ctor) return null;
  try {
    context = new Ctor();
  } catch {
    context = null;
  }
  return context;
}

/**
 * Call this inside the user gesture that starts a save. Browsers block audio
 * that a page starts on its own, so the AudioContext is made (or resumed)
 * here. The function it returns plays the chord; call it only after the
 * server confirms the save. It returns null when the setting is off or the
 * browser has no Web Audio.
 */
export function prepareSaveChord(): (() => void) | null {
  if (!readSaveChordEnabled()) return null;
  const ctx = audioContext();
  if (!ctx) return null;
  if (ctx.state === "suspended") void ctx.resume().catch(() => undefined);
  return () => playChord(ctx);
}

function playChord(ctx: AudioContext): void {
  try {
    const start = ctx.currentTime + 0.01;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(PEAK_GAIN, start + ATTACK);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + LENGTH);
    gain.connect(ctx.destination);
    for (const frequency of SAVE_CHORD_FREQUENCIES) {
      const oscillator = ctx.createOscillator();
      oscillator.type = "triangle";
      oscillator.frequency.value = frequency;
      oscillator.connect(gain);
      oscillator.start(start);
      oscillator.stop(start + LENGTH);
    }
  } catch {
    // A sound that cannot play must not disturb the save.
  }
}
