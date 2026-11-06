// Afinaciones: midi[0] es la cuerda 1 (la más fina). `key` son las etiquetas del tab de arriba a abajo.
export const TUNINGS = [
  { id: 'standard', name: 'Estándar (E A D G B E)', midi: [64, 59, 55, 50, 45, 40], keys: ['EBGDAE'] },
  { id: 'dropd', name: 'Drop D (D A D G B E)', midi: [64, 59, 55, 50, 45, 38], keys: ['EBGDAD'] },
  { id: 'halfdown', name: 'Medio tono abajo (Eb)', midi: [63, 58, 54, 49, 44, 39], keys: ['EbBbGbDbAbEb', 'D#A#F#C#G#D#'] },
  { id: 'dstandard', name: 'Un tono abajo (D G C F A D)', midi: [62, 57, 53, 48, 43, 38], keys: ['DAFCGD'] },
  { id: 'dropc', name: 'Drop C (C G C F A D)', midi: [62, 57, 53, 48, 43, 36], keys: ['DAFCGC'] },
  { id: 'dadgad', name: 'DADGAD', midi: [62, 57, 55, 50, 45, 38], keys: ['DAGDAD'] },
  { id: 'openg', name: 'Open G (D G D G B D)', midi: [62, 59, 55, 50, 43, 38], keys: ['DBGDGD'] },
  { id: 'opend', name: 'Open D (D A D F# A D)', midi: [62, 57, 54, 50, 45, 38], keys: ['DAF#DAD'] },
];

const NOTE_NAMES = ['Do', 'Do♯', 'Re', 'Re♯', 'Mi', 'Fa', 'Fa♯', 'Sol', 'Sol♯', 'La', 'La♯', 'Si'];

export function noteName(midi) {
  return NOTE_NAMES[((Math.round(midi) % 12) + 12) % 12];
}

export function soundingMidi(note, tuning, capo = 0) {
  return tuning.midi[note.string - 1] + capo + note.fret;
}

