/* ---------------------------------------------------------------------------
 * Clicking a title segment plays its notes, spelling out the melody of Britney
 * Spear's "... me baby one more time".
 *
 * Each segment's `data-notes` is a comma-separated list of chords, where each
 * chord is one or more note names joined by "+" (a dyad is played together).
 *
 * If all six segments are clicked within a short window, the whole melody is
 * played back with proper timing (4/4 at 93 BPM).
 * ------------------------------------------------------------------------- */

const NOTE_FREQUENCIES: Record<string, number> = {
    G3: 196.0,
    'G#3': 207.65,
    C4: 261.63,
    G4: 392.0,
    'G#4': 415.3,
};

const BPM = 93;
const BEAT_SECONDS = 60 / BPM;
const SYLLABLE_SECONDS = 0.32;
const SCHEDULE_LOOKAHEAD = 0.015;
const COMBO_WINDOW_MS = 3000;

const MELODY: Array<{ notes: string[]; beats: number }> = [
    { notes: ['C4', 'G4'], beats: 0.5 },
    { notes: ['C4', 'G#4'], beats: 0.5 },
    { notes: ['C4', 'G4'], beats: 0.5 },
    { notes: ['C4', 'G#4'], beats: 0.5 },
    { notes: ['G3', 'G4'], beats: 0.5 },
    { notes: ['G#3', 'G#4'], beats: 0.5 },
    { notes: ['G3', 'G4'], beats: 1 },
];

let audioContext: AudioContext | null = null;

/** Get or create the shared AudioContext. */
function getAudioContext(): AudioContext {
    if (!audioContext) {
        audioContext = new AudioContext({ latencyHint: 'interactive' });
    }
    return audioContext;
}

/**
 * Ensure the AudioContext is running before scheduling notes.
 * If it was suspended, wait for `resume()` so `currentTime` is accurate
 * and the first note's attack isn't clipped during hardware wake-up.
 */
async function ensureRunningContext(): Promise<AudioContext> {
    const ctx = getAudioContext();
    if (ctx.state === 'suspended') {
        await ctx.resume();
    }
    return ctx;
}

/** Pre-warm the AudioContext on the very first user gesture anywhere on the page. */
function installAudioPrewarmer(segments: HTMLElement[]): void {
    const warmUp = () => {
        const ctx = getAudioContext();
        if (ctx.state === 'suspended') {
            void ctx.resume();
        }
    };

    // Unlock on the first pointerdown/keydown anywhere in the document
    window.addEventListener('pointerdown', warmUp, { capture: true, once: true, passive: true });
    window.addEventListener('keydown', warmUp, { capture: true, once: true, passive: true });

    // Also wake on pointerdown directly on segments (50-100ms before 'click' fires)
    segments.forEach((seg) => {
        seg.addEventListener('pointerdown', warmUp, { passive: true });
    });
}

/** Play a chord with a short plucked envelope on a running context. */
function playChord(ctx: AudioContext, frequencies: number[], startTime: number, duration: number): void {
    if (frequencies.length === 0) return;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, startTime);
    gain.gain.exponentialRampToValueAtTime(0.18, startTime + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);
    gain.connect(ctx.destination);

    const stopTime = startTime + duration + 0.05;

    frequencies.forEach((frequency, idx) => {
        const oscillator = ctx.createOscillator();
        oscillator.type = 'triangle';
        oscillator.frequency.setValueAtTime(frequency, startTime);
        oscillator.connect(gain);
        oscillator.start(startTime);
        oscillator.stop(stopTime);

        // Clean up the shared GainNode once the last oscillator finishes
        if (idx === 0) {
            oscillator.onended = () => gain.disconnect();
        }
    });
}

/** Parse a `data-notes` string into a list of chords (each a list of frequencies). */
function parseNotes(spec: string): number[][] {
    return spec
        .split(',')
        .map((chord) =>
            chord
                .split('+')
                .map((name) => NOTE_FREQUENCIES[name.trim()])
                .filter((f): f is number => typeof f === 'number'),
        )
        .filter((chord) => chord.length > 0);
}

/** Play a sequence of chords back-to-back (one per syllable). */
async function playSequence(chords: number[][]): Promise<void> {
    if (chords.length === 0) return;
    const ctx = await ensureRunningContext();
    let t = ctx.currentTime + SCHEDULE_LOOKAHEAD;
    chords.forEach((chord) => {
        playChord(ctx, chord, t, SYLLABLE_SECONDS);
        t += SYLLABLE_SECONDS;
    });
}

/** Play the whole melody with the song's timing (4/4 at 93 BPM). */
async function playMelody(): Promise<void> {
    const ctx = await ensureRunningContext();
    let t = ctx.currentTime + SCHEDULE_LOOKAHEAD;
    MELODY.forEach(({ notes, beats }) => {
        const frequencies = notes
            .map((name) => NOTE_FREQUENCIES[name])
            .filter((f): f is number => typeof f === 'number');
        const duration = beats * BEAT_SECONDS;
        playChord(ctx, frequencies, t, duration * 0.9);
        t += duration;
    });
}

/** Wire up the title segments so clicking them plays their notes. */
export function initTitleNotes(): void {
    const segments = Array.from(document.querySelectorAll<HTMLElement>('.title-segment'));
    if (segments.length === 0) return;

    installAudioPrewarmer(segments);

    /** Parse note specs once up front instead of on every click. */
    const parsedSpecs = segments.map((segment) => parseNotes(segment.dataset.notes ?? ''));

    /** Timestamps of the most recent click on each segment (by index). */
    const lastClicked = new Map<number, number>();
    let melodyTimer: number | null = null;

    segments.forEach((segment, index) => {
        segment.addEventListener('click', () => {
            const chords = parsedSpecs[index];
            if (!chords || chords.length === 0) return;

            // If the full melody was queued from a previous combo, cancel it
            if (melodyTimer !== null) {
                window.clearTimeout(melodyTimer);
                melodyTimer = null;
            }

            void playSequence(chords);

            const now = performance.now();
            lastClicked.set(index, now);

            for (const [i, time] of lastClicked) {
                if (now - time > COMBO_WINDOW_MS) lastClicked.delete(i);
            }

            if (lastClicked.size === segments.length) {
                lastClicked.clear();
                const sequenceDurationMs = chords.length * SYLLABLE_SECONDS * 1000;
                melodyTimer = window.setTimeout(() => {
                    melodyTimer = null;
                    void playMelody();
                }, sequenceDurationMs + 80);
            }
        });
    });
}