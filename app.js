import { TUNINGS, detectTuning, noteName, parseTab, soundingMidi } from './tab.js';
import { FINGER_NAMES, PLUCK_FINGER, assignFingers, sharesFinger } from './fingering.js';
import { NoteDetector, midiToHz } from './pitch.js';

const STORAGE_KEY = 'nota-a-nota';
const LISTEN_MS = 50;
const FFT_SIZE = 16384;
const TONE_SECONDS = 0.5;
// La nota de referencia más lo que tarda en salir de la ventana larga del analizador.
const TONE_GATE_MS = 900;
const DEFAULT_BPM = 80;
const MIN_BPM = 30;
const MAX_BPM = 200;
const BPM_STEP = 5;
const PLAYBACK_TICK_MS = 25;
const PLAYBACK_LOOKAHEAD_SECONDS = 0.12;
const PLAYBACK_RING_SECONDS = 1.6;
// Las notas se solapan al dejarlas sonar: se baja el nivel para que no saturen.
const PLAYBACK_LEVEL = 0.55;
const STRUM_SECONDS = 0.012;
const DEBUG = new URLSearchParams(location.search).has('debug');

const SAMPLE_TAB = `[Calentamiento]
e|-------------------0-1-3-|
B|-------------0-1-3-------|
G|-------0-2---------------|
D|-0-2-3-------------------|
A|-------------------------|
E|-------------------------|

[Acordes]
e|-3---0---0-----|
B|-0---0---1-----|
G|-0---0---0-----|
D|-0---2---2-----|
A|-2---2---3-----|
E|-3---0---------|

[Ligados]
e|---------------|
B|-0h1p0---------|
G|-------0/2-----|
D|---------------|
A|---------------|
E|---------------|`;

const $ = (id) => document.getElementById(id);
const el = {
  setup: $('setup'), practice: $('practice'), done: $('done'),
  input: $('tab-input'), status: $('tab-status'), tuning: $('tuning'), capo: $('capo'),
  section: $('section'), count: $('count'), bar: $('progress-bar'),
  instruction: $('instruction'), fretboard: $('fretboard'), strip: $('strip'),
  back: $('back'), auto: $('auto'), mic: $('mic'), micStatus: $('mic-status'), hands: $('hands'),
  rhythm: $('rhythm'), tempo: $('tempo'), loop: $('loop'),
};

const state = { steps: [], pos: 0, tuning: TUNINGS[0], capo: 0, autoSound: true, bpm: DEFAULT_BPM, loop: true };

function load() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) ?? {};
  } catch {
    return {};
  }
}

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      text: el.input.value,
      tuning: el.tuning.value,
      capo: el.capo.value,
      pos: state.pos,
      autoSound: state.autoSound,
      bpm: state.bpm,
      loop: state.loop,
    }));
  } catch {
    // Sin almacenamiento (modo privado) la app funciona igual, solo que no recuerda el progreso.
  }
}

function show(screen) {
  stopPlayback();
  for (const name of ['setup', 'practice', 'done']) el[name].hidden = name !== screen;
  if (screen === 'practice') requestWakeLock();
  else releaseWakeLock();
  if (screen !== 'practice') stopMic();
}

// --- Pantalla de configuración ---

function describeTab() {
  const text = el.input.value;
  el.status.className = 'hint';
  if (!text.trim()) {
    el.status.textContent = 'Pídele a Gemini el tab «en formato ASCII, con las 6 cuerdas», y pégalo aquí.';
    return;
  }
  const { steps, labels, capo, bpm, rhythmBlocks, rhythmErrors } = parseTab(text);
  const tuning = detectTuning(labels);
  if (tuning) el.tuning.value = tuning.id;
  if (capo !== null) el.capo.value = capo;
  if (steps.length) {
    const parts = [`He encontrado ${steps.length} pasos.`];
    if (bpm) parts.push(`BPM del tab: ${bpm}.`);
    if (rhythmBlocks) parts.push(`Ritmo aplicado en ${rhythmBlocks} bloque${rhythmBlocks > 1 ? 's' : ''}.`);
    el.status.textContent = parts.join(' ');
    el.status.classList.add('ok');
    if (rhythmErrors.length) {
      el.status.textContent += ` Ritmo sin aplicar: ${rhythmErrors.join('; ')}.`;
      el.status.classList.remove('ok');
      el.status.classList.add('error');
    }
  } else {
    el.status.textContent = 'No veo ningún tab: necesito bloques de 6 líneas, una por cuerda.';
    el.status.classList.add('error');
  }
}

