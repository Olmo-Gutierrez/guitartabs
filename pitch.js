export const midiToHz = (midi) => 440 * 2 ** ((midi - 69) / 12);

const PEAK_TOLERANCE_CENTS = 35;
// Un tono destaca sobre lo que tiene alrededor; un golpe o un chasquido suena en todas las frecuencias por igual.
const PROMINENCE_DB = 10;
const PROMINENCE_SEMITONES = 1.5;
const PROMINENCE_MIN_BINS = 5;
// Por debajo de esto el móvil apenas capta la fundamental: valen también sus armónicos.
const WEAK_FUNDAMENTAL_HZ = 110;
const ABOVE_NOISE_DB = 14;
const WITHIN_LOUDEST_DB = 36;
const MIN_DB = -90;
const HITS_TO_CONFIRM = 2;
const CHORD_SHARE = 0.75;

const ATTACK_WINDOW = 4096;
const ATTACK_RISE_DB = 3.5;
const ATTACK_HISTORY_TICKS = 6;
const ATTACK_MEMORY_TICKS = 8;
const ATTACK_SETTLE_TICKS = 2;
const TICK_SECONDS = 0.05;
// Tras enmudecer la nota de referencia, lo que siga sonando tan por encima de cuando empezó el paso es la guitarra.
const RINGING_RISE_DB = 9;

const HANN = Float32Array.from({ length: ATTACK_WINDOW }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / ATTACK_WINDOW));

// Energía en dB en una sola frecuencia (Goertzel) de la ventana corta que acaba `endOffset` muestras antes del final.
function bandDb(samples, sampleRate, hz, endOffset = 0) {
  const end = samples.length - endOffset;
  const start = Math.max(0, end - ATTACK_WINDOW);
  const coefficient = 2 * Math.cos((2 * Math.PI * hz) / sampleRate);
  let previous = 0;
  let beforePrevious = 0;
  for (let i = start; i < end; i++) {
    const current = samples[i] * HANN[i - start] + coefficient * previous - beforePrevious;
    beforePrevious = previous;
    previous = current;
  }
  const power = previous * previous + beforePrevious * beforePrevious - coefficient * previous * beforePrevious;
  return 10 * Math.log10(power + 1e-12);
}

// Busca un pico real cerca de `hz`. En graves un semitono ocupa poco más de un bin, así que interpola su posición.
function peakNear(spectrumDb, binHz, hz) {
  const center = hz / binHz;
  const last = spectrumDb.length - 2;
  if (center >= last) return { db: -Infinity, isPeak: false };
  const reach = 2 ** (PEAK_TOLERANCE_CENTS / 1200);
  const from = Math.max(1, Math.floor(center / reach) - 1);
  const to = Math.min(last, Math.ceil(center * reach) + 1);
  let best = null;
  for (let i = from; i <= to; i++) {
    const [a, b, c] = [spectrumDb[i - 1], spectrumDb[i], spectrumDb[i + 1]];
    if (b < a || b < c) continue;
    const denom = a - 2 * b + c;
    const peakBin = i + (denom ? (a - c) / (2 * denom) : 0);
    if (Math.abs(1200 * Math.log2(peakBin / center)) > PEAK_TOLERANCE_CENTS) continue;
    const flank = Math.max(PROMINENCE_MIN_BINS, Math.round(center * (2 ** (PROMINENCE_SEMITONES / 12) - 1)));
    const lowerSide = spectrumDb[Math.max(1, i - flank)];
    const upperSide = spectrumDb[Math.min(last, i + flank)];
    if (b - Math.min(lowerSide, upperSide) < PROMINENCE_DB) continue;
    if (best === null || b > best) best = b;
  }
  return best === null ? { db: spectrumDb[Math.round(center)], isPeak: false } : { db: best, isPeak: true };
}

function notePeak(spectrumDb, binHz, hz) {
  const fundamental = peakNear(spectrumDb, binHz, hz);
  if (hz >= WEAK_FUNDAMENTAL_HZ) return fundamental;
  return [peakNear(spectrumDb, binHz, hz * 2), peakNear(spectrumDb, binHz, hz * 3)]
    .reduce((a, b) => (Number(b.isPeak) - Number(a.isPeak) || b.db - a.db) > 0 ? b : a, fundamental);
}

