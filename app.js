import { TUNINGS, detectTuning, noteName, parseTab, soundingMidi } from './tab.js';
import { chordPresent, detectPitch, hzToMidi, midiToHz, rms, sameNote } from './pitch.js';

const STORAGE_KEY = 'nota-a-nota';
const MIN_LEVEL = 0.006;
const ATTACK_RATIO = 1.35;
const LISTEN_MS = 50;
const HITS_TO_ADVANCE = 2;

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
  back: $('back'), mic: $('mic'), micStatus: $('mic-status'),
};

const state = { steps: [], pos: 0, tuning: TUNINGS[0], capo: 0 };

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
      text: el.input.value, tuning: el.tuning.value, capo: el.capo.value, pos: state.pos,
    }));
  } catch {
    // Sin almacenamiento (modo privado) la app funciona igual, solo que no recuerda el progreso.
  }
}

function show(screen) {
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
  const { steps, labels, capo } = parseTab(text);
  const tuning = detectTuning(labels);
  if (tuning) el.tuning.value = tuning.id;
  if (capo !== null) el.capo.value = capo;
  if (steps.length) {
    el.status.textContent = `He encontrado ${steps.length} pasos.`;
    el.status.classList.add('ok');
  } else {
    el.status.textContent = 'No veo ningún tab: necesito bloques de 6 líneas, una por cuerda.';
    el.status.classList.add('error');
  }
}