function start() {
  const text = el.input.value;
  const { steps, bpm } = parseTab(text);
  if (!steps.length) {
    describeTab();
    if (!text.trim()) {
      el.status.textContent = 'Primero pega un tab.';
      el.status.classList.add('error');
    }
    return;
  }
  const saved = load();
  // El BPM del tab solo cuenta si es un tab nuevo: así tus ajustes de velocidad no se pisan al reabrir la app.
  if (bpm && saved.text !== text) setBpm(bpm);
  state.steps = assignFingers(steps);
  state.tuning = TUNINGS.find((t) => t.id === el.tuning.value) ?? TUNINGS[0];
  state.capo = Math.max(0, Number(el.capo.value) || 0);
  state.pos = saved.text === text && saved.pos < steps.length ? saved.pos : 0;
  show('practice');
  render();
  if (state.autoSound) playCurrent();
}

// --- Dibujo ---

function stringLabel(string) {
  const name = noteName(state.tuning.midi[string - 1] + state.capo);
  if (string === 1) return `Cuerda 1 · ${name} (la más fina)`;
  if (string === 6) return `Cuerda 6 · ${name} (la más gorda)`;
  return `Cuerda ${string} · ${name}`;
}

const fretText = (fret) => (fret === 0 ? 'Al aire' : `Traste ${fret}`);
const TECHNIQUE_TEXT = {
  'hammer-on': 'Ligado: golpea con el dedo, sin púa',
  'pull-off': 'Ligado: tira del dedo, sin púa',
  slide: 'Desliza el dedo desde la nota anterior',
  bending: 'Estira la cuerda hacia arriba',
};