function spectrumStats(spectrumDb, binHz) {
  const from = Math.max(1, Math.round(60 / binHz));
  const to = Math.min(spectrumDb.length - 1, Math.round(3000 / binHz));
  const band = Float32Array.from(spectrumDb.subarray(from, to + 1)).sort();
  return { noise: band[band.length >> 1], loudest: band[band.length - 1] };
}

// En un arpegio las notas anteriores siguen sonando y un detector de «la nota que suena» se confunde.
// Este no pregunta qué suena, sino si acaba de aparecer la que se espera. Combina dos medidas:
// - un filtro corto en la frecuencia de la nota, que ve al instante el ataque de la pulsación;
// - el espectro largo, que distingue semitonos y confirma que la nota está afinada y presente.
export class NoteDetector {
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    this.arm([]);
  }

  arm(midis) {
    this.targets = [...new Set(midis)].map((midi) => {
      const hz = midiToHz(midi);
      return {
        midi,
        hz,
        attackHz: hz < WEAK_FUNDAMENTAL_HZ ? hz * 2 : hz,
        history: [],
        attack: null,
        startDb: null,
        present: false,
      };
    });
    this.hits = 0;
    this.wasOpen = true;
  }

  get required() {
    return Math.ceil(this.targets.length * CHORD_SHARE);
  }

  get heardCount() {
    return this.targets.filter((target) => target.present).length;
  }

  // Llamar cada tick con el espectro en dB y las muestras recientes. `open` a false no da nada por oído:
  // es para cuando el altavoz está dando la nota de referencia y el micro se oye a sí mismo.
  feed(spectrumDb, samples, open = true) {
    const binHz = this.sampleRate / (2 * spectrumDb.length);
    const { noise, loudest } = spectrumStats(spectrumDb, binHz);
    const threshold = Math.max(noise + ABOVE_NOISE_DB, loudest - WITHIN_LOUDEST_DB, MIN_DB);
    this.threshold = threshold;
    const justOpened = open && !this.wasOpen;
    this.wasOpen = open;

    let anyNew = false;
    for (const target of this.targets) {
      const { db, isPeak } = notePeak(spectrumDb, binHz, target.hz);
      target.startDb ??= db;
      target.db = db;
      target.isPeak = isPeak;

      const band = bandDb(samples, this.sampleRate, target.attackHz);
      if (!target.history.length) {
        target.history.push(bandDb(samples, this.sampleRate, target.attackHz, Math.round(this.sampleRate * TICK_SECONDS)));
      }
      const lowest = Math.min(...target.history);
      if (target.attack) target.attack.age++;
      if (target.attack?.age >= ATTACK_MEMORY_TICKS) target.attack = null;
      if (!target.attack && band - lowest >= ATTACK_RISE_DB) target.attack = { base: lowest, age: 0 };
      target.history.push(band);
      if (target.history.length > ATTACK_HISTORY_TICKS) target.history.shift();

      // Si se pulsó encima de la referencia, el ataque quedó tapado, pero la cuerda sigue sonando.
      if (justOpened && db - target.startDb >= RINGING_RISE_DB) target.attack = { base: -Infinity, age: ATTACK_SETTLE_TICKS };
      target.present = isPeak && db > threshold;
      // El golpe de púa en otra cuerda dura milisegundos: solo cuenta si la subida se mantiene pasado el golpe.
      const sustained = target.attack?.age >= ATTACK_SETTLE_TICKS && band - target.attack.base >= ATTACK_RISE_DB;
      if (target.present && sustained) anyNew = true;
    }

    // Un acorde puede compartir notas con el anterior, y esas no «aparecen»: basta con que estén casi
    // todas y que alguna sea de esta pulsación.
    const matched = open && anyNew && this.heardCount >= this.required;
    this.hits = matched ? this.hits + 1 : 0;
    return this.targets.length > 0 && this.hits >= HITS_TO_CONFIRM;
  }
}