const BODY_CHARS = /^[-0-9hpbrsvxX~/\\()|.:^*=<>tTgPB ]+$/;
const TRAILING_REPEAT = /(?:\s+|\|\s*)\(?(?:[xX]\s*\d+|\d+\s*[xX])\)?\s*$/;
const SECTION = /^\s*(?:\[(.+)\]|#+\s*(.+)|\*\*(.+?):?\*\*:?|([^-|\d][^-|]{0,28}):)\s*$/;
const RHYTHM_LINE = /^\s*(?:ritmo|rhythm)\s*:\s*(.*\S)\s*$/i;
const TEMPO = /(?:\bbpm\b|\btempo\b|♩)\s*[:=]?\s*(\d{2,3})\b/i;
const MIN_BPM = 30;
const MAX_BPM = 240;
// Duración de cada valor en corcheas (1 = corchea, que es la unidad de step.duration).
const VALUE_IN_EIGHTHS = { 1: 8, 2: 4, 4: 2, 8: 1, 16: 0.5, 32: 0.25 };
const RHYTHM_TOKEN = /^(r?)(1|2|4|8|16|32)(\.?)$/i;

function parseTabLine(line) {
  const match = line.match(/^\s*([A-Ga-g](?:[#b](?=[-|:\s]))?)?\s*[|:]?\s*(.*?)\s*$/);
  if (!match) return null;
  const body = match[2].replace(TRAILING_REPEAT, '');
  if (!BODY_CHARS.test(body)) return null;
  const dashes = body.split('-').length - 1;
  if (dashes < 2 || dashes / body.length < 0.2) return null;
  return { label: match[1] ?? null, body };
}

const TECHNIQUES = { h: 'hammer-on', p: 'pull-off', '/': 'slide', '\\': 'slide', s: 'slide' };

function readNotes(body, string) {
  const notes = [];
  for (let col = 0; col < body.length; col++) {
    if (!/\d/.test(body[col])) continue;
    const two = body.slice(col, col + 2);
    const text = /^\d\d$/.test(two) && Number(two) <= 24 ? two : body[col];
    const note = { string, fret: Number(text), col, width: text.length };
    if (TECHNIQUES[body[col - 1]]) note.technique = TECHNIQUES[body[col - 1]];
    notes.push(note);
    col += text.length - 1;
    // El destino de una ligadura de bending (7b9r7) no se pulsa: se salta.
    const bend = body.slice(col + 1).match(/^(?:[br]\d{1,2})+/);
    if (bend) {
      note.technique = 'bending';
      col += bend[0].length;
    }
  }
  return notes;
}

function blockToSteps(block, section, blockIndex) {
  // Algunos tabs escriben las cuerdas al revés (E grave arriba, e aguda abajo).
  const reversed = block[0].label === 'E' && block[5].label === 'e';
  const ordered = reversed ? [...block].reverse() : block;
  const notes = ordered
    .flatMap((line, i) => readNotes(line.body, i + 1))
    .sort((a, b) => a.col - b.col || a.string - b.string);

  const steps = [];
  let end = -1;
  for (const { col, width, ...note } of notes) {
    if (col > end) {
      steps.push({ notes: [], section, block: blockIndex, col });
    }
    end = Math.max(end, col + width - 1);
    steps.at(-1).notes.push(note);
  }
  return { steps, labels: ordered.map((line) => line.label) };
}

// El ritmo sale de la separación entre notas en el tab: 1 es la separación más habitual.
function assignDurations(steps) {
  const gaps = [];
  steps.forEach((step, i) => {
    const next = steps[i + 1];
    if (next?.block === step.block) gaps.push(next.col - step.col);
  });
  gaps.sort((a, b) => a - b);
  const unit = gaps[(gaps.length - 1) >> 1] || 1;
  steps.forEach((step, i) => {
    const next = steps[i + 1];
    const gap = next?.block === step.block ? next.col - step.col : unit;
    step.duration = Math.min(4, Math.max(0.5, Math.round((gap / unit) * 2) / 2));
  });
}

// Cada valor es una nota; `r` delante es un silencio, que alarga la nota anterior. Los silencios antes de la primera nota se ignoran.
function readRhythm(text) {
  const items = [];
  for (const token of text.trim().split(/\s+/)) {
    const match = token.match(RHYTHM_TOKEN);
    if (!match) return { error: token };
    const value = VALUE_IN_EIGHTHS[match[2]] * (match[3] ? 1.5 : 1);
    items.push({ rest: match[1] !== '', value });
  }
  return { items, notes: items.filter((item) => !item.rest).length };
}

function applyRhythm(own, items) {
  let index = -1;
  for (const item of items) {
    if (item.rest) {
      if (index >= 0) own[index].duration += item.value;
    } else {
      own[++index].duration = item.value;
    }
  }
}

export function parseTab(text) {
  const steps = [];
  const rhythmLines = [];
  let labels = null;
  let section = '';
  let run = [];
  let blockCount = 0;

  const flush = () => {
    for (let i = 0; i + 6 <= run.length; i += 6) {
      const block = blockToSteps(run.slice(i, i + 6), section, blockCount++);
      steps.push(...block.steps);
      if (!labels && block.labels.every(Boolean)) labels = block.labels;
    }
    run = [];
  };

  for (const line of text.split(/\r?\n/)) {
    const tabLine = parseTabLine(line);
    if (tabLine) {
      run.push(tabLine);
      continue;
    }
    flush();
    // Va antes que SECTION: «Ritmo: …» y «BPM: …» también encajan allí.
    const rhythm = line.match(RHYTHM_LINE);
    if (rhythm) {
      rhythmLines.push({ block: blockCount - 1, text: rhythm[1] });
      continue;
    }
    const heading = line.match(SECTION);
    if (heading) section = (heading[1] ?? heading[2] ?? heading[3] ?? heading[4]).replaceAll('*', '').trim();
  }
  flush();
  assignDurations(steps);

  // Un ritmo que no cuadra con sus notas se descarta entero: mejor la separación del tab que un ritmo desplazado.
  const rhythmErrors = [];
  let rhythmBlocks = 0;
  for (const { block, text: value } of rhythmLines) {
    const label = `bloque ${block + 1}`;
    if (block < 0) {
      rhythmErrors.push('hay una línea de ritmo antes de ningún tab');
      continue;
    }
    const parsed = readRhythm(value);
    if (parsed.error) {
      rhythmErrors.push(`${label}: «${parsed.error}» no es un valor (usa 1, 2, 4, 8, 16, con punto o r delante)`);
      continue;
    }
    const own = steps.filter((step) => step.block === block);
    if (parsed.notes !== own.length) {
      rhythmErrors.push(`${label}: ${parsed.notes} valores para ${own.length} notas`);
      continue;
    }
    applyRhythm(own, parsed.items);
    rhythmBlocks++;
  }

  const capo = text.match(/capo\D{0,12}(\d{1,2})/i);
  const tempo = text.match(TEMPO);
  const bpm = tempo && Number(tempo[1]) >= MIN_BPM && Number(tempo[1]) <= MAX_BPM ? Number(tempo[1]) : null;
  return { steps, labels, capo: capo ? Number(capo[1]) : null, bpm, rhythmBlocks, rhythmErrors };
}

export function detectTuning(labels) {
  if (!labels) return null;
  const key = labels.map((l) => l[0].toUpperCase() + l.slice(1)).join('');
  return TUNINGS.find((tuning) => tuning.keys.includes(key)) ?? null;
}
