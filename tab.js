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

function blockToSteps(block, section) {
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
      steps.push({ notes: [], section });
    }
    end = Math.max(end, col + width - 1);
    steps.at(-1).notes.push(note);
  }
  return { steps, labels: ordered.map((line) => line.label) };
}

export function parseTab(text) {
  const steps = [];
  let labels = null;
  let section = '';
  let run = [];

  const flush = () => {
    for (let i = 0; i + 6 <= run.length; i += 6) {
      const block = blockToSteps(run.slice(i, i + 6), section);
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
    const heading = line.match(SECTION);
    if (heading) section = (heading[1] ?? heading[2] ?? heading[3] ?? heading[4]).replaceAll('*', '').trim();
  }
  flush();

  const capo = text.match(/capo\D{0,12}(\d{1,2})/i);
  return { steps, labels, capo: capo ? Number(capo[1]) : null };
}

export function detectTuning(labels) {
  if (!labels) return null;
  const key = labels.map((l) => l[0].toUpperCase() + l.slice(1)).join('');
  return TUNINGS.find((tuning) => tuning.keys.includes(key)) ?? null;
}