function div(className, text) {
  const node = document.createElement('div');
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function sameStep(a, b) {
  return Boolean(a && b) && a.notes.length === b.notes.length
    && a.notes.every((n, i) => n.string === b.notes[i].string && n.fret === b.notes[i].fret);
}

function fingersLine(note) {
  const line = div('fingers');
  const fretting = document.createElement('b');
  fretting.textContent = note.finger ? `Dedo ${note.finger} (${FINGER_NAMES[note.finger]})` : 'Sin pisar';
  line.append(fretting, ` · pulsa con ${PLUCK_FINGER[note.string]}`);
  return line;
}

// Solo cabe un aviso: el más urgente.
function stepTag(step, previous) {
  if (step.moved) return `✋ Mano aquí: índice al traste ${step.position}`;
  const technique = step.notes.find((note) => note.technique)?.technique;
  if (technique) return TECHNIQUE_TEXT[technique];
  if (sameStep(step, previous)) return 'Otra vez la misma';
  if (step.notes.length === 1 && sharesFinger(state.steps, state.pos, step.notes[0])) {
    return 'El mismo dedo pisa las dos cuerdas';
  }
  return null;
}

function renderInstruction(step, previous) {
  const nodes = [];
  if (step.notes.length === 1) {
    const [note] = step.notes;
    nodes.push(div('big', fretText(note.fret)), div('sub', stringLabel(note.string)), fingersLine(note));
  } else {
    nodes.push(div('chord-title', `A la vez · ${step.notes.length} cuerdas`));
    const grid = div('chord-grid');
    for (const note of step.notes) {
      const row = div('chord-row', `Cuerda ${note.string}: `);
      const fret = document.createElement('b');
      fret.textContent = note.finger ? `T${note.fret} · dedo ${note.finger}` : 'al aire';
      row.append(fret);
      grid.append(row);
    }
    nodes.push(grid);
  }
  const tag = stepTag(step, previous);
  if (tag) nodes.push(div('tag', tag));
  el.instruction.replaceChildren(...nodes);
  el.instruction.classList.remove('pop');
  void el.instruction.offsetWidth;
  el.instruction.classList.add('pop');
}

// El mástil se encuadra en la zona de la mano, no en la nota, para que no salte en cada paso.
function fretWindow(step) {
  const frets = step.notes.map((n) => n.fret).filter(Boolean);
  const lo = Math.min(step.position, ...frets);
  const hi = Math.max(step.position + 3, ...frets);
  const first = Math.max(1, lo - 1);
  return { first, count: Math.max(5, hi - first + 1) };
}

function renderFretboard(step, next) {
  const W = 360;
  const H = 204;
  const left = 46;
  const top = 12;
  const gap = 26;
  const { first, count } = fretWindow(step);
  const fretW = (W - left - 6) / count;
  const y = (string) => top + (string - 1) * gap;
  const bottom = y(6);
  const fretX = (fret) => (fret === 0 ? 30 : left + (fret - first + 0.5) * fretW);

  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Mástil de la guitarra">`;
  const handFrom = left + (step.position - first) * fretW;
  svg += `<rect x="${handFrom}" y="${top - 6}" width="${4 * fretW}" height="${bottom - top + 12}" rx="6" fill="#22c55e" opacity="0.1"/>`;
  for (const marker of [3, 5, 7, 9, 15, 17]) {
    if (marker >= first && marker < first + count) {
      svg += `<circle cx="${fretX(marker)}" cy="${(top + bottom) / 2}" r="5" fill="#34403a"/>`;
    }
  }
  if (12 >= first && 12 < first + count) {
    svg += `<circle cx="${fretX(12)}" cy="${y(2) + gap / 2}" r="5" fill="#34403a"/><circle cx="${fretX(12)}" cy="${y(4) + gap / 2}" r="5" fill="#34403a"/>`;
  }
  for (let i = 0; i <= count; i++) {
    const x = left + i * fretW;
    const nut = i === 0 && first === 1;
    svg += `<line x1="${x}" x2="${x}" y1="${top}" y2="${bottom}" stroke="${nut ? '#f1f5f3' : '#4b5a52'}" stroke-width="${nut ? 5 : 1.5}"/>`;
  }
  svg += `<text x="2" y="${bottom + 28}" fill="#9fb0a8" font-size="11">traste</text>`;
  svg += `<text x="2" y="${bottom + 46}" fill="#22c55e" font-size="11">dedo</text>`;
  for (let i = 0; i < count; i++) {
    svg += `<text x="${fretX(first + i)}" y="${bottom + 28}" text-anchor="middle" fill="#9fb0a8" font-size="13">${first + i}</text>`;
    const finger = first + i - step.position + 1;
    if (finger >= 1 && finger <= 4) {
      svg += `<text x="${fretX(first + i)}" y="${bottom + 46}" text-anchor="middle" fill="#22c55e" font-size="13" font-weight="700">${finger}</text>`;
    }
  }
  const active = new Set(step.notes.map((n) => n.string));
  for (let string = 1; string <= 6; string++) {
    const stroke = active.has(string) ? '#22c55e' : '#7c8c84';
    svg += `<line x1="${left}" x2="${W - 6}" y1="${y(string)}" y2="${y(string)}" stroke="${stroke}" stroke-width="${0.9 + string * 0.3}"/>`;
    svg += `<text x="4" y="${y(string) + 5}" fill="${active.has(string) ? '#22c55e' : '#9fb0a8'}" font-size="14" font-weight="700">${string}</text>`;
  }
  const inWindow = (fret) => fret === 0 || (fret >= first && fret < first + count);
  const current = new Set(step.notes.map((n) => `${n.string}:${n.fret}`));
  for (const note of next?.notes ?? []) {
    if (current.has(`${note.string}:${note.fret}`) || !inWindow(note.fret)) continue;
    svg += `<circle cx="${fretX(note.fret)}" cy="${y(note.string)}" r="9" fill="#0f1412" stroke="#9fb0a8" stroke-width="1.5" stroke-dasharray="3 2"/>`;
  }
  for (const note of step.notes) {
    svg += `<circle cx="${fretX(note.fret)}" cy="${y(note.string)}" r="11.5" fill="#22c55e"/>`;
    svg += `<text x="${fretX(note.fret)}" y="${y(note.string) + 5}" text-anchor="middle" fill="#04200f" font-size="14" font-weight="800">${note.finger ?? 0}</text>`;
  }
  el.fretboard.innerHTML = `${svg}</svg>`;
}

function renderStrip() {
  const available = Math.max(5, Math.floor((el.strip.clientWidth - 8) / 26));
  const before = Math.min(2, Math.floor(available / 4));
  const from = Math.max(0, state.pos - before);
  const cols = [];
  for (let i = from; i < Math.min(state.steps.length, from + available); i++) {
    const col = document.createElement('button');
    col.type = 'button';
    col.tabIndex = -1;
    col.className = `strip-col${i === state.pos ? ' current' : ''}${i < state.pos ? ' past' : ''}`;
    col.dataset.pos = i;
    for (let string = 1; string <= 6; string++) {
      const note = state.steps[i].notes.find((n) => n.string === string);
      const cell = document.createElement('span');
      if (note) {
        cell.textContent = note.fret;
      } else {
        cell.textContent = '–';
        cell.className = 'empty';
      }
      col.append(cell);
    }
    cols.push(col);
  }
  el.strip.replaceChildren(...cols);
}

function render() {
  const step = state.steps[state.pos];
  const next = state.steps[state.pos + 1];
  el.section.textContent = step.section;
  el.count.textContent = `${state.pos + 1} / ${state.steps.length}`;
  el.bar.style.width = `${(state.pos / state.steps.length) * 100}%`;
  el.back.disabled = state.pos === 0;
  renderInstruction(step, state.steps[state.pos - 1]);
  renderFretboard(step, next);
  renderStrip();
  save();
}

// --- Navegación ---

function goTo(pos) {
  stopPlayback();
  state.pos = pos;
  armListening();
  render();
  if (state.autoSound) playCurrent();
}

function advance() {
  navigator.vibrate?.(25);
  if (state.pos + 1 >= state.steps.length) {
    state.pos = 0;
    save();
    show('done');
    return;
  }
  goTo(state.pos + 1);
}

// --- Sonido de referencia ---

let audio = null;
let output = null;

function audioContext() {
  if (!audio) {
    audio = new (window.AudioContext ?? window.webkitAudioContext)();
    // Con el micro activo iOS baja mucho el volumen: se sube todo lo posible sin que distorsione.
    const boost = audio.createGain();
    boost.gain.value = 2.4;
    const limiter = audio.createDynamicsCompressor();
    limiter.threshold.value = -9;
    limiter.knee.value = 6;
    limiter.ratio.value = 14;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.12;
    boost.connect(limiter).connect(audio.destination);
    output = boost;
  }
  return audio;
}

function pluck(midi, when, seconds = TONE_SECONDS, destination = output) {
  const ctx = audioContext();
  // Como en una cuerda real, los armónicos agudos se apagan antes que la nota.
  for (const [harmonic, level] of [[1, 0.35], [2, 0.16], [3, 0.07], [4, 0.03]]) {
    const osc = ctx.createOscillator();
    const partial = ctx.createGain();
    osc.frequency.value = midiToHz(midi) * harmonic;
    partial.gain.setValueAtTime(0.0001, when);
    partial.gain.exponentialRampToValueAtTime(level, when + 0.006);
    partial.gain.exponentialRampToValueAtTime(0.0001, when + seconds / (1 + 0.5 * (harmonic - 1)));
    osc.connect(partial).connect(destination);
    osc.start(when);
    osc.stop(when + seconds + 0.05);
  }
}

function playCurrent() {
  const ctx = audioContext();
  ctx.resume();
  const notes = [...state.steps[state.pos].notes].sort((a, b) => b.string - a.string);
  notes.forEach((note, i) => pluck(soundingMidi(note, state.tuning, state.capo), ctx.currentTime + 0.01 + i * 0.03));
  // Que el micro no se oiga a sí mismo y avance solo.
  listening.ignoreUntil = performance.now() + TONE_GATE_MS + notes.length * 30;
}

function setAutoSound(on) {
  state.autoSound = on;
  el.auto.setAttribute('aria-pressed', String(on));
  el.auto.textContent = on ? '🔔 Auto' : '🔕 Auto';
  save();
}

// --- Escuchar a ritmo ---

const playback = { active: false, timer: null, bus: null, nextPos: 0, nextTime: 0, queue: [] };

// Se programa un poco por adelantado con el reloj de audio: un temporizador no daría un ritmo estable.
function schedulePlayback() {
  const now = audio.currentTime;
  while (playback.nextTime < now + PLAYBACK_LOOKAHEAD_SECONDS) {
    if (playback.nextPos >= state.steps.length) {
      if (!state.loop) break;
      playback.nextPos = 0;
    }
    const step = state.steps[playback.nextPos];
    const notes = [...step.notes].sort((a, b) => b.string - a.string);
    notes.forEach((note, i) => {
      pluck(soundingMidi(note, state.tuning, state.capo), playback.nextTime + i * STRUM_SECONDS, PLAYBACK_RING_SECONDS, playback.bus);
    });
    playback.queue.push({ pos: playback.nextPos, time: playback.nextTime });
    playback.nextTime += step.duration * (30 / state.bpm);
    playback.nextPos++;
  }

  while (playback.queue.length && playback.queue[0].time <= now) {
    state.pos = playback.queue.shift().pos;
    render();
  }
  if (!playback.queue.length && playback.nextPos >= state.steps.length && !state.loop && now >= playback.nextTime) {
    stopPlayback();
  }
}

function startPlayback() {
  const ctx = audioContext();
  ctx.resume();
  const bus = ctx.createGain();
  bus.gain.value = PLAYBACK_LEVEL;
  bus.connect(output);
  // Al final del tab, volver a pulsar empieza de nuevo.
  const from = state.pos === state.steps.length - 1 ? 0 : state.pos;
  Object.assign(playback, {
    active: true, bus, nextPos: from, nextTime: ctx.currentTime + 0.08, queue: [], timer: setInterval(schedulePlayback, PLAYBACK_TICK_MS),
  });
  el.practice.classList.add('playing');
  el.rhythm.textContent = '⏹ Parar';
  el.rhythm.setAttribute('aria-pressed', 'true');
  if (listening.stream) setMicStatus('🎧 Micro en pausa mientras suena');
  schedulePlayback();
}

function stopPlayback() {
  if (!playback.active) return;
  clearInterval(playback.timer);
  const { bus } = playback;
  bus.gain.setTargetAtTime(0, audio.currentTime, 0.03);
  setTimeout(() => bus.disconnect(), 400);
  Object.assign(playback, { active: false, timer: null, bus: null, queue: [] });
  el.practice.classList.remove('playing');
  el.rhythm.textContent = '▶ Ritmo';
  el.rhythm.setAttribute('aria-pressed', 'false');
  // Que el micro no tome por tuyo lo último que ha sonado.
  listening.ignoreUntil = performance.now() + TONE_GATE_MS;
  armListening();
  save();
}

function setBpm(bpm) {
  state.bpm = Math.max(MIN_BPM, Math.min(MAX_BPM, bpm));
  el.tempo.textContent = `${state.bpm} BPM`;
  save();
}

function setLoop(on) {
  state.loop = on;
  el.loop.setAttribute('aria-pressed', String(on));
  save();
}

// --- Micrófono ---

const listening = {
  timer: null, stream: null, analyser: null, time: null, spectrum: null, detector: null, ignoreUntil: 0,
};

function wantedMidis(step) {
  return step.notes.map((note) => soundingMidi(note, state.tuning, state.capo));
}

function armListening() {
  const step = state.steps[state.pos];
  if (step) listening.detector?.arm(wantedMidis(step));
}

function micStatusText(detector, open) {
  if (DEBUG) {
    const notes = detector.targets.map((t) => `${noteName(t.midi)} ${t.db?.toFixed(0)}${t.isPeak ? '▲' : ''}${t.attack ? '!' : ''}`);
    return `${notes.join(' ')} · umbral ${detector.threshold?.toFixed(0)}`;
  }
  if (!open) return '🔊 Escucha la nota…';
  if (detector.targets.length > 1) return `🎸 Ahora tú · oigo ${detector.heardCount} de ${detector.required}`;
  return '🎸 Ahora tú';
}

function listenTick() {
  const { analyser, time, spectrum, detector } = listening;
  if (!state.steps[state.pos] || el.practice.hidden || playback.active) return;

  analyser.getFloatFrequencyData(spectrum);
  analyser.getFloatTimeDomainData(time);
  const open = performance.now() >= listening.ignoreUntil;
  const done = detector.feed(spectrum, time, open);
  setMicStatus(micStatusText(detector, open));
  if (done) advance();
}

function setMicStatus(text, isError = false) {
  el.micStatus.hidden = !text;
  el.micStatus.textContent = text;
  el.micStatus.classList.toggle('error', isError);
}

async function startMic() {
  if (!navigator.mediaDevices?.getUserMedia) {
    setMicStatus('Este navegador no deja usar el micro. Usa el botón.', true);
    return;
  }
  try {
    const ctx = audioContext();
    await ctx.resume();
    if (navigator.audioSession) navigator.audioSession.type = 'play-and-record';
    // Sin estos filtros: la cancelación de ruido del móvil se come el sonido de la guitarra.
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    // En iOS, al abrir el micro el sonido puede pasar al auricular; reiniciar el contexto lo devuelve al altavoz.
    await ctx.suspend();
    await ctx.resume();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = FFT_SIZE;
    analyser.smoothingTimeConstant = 0;
    ctx.createMediaStreamSource(stream).connect(analyser);
    Object.assign(listening, {
      stream,
      analyser,
      time: new Float32Array(analyser.fftSize),
      spectrum: new Float32Array(analyser.frequencyBinCount),
      detector: new NoteDetector(ctx.sampleRate),
      timer: setInterval(listenTick, LISTEN_MS),
    });
    armListening();
    el.mic.setAttribute('aria-pressed', 'true');
    setMicStatus('🎸 Ahora tú');
  } catch (error) {
    const denied = error.name === 'NotAllowedError';
    setMicStatus(denied ? 'Permiso de micro denegado. Actívalo en el navegador o usa el botón.' : 'No he podido abrir el micro. Usa el botón.', true);
  }
}

function stopMic() {
  clearInterval(listening.timer);
  listening.stream?.getTracks().forEach((track) => track.stop());
  Object.assign(listening, { timer: null, stream: null, analyser: null, detector: null });
  if (navigator.audioSession) navigator.audioSession.type = 'auto';
  el.mic.setAttribute('aria-pressed', 'false');
  setMicStatus('');
}

// --- Pantalla siempre encendida ---

let wakeLock = null;

async function requestWakeLock() {
  try {
    wakeLock = await navigator.wakeLock?.request('screen');
  } catch {
    wakeLock = null;
  }
}

function releaseWakeLock() {
  wakeLock?.release();
  wakeLock = null;
}

document.addEventListener('visibilitychange', () => {
  // En segundo plano el móvil frena los temporizadores y el ritmo se rompería.
  if (document.visibilityState !== 'visible') stopPlayback();
  if (document.visibilityState !== 'visible' || el.practice.hidden) return;
  requestWakeLock();
  if (listening.stream) audio.resume();
});

// --- Eventos ---

el.tuning.append(...TUNINGS.map((t) => new Option(t.name, t.id)));

const saved = load();
if (saved.text) el.input.value = saved.text;
if (saved.tuning) el.tuning.value = saved.tuning;
if (saved.capo) el.capo.value = saved.capo;
setAutoSound(saved.autoSound ?? true);
setBpm(saved.bpm ?? DEFAULT_BPM);
setLoop(saved.loop ?? true);
if (saved.text) {
  const { steps } = parseTab(saved.text);
  el.status.textContent = `Tab guardado: ${steps.length} pasos.`;
  el.status.classList.add('ok');
}

el.input.addEventListener('input', () => {
  el.tuning.value = TUNINGS[0].id;
  el.capo.value = 0;
  describeTab();
});
$('sample').addEventListener('click', () => {
  el.input.value = SAMPLE_TAB;
  el.tuning.value = TUNINGS[0].id;
  el.capo.value = 0;
  describeTab();
  start();
});
$('start').addEventListener('click', start);
$('next').addEventListener('click', advance);
el.back.addEventListener('click', () => goTo(state.pos - 1));
$('listen').addEventListener('click', playCurrent);
el.auto.addEventListener('click', () => setAutoSound(!state.autoSound));
el.mic.addEventListener('click', () => (listening.stream ? stopMic() : startMic()));
el.rhythm.addEventListener('click', () => (playback.active ? stopPlayback() : startPlayback()));
$('slower').addEventListener('click', () => setBpm(state.bpm - BPM_STEP));
$('faster').addEventListener('click', () => setBpm(state.bpm + BPM_STEP));
el.loop.addEventListener('click', () => setLoop(!state.loop));
$('open-hands').addEventListener('click', () => el.hands.showModal());
$('close-hands').addEventListener('click', () => el.hands.close());
$('exit').addEventListener('click', () => show('setup'));
$('restart').addEventListener('click', () => goTo(0));
$('again').addEventListener('click', () => {
  show('practice');
  goTo(0);
});
$('new-tab').addEventListener('click', () => show('setup'));
el.strip.addEventListener('click', (event) => {
  const col = event.target.closest('.strip-col');
  if (col) goTo(Number(col.dataset.pos));
});
window.addEventListener('resize', () => {
  if (!el.practice.hidden) renderStrip();
});
// Los pedales de pasar página por Bluetooth envían estas teclas.
document.addEventListener('keydown', (event) => {
  if (el.practice.hidden || el.hands.open || event.repeat) return;
  if (playback.active) {
    if ([' ', 'Enter'].includes(event.key)) event.preventDefault();
    stopPlayback();
    return;
  }
  if ([' ', 'ArrowRight', 'ArrowDown', 'PageDown', 'Enter'].includes(event.key)) {
    event.preventDefault();
    advance();
  } else if (['ArrowLeft', 'ArrowUp', 'PageUp'].includes(event.key) && state.pos > 0) {
    event.preventDefault();
    goTo(state.pos - 1);
  }
});
