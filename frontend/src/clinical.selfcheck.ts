import assert from 'node:assert/strict';
import {
  aDia,
  avanceVentana,
  consecuencia,
  diasEntre,
  fecha,
  fueraDeRango,
  hoyUTC,
  obtenerResultados,
  seguimiento,
  textoSenal,
} from './clinical.ts';

const HOY = new Date(Date.UTC(2026, 6, 28)); // 28/07/2026

// --- aDia: acepta lo que manda el backend, rechaza lo que rompía antes ---
assert.equal(aDia('2024-02-14T00:00:00Z')?.toISOString(), '2024-02-14T00:00:00.000Z');
assert.equal(aDia('2024-02-14')?.toISOString(), '2024-02-14T00:00:00.000Z');
assert.equal(aDia('14/02/2024'), null, 'el formato peruano no es ISO y debe rechazarse, no producir Invalid Date');
assert.equal(aDia(null), null);
assert.equal(aDia(''), null);

// --- fecha: nunca imprime "Invalid Date" ---
assert.equal(fecha('2024-02-14T00:00:00Z'), '14/02/2024');
assert.equal(fecha('2024-12-01'), '01/12/2024');
assert.equal(fecha(null), '—');
assert.equal(fecha('14/02/2024'), '—');
assert.ok(!fecha('cualquier cosa').includes('Invalid'));

// --- diasEntre ---
assert.equal(diasEntre(new Date(Date.UTC(2026, 6, 28)), new Date(Date.UTC(2026, 6, 30))), 2);
assert.equal(diasEntre(new Date(Date.UTC(2026, 6, 30)), new Date(Date.UTC(2026, 6, 28))), -2);
// Cruce de horario de verano: sigue siendo un número entero de días.
assert.equal(diasEntre(new Date(Date.UTC(2026, 2, 1)), new Date(Date.UTC(2026, 3, 1))), 31);

// --- seguimiento: el cálculo que decide a quién llamar hoy ---
assert.deepEqual(seguimiento('Activa', '2026-05-02', HOY), { clase: 'vencida', dias: 87 });
assert.deepEqual(seguimiento('Activa', '2026-07-28', HOY), { clase: 'proxima', dias: 0 }, 'el control de hoy no está vencido todavía');
assert.deepEqual(seguimiento('Activa', '2026-07-27', HOY), { clase: 'vencida', dias: 1 });
assert.deepEqual(seguimiento('Activa', '2026-08-27', HOY), { clase: 'proxima', dias: 30 }, 'el borde del horizonte sigue siendo próximo');
assert.deepEqual(seguimiento('Activa', '2026-08-28', HOY), { clase: 'programada', dias: 31 });

// Una paciente sin reloj corriendo nunca puede figurar como vencida.
assert.deepEqual(seguimiento('Pausada', '2020-01-01', HOY), { clase: 'suspendido' });
assert.deepEqual(seguimiento('Derivada', '2020-01-01', HOY), { clase: 'cerrado' });
assert.deepEqual(seguimiento('Cerrada', '2020-01-01', HOY), { clase: 'cerrado' });
assert.deepEqual(seguimiento('Activa', null, HOY), { clase: 'sin-programar' });

// --- textoSenal: el color nunca viaja solo ---
assert.equal(textoSenal(seguimiento('Activa', '2026-05-02', HOY)), 'Vencida hace 87 días');
assert.equal(textoSenal(seguimiento('Activa', '2026-07-27', HOY)), 'Vencida hace 1 día');
assert.equal(textoSenal(seguimiento('Activa', '2026-07-28', HOY)), 'Control hoy');
assert.equal(textoSenal(seguimiento('Activa', '2026-07-29', HOY)), 'En 1 día');
assert.equal(textoSenal(seguimiento('Pausada', null, HOY)), 'Suspendido por gestación');

