export type Seguimiento =
  | { clase: 'vencida'; dias: number }
  | { clase: 'proxima'; dias: number }
  | { clase: 'programada'; dias: number }
  | { clase: 'suspendido' }
  | { clase: 'cerrado' }
  | { clase: 'sin-programar' };

const MS_DIA = 86_400_000;
export function aDia(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Hoy, truncado a día UTC, para comparar contra fechas sin hora. */
export function hoyUTC(ahora: Date = new Date()): Date {
  return new Date(Date.UTC(ahora.getFullYear(), ahora.getMonth(), ahora.getDate()));
}

/** Días enteros de `a` a `b`. Positivo si `b` es posterior. */
export function diasEntre(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / MS_DIA);
}

/** dd/mm/aaaa, o guion largo cuando no hay fecha. */
export function fecha(iso: string | null | undefined): string {
  const d = aDia(iso);
  if (!d) return '—';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`;
}

/** Ventana en la que un control por vencer se considera "próximo". */
export const HORIZONTE_PROXIMO = 30;

export function seguimiento(
  estadoActual: string,
  proximoControl: string | null | undefined,
  hoy: Date = hoyUTC(),
): Seguimiento {
  // Una paciente pausada o fuera del programa no puede estar vencida: no hay reloj corriendo.
  if (estadoActual === 'Pausada') return { clase: 'suspendido' };
  if (estadoActual === 'Derivada' || estadoActual === 'Cerrada') return { clase: 'cerrado' };

  const prox = aDia(proximoControl);
  if (!prox) return { clase: 'sin-programar' };

  const dias = diasEntre(hoy, prox);
  if (dias < 0) return { clase: 'vencida', dias: -dias };
  if (dias <= HORIZONTE_PROXIMO) return { clase: 'proxima', dias };
  return { clase: 'programada', dias };
}

export function avanceVentana(
  ultimoEvento: string | null | undefined,
  proximoControl: string | null | undefined,
  hoy: Date = hoyUTC(),
): number | null {
  const ini = aDia(ultimoEvento);
  const fin = aDia(proximoControl);
  if (!ini || !fin) return null;

  const intervalo = diasEntre(ini, fin);
  if (intervalo <= 0) return null;

  return diasEntre(ini, hoy) / intervalo;
}

/** Texto de la señal que acompaña siempre al color, para que el color nunca sea el único canal. */
export function textoSenal(s: Seguimiento): string {
  switch (s.clase) {
    case 'vencida':
      return `Vencida hace ${s.dias} ${s.dias === 1 ? 'día' : 'días'}`;
    case 'proxima':
      return s.dias === 0 ? 'Control hoy' : `En ${s.dias} ${s.dias === 1 ? 'día' : 'días'}`;
    case 'programada':
      return `En ${s.dias} días`;
    case 'suspendido':
      return 'Suspendido por gestación';
    case 'cerrado':
      return 'Fuera de seguimiento';
    case 'sin-programar':
      return 'Sin control programado';
  }
}

// --- Vocabulario clínico -----------------------------------------------------

export const TIPOS_EVENTO = [
  { valor: 'Colposcopia', etiqueta: 'Colposcopía' },
  { valor: 'Control', etiqueta: 'Control de seguimiento' },
  { valor: 'Biopsia', etiqueta: 'Biopsia' },
  { valor: 'Molecular', etiqueta: 'Prueba molecular VPH' },
  { valor: 'Referencia', etiqueta: 'Referencia' },
] as const;

/** Resultados admitidos por tipo de evento. Texto libre era lo que producía "NIC1" y "Nornal". */
export const RESULTADOS: Record<string, string[]> = {
  Colposcopia: ['NORMAL', 'NIC I', 'NIC II', 'NIC III', 'POSITIVO', 'GESTANDO', 'NO ACUDIÓ'],
  Control: ['NORMAL', 'NIC I', 'NIC II', 'NIC III', 'POSITIVO', 'GESTANDO', 'NO ACUDIÓ'],
  Biopsia: ['NEGATIVO', 'POSITIVO', 'CÁNCER', 'NO ACUDIÓ'],
  Molecular: ['NEGATIVO', 'POSITIVO', 'NO ACUDIÓ'],
  Referencia: ['REFERIDA', 'ATENDIDA', 'NO ACUDIÓ'],
};

/** Consecuencia que el backend aplicará, mostrada antes de guardar para que no sorprenda. */
export function consecuencia(tipo: string, resultado: string): string | null {
  const r = resultado.toUpperCase();
  if (r === 'GESTANDO') {
    return 'Pausa el seguimiento y exige la fecha probable de parto. Los controles se reanudan 42 días después del parto.';
  }
  if (tipo === 'Molecular' && r === 'NEGATIVO') {
    return 'Cierra el caso por alta médica: la paciente sale de la cohorte VPH(+).';
  }
  if (tipo === 'Biopsia' && r === 'CÁNCER') {
    return 'Deriva la paciente al IREN y cesa el seguimiento obstétrico local.';
  }
  if (r === 'NORMAL' || r === 'NEGATIVO') return 'Programa el siguiente control a 12 meses.';
  if (r === 'POSITIVO' || r.startsWith('NIC')) return 'Programa el siguiente control a 6 meses.';
  if (r === 'NO ACUDIÓ') {
    return 'No reprograma nada: la paciente sigue contando como vencida hasta que se registre un resultado.';
  }
  return null;
}

/** Un resultado clínicamente anómalo se marca como fuera de rango en el informe. */
export function fueraDeRango(resultado: string | null | undefined): boolean {
  if (!resultado) return false;
  const r = resultado.toUpperCase();
  return r.includes('NIC') || r.includes('POSITIVO') || r.includes('CÁNCER') || r.includes('CANCER');
}
