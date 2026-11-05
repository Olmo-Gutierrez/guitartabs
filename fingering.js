// Digitación sugerida: «un dedo por traste». La mano se coloca con el índice en un traste (posición)
// y cada dedo cubre el suyo. Las notas se agrupan en formas, y la mano solo se mueve entre una y otra.
const MAX_POSITION = 21;
const MAX_SHAPE_SPAN = 3;
// El meñique cuesta más: compensa mover la mano antes que dejarle una nota incómoda.
const FINGER_COST = [0, 0.05, 0.1, 1.5];
const STRETCH_COST = 3;
// Lo natural es que el índice pise el traste más bajo de la forma.
const INDEX_NOT_LOWEST_COST = 0.3;
const SHIFT_COST = 1.2;
const SHIFT_DISTANCE_COST = 0.1;

// Una forma acaba en una cuerda al aire (la mano queda libre), en un acorde o si no cabe en la mano.
function splitIntoShapes(steps) {
  const shapes = [];
  let shape = null;
  steps.forEach((step, index) => {
    const frets = step.notes.map((note) => note.fret).filter(Boolean);
    if (shape) {
      const all = [...shape.frets, ...frets];
      if (Math.max(...all) - Math.min(...all) > MAX_SHAPE_SPAN) shape = null;
    }
    if (!shape) {
      shape = { first: index, frets: [] };
      shapes.push(shape);
    }
    shape.frets.push(...frets);
    shape.last = index;
    if (step.notes.length > 1 || step.notes.some((note) => note.fret === 0)) shape = null;
  });
  return shapes;
}

function positionCost(frets, position) {
  let cost = frets.length && Math.min(...frets) !== position ? INDEX_NOT_LOWEST_COST : 0;
  for (const fret of frets) {
    const index = fret - position;
    if (index >= 0 && index <= 3) cost += FINGER_COST[index];
    else cost += STRETCH_COST * (index < 0 ? -index : index - 3);
  }
  return cost;
}

function shiftCost(from, to) {
  return from === to ? 0 : SHIFT_COST + SHIFT_DISTANCE_COST * Math.abs(from - to);
}

// Elige la posición de cada forma minimizando incomodidad y movimientos de la mano.
function bestPositions(shapes) {
  const positions = Array.from({ length: MAX_POSITION }, (_, i) => i + 1);
  // Entre posiciones igual de cómodas, la más baja.
  let totals = positions.map((p) => 0.001 * p);
  const cameFrom = shapes.map((shape, i) => {
    const previous = totals;
    const origins = [];
    totals = positions.map((p, pIndex) => {
      let best = previous[pIndex];
      let bestFrom = pIndex;
      if (i > 0) {
        previous.forEach((cost, fromIndex) => {
          const total = cost + shiftCost(positions[fromIndex], p);
          if (total < best) {
            best = total;
            bestFrom = fromIndex;
          }
        });
      }
      origins.push(bestFrom);
      return best + positionCost(shape.frets, p);
    });
    return origins;
  });

  let index = totals.indexOf(Math.min(...totals));
  const result = new Array(shapes.length);
  for (let i = shapes.length - 1; i >= 0; i--) {
    result[i] = positions[index];
    index = cameFrom[i][index];
  }
  return result;
}

// Dentro de un acorde, un dedo solo puede pisar dos cuerdas si son contiguas y están en el mismo traste.
function fingerChord(notes, position) {
  const used = new Map();
  const lowToHigh = [...notes].sort((a, b) => b.string - a.string);
  for (const note of lowToHigh) {
    if (note.fret === 0) {
      note.finger = null;
      continue;
    }
    let finger = Math.max(1, Math.min(4, note.fret - position + 1));
    const fits = (f) => {
      const other = used.get(f);
      return !other || (other.fret === note.fret && other.string - note.string === 1);
    };
    while (finger < 4 && !fits(finger)) finger++;
    note.finger = finger;
    used.set(finger, note);
  }
}

export function assignFingers(steps) {
  const shapes = splitIntoShapes(steps);
  const positions = bestPositions(shapes);
  let previous = null;
  shapes.forEach((shape, shapeIndex) => {
    for (let i = shape.first; i <= shape.last; i++) {
      const step = steps[i];
      step.position = positions[shapeIndex];
      step.moved = step.position !== previous;
      previous = step.position;
      fingerChord(step.notes, step.position);
    }
  });
  return steps;
}

// Otra nota de la misma forma, en el mismo traste y en una cuerda contigua: ese dedo pisa las dos a la vez.
// Una cuerda al aire o un cambio de posición marcan dónde acaba la forma.
export function sharesFinger(steps, index, note, reach = 3) {
  if (note.finger === null) return false;
  const matches = (i) => steps[i].notes.some((n) => n.fret === note.fret && Math.abs(n.string - note.string) === 1);
  const sameShape = (i) => steps[i].position === steps[index].position && steps[i].notes.some((n) => n.fret > 0);
  for (const direction of [-1, 1]) {
    for (let i = index + direction, seen = 0; i >= 0 && i < steps.length && seen < reach; i += direction, seen++) {
      if (!sameShape(i)) break;
      if (matches(i)) return true;
    }
  }
  return false;
}

export const FINGER_NAMES = { 1: 'índice', 2: 'corazón', 3: 'anular', 4: 'meñique' };

// Patrón clásico de arpegio: el pulgar para los bordones y un dedo para cada cuerda aguda.
export const PLUCK_FINGER = { 6: 'pulgar', 5: 'pulgar', 4: 'pulgar', 3: 'índice', 2: 'corazón', 1: 'anular' };