function start() {
  const text = el.input.value;
  const { steps } = parseTab(text);
  if (!steps.length) {
    describeTab();
    if (!text.trim()) {
      el.status.textContent = 'Primero pega un tab.';
      el.status.classList.add('error');
    }
    return;
  }
  const saved = load();
  state.steps = steps;
  state.tuning = TUNINGS.find((t) => t.id === el.tuning.value) ?? TUNINGS[0];
  state.capo = Math.max(0, Number(el.capo.value) || 0);
  state.pos = saved.text === text && saved.pos < steps.length ? saved.pos : 0;
  show('practice');
  render();
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

function renderInstruction(step, previous) {
  const nodes = [];
  if (step.notes.length === 1) {
    const [note] = step.notes;
    nodes.push(div('big', fretText(note.fret)), div('sub', stringLabel(note.string)));
    if (note.technique) nodes.push(div('tag', TECHNIQUE_TEXT[note.technique]));
  } else {
    nodes.push(div('chord-title', `A la vez · ${step.notes.length} cuerdas`));
    const grid = div('chord-grid');
    for (const note of step.notes) {
      const row = div('chord-row', `Cuerda ${note.string}: `);
      const fret = document.createElement('b');
      fret.textContent = fretText(note.fret);
      row.append(fret);
      grid.append(row);
    }
    nodes.push(grid);
  }
  if (sameStep(step, previous)) nodes.push(div('tag', 'Otra vez la misma'));
  el.instruction.replaceChildren(...nodes);
  el.instruction.classList.remove('pop');
  void el.instruction.offsetWidth;
  el.instruction.classList.add('pop');
}

function fretWindow(step, next) {
  const frets = (s) => (s ? s.notes.map((n) => n.fret).filter(Boolean) : []);
  const fit = (list) => {
    if (!list.length) return { first: 1, count: 5 };
    const hi = Math.max(...list);
    if (hi <= 5) return { first: 1, count: 5 };
    const first = Math.max(1, Math.min(...list) - 1);
    return { first, count: Math.max(5, hi - first + 1) };
  };
  const both = fit([...frets(step), ...frets(next)]);
  return both.count <= 7 ? both : fit(frets(step));
}

function renderFretboard(step, next) {
  const W = 360;
  const H = 176;
  const left = 46;
  const top = 12;
  const gap = 26;
  const { first, count } = fretWindow(step, next);
  const fretW = (W - left - 6) / count;
  const y = (string) => top + (string - 1) * gap;
  const bottom = y(6);
  const fretX = (fret) => (fret === 0 ? 30 : left + (fret - first + 0.5) * fretW);

  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Mástil de la guitarra">`;
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
  for (let i = 0; i < count; i++) {
    svg += `<text x="${fretX(first + i)}" y="${bottom + 22}" text-anchor="middle" fill="#9fb0a8" font-size="13">${first + i}</text>`;
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
    svg += `<text x="${fretX(note.fret)}" y="${y(note.string) + 5}" text-anchor="middle" fill="#04200f" font-size="14" font-weight="800">${note.fret}</text>`;
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
  state.pos = pos;
  armListening();
  render();
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
const audioContext = () => (audio ??= new (window.AudioContext ?? window.webkitAudioContext)());

function pluck(midi, when) {
  const ctx = audioContext();
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, when);
  gain.gain.exponentialRampToValueAtTime(0.35, when + 0.008);
  gain.gain.exponentialRampToValueAtTime(0.0001, when + 1.3);
  gain.connect(ctx.destination);
  for (const [harmonic, level] of [[1, 1], [2, 0.45], [3, 0.2]]) {
    const osc = ctx.createOscillator();
    const partial = ctx.createGain();
    osc.frequency.value = midiToHz(midi) * harmonic;
    partial.gain.value = level;
    osc.connect(partial).connect(gain);
    osc.start(when);
    osc.stop(when + 1.35);
  }
}

function playCurrent() {
  const ctx = audioContext();
  ctx.resume();
  const notes = [...state.steps[state.pos].notes].sort((a, b) => b.string - a.string);
  notes.forEach((note, i) => pluck(soundingMidi(note, state.tuning, state.capo), ctx.currentTime + 0.01 + i * 0.03));
  // Que el micro no se oiga a sí mismo y avance solo.
  listening.ignoreUntil = performance.now() + 1500;
}

// --- Micrófono ---

const listening = {
  timer: null, stream: null, analyser: null, time: null, spectrum: null,
  floor: Infinity, needsAttack: false, hits: 0, ignoreUntil: 0,
};

function wantedMidis(step) {
  return step.notes.map((note) => soundingMidi(note, state.tuning, state.capo));
}

// Si la nota nueva ya estaba sonando en el paso anterior, hace falta volver a pulsarla.
function armListening() {
  const step = state.steps[state.pos];
  const previous = state.steps[state.pos - 1];
  const ringing = new Set(previous ? wantedMidis(previous).map((m) => m % 12) : []);
  listening.needsAttack = step ? wantedMidis(step).some((m) => ringing.has(m % 12)) : false;
  listening.floor = Infinity;
  listening.hits = 0;
  listening.ignoreUntil = Math.max(listening.ignoreUntil, performance.now() + 120);
}

function listenTick() {
  const { analyser, time, spectrum } = listening;
  const step = state.steps[state.pos];
  if (!step || el.practice.hidden) return;

  analyser.getFloatTimeDomainData(time);
  const recent = time.subarray(time.length / 2);
  const level = rms(recent);
  listening.floor = Math.min(listening.floor, level);
  if (performance.now() < listening.ignoreUntil) return;

  if (level < MIN_LEVEL) {
    listening.hits = 0;
    setMicStatus('Escuchando… toca la nota');
    return;
  }
  if (listening.needsAttack) {
    if (level < listening.floor * ATTACK_RATIO) return;
    listening.needsAttack = false;
  }

  const wanted = wantedMidis(step);
  let matched;
  if (wanted.length === 1) {
    const hz = detectPitch(recent, audio.sampleRate);
    matched = hz !== null && sameNote(hzToMidi(hz), wanted[0]);
    if (hz !== null) setMicStatus(`Oigo: ${noteName(hzToMidi(hz))}`);
  } else {
    analyser.getFloatFrequencyData(spectrum);
    matched = chordPresent(spectrum, audio.sampleRate, wanted);
  }

  listening.hits = matched ? listening.hits + 1 : 0;
  if (listening.hits >= HITS_TO_ADVANCE) advance();
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
    // Sin estos filtros: la cancelación de ruido del móvil se come el sonido de la guitarra.
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 8192;
    analyser.smoothingTimeConstant = 0;
    ctx.createMediaStreamSource(stream).connect(analyser);
    Object.assign(listening, {
      stream,
      analyser,
      time: new Float32Array(analyser.fftSize),
      spectrum: new Float32Array(analyser.frequencyBinCount),
      timer: setInterval(listenTick, LISTEN_MS),
    });
    armListening();
    el.mic.setAttribute('aria-pressed', 'true');
    setMicStatus('Escuchando… toca la nota');
  } catch (error) {
    const denied = error.name === 'NotAllowedError';
    setMicStatus(denied ? 'Permiso de micro denegado. Actívalo en el navegador o usa el botón.' : 'No he podido abrir el micro. Usa el botón.', true);
  }
}

function stopMic() {
  clearInterval(listening.timer);
  listening.stream?.getTracks().forEach((track) => track.stop());
  Object.assign(listening, { timer: null, stream: null, analyser: null });
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
el.mic.addEventListener('click', () => (listening.stream ? stopMic() : startMic()));
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
  if (el.practice.hidden || event.repeat) return;
  if ([' ', 'ArrowRight', 'ArrowDown', 'PageDown', 'Enter'].includes(event.key)) {
    event.preventDefault();
    advance();
  } else if (['ArrowLeft', 'ArrowUp', 'PageUp'].includes(event.key) && state.pos > 0) {
    event.preventDefault();
    goTo(state.pos - 1);
  }
});