// --- avanceVentana: la barra de rango de referencia ---
// Ventana de un año, hoy justo a la mitad.
assert.equal(avanceVentana('2026-01-28', '2027-01-28', HOY), 181 / 365);
// Hoy exactamente el día del control: el marcador toca el límite del rango.
assert.equal(avanceVentana('2025-07-28', '2026-07-28', HOY), 1);
// Vencida: se sale del rango de referencia, que es la señal.
assert.ok((avanceVentana('2025-05-02', '2026-05-02', HOY) ?? 0) > 1);
// Sin ventana medible.
assert.equal(avanceVentana(null, '2026-07-28', HOY), null);
assert.equal(avanceVentana('2026-07-28', null, HOY), null);
assert.equal(avanceVentana('2026-07-28', '2026-07-28', HOY), null, 'un intervalo de cero días no se puede dibujar');

// --- consecuencia: lo que el backend hará, dicho antes de guardar ---
assert.ok(consecuencia('Colposcopia', 'GESTANDO')?.includes('42 días'));
assert.ok(consecuencia('Colposcopia', 'NORMAL')?.includes('12 meses'));
assert.ok(consecuencia('Control', 'NIC I')?.includes('6 meses'));
assert.ok(consecuencia('Molecular', 'NEGATIVO')?.includes('alta médica'));
assert.ok(consecuencia('Biopsia', 'CÁNCER')?.includes('IREN'));
assert.ok(consecuencia('Control', 'NO ACUDIÓ')?.includes('vencida'));

// --- fueraDeRango ---
assert.equal(fueraDeRango('NORMAL'), false);
assert.equal(fueraDeRango('NEGATIVO'), false);
assert.equal(fueraDeRango('NIC I'), true);
assert.equal(fueraDeRango('POSITIVO'), true);
assert.equal(fueraDeRango('CÁNCER'), true);
assert.equal(fueraDeRango(null), false);

// hoyUTC toma el día del calendario local (para la obstetra "hoy" es su fecha, no la UTC)
// y lo trunca a medianoche, si no las comparaciones de arriba se desfasan por la hora.
const tarde = new Date('2026-07-28T23:45:00-05:00');
const truncado = hoyUTC(tarde);
assert.equal(truncado.getUTCHours(), 0);
assert.equal(truncado.getUTCMinutes(), 0);
assert.equal(truncado.getUTCDate(), tarde.getDate());
assert.equal(truncado.getUTCMonth(), tarde.getMonth());
assert.equal(truncado.getUTCFullYear(), tarde.getFullYear());

// --- obtenerResultados ---
assert.deepEqual(obtenerResultados('Colposcopia'), ['NORMAL', 'NIC I', 'NIC II', 'NIC III', 'POSITIVO', 'GESTANDO', 'NO ACUDIÓ']);
assert.deepEqual(obtenerResultados('Control 1'), ['NORMAL', 'NIC I', 'NIC II', 'NIC III', 'POSITIVO', 'GESTANDO', 'NO ACUDIÓ']);
assert.deepEqual(obtenerResultados('Control 2'), ['NORMAL', 'NIC I', 'NIC II', 'NIC III', 'POSITIVO', 'GESTANDO', 'NO ACUDIÓ']);
assert.deepEqual(obtenerResultados('CONTROL DE SEGUIMIENTO'), ['NORMAL', 'NIC I', 'NIC II', 'NIC III', 'POSITIVO', 'GESTANDO', 'NO ACUDIÓ']);
assert.deepEqual(obtenerResultados('Colposcopía'), ['NORMAL', 'NIC I', 'NIC II', 'NIC III', 'POSITIVO', 'GESTANDO', 'NO ACUDIÓ']);
assert.deepEqual(obtenerResultados('AlgoInexistente'), ['NORMAL', 'NEGATIVO', 'POSITIVO', 'NO ACUDIÓ']);
assert.deepEqual(obtenerResultados(null), ['NORMAL', 'NEGATIVO', 'POSITIVO', 'NO ACUDIÓ']);

console.log('clinical.ts OK');
