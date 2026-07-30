import { useState, useEffect } from 'react';
import { ChevronLeft, ChevronRight, Calendar as CalendarIcon } from 'lucide-react';
import { aDia, fecha } from './clinical';

interface Patient {
  id: number;
  dni: string;
  nombres: string;
  historia_clinica: string | null;
  estado_actual: string;
  fecha_registro: string;
  ultimo_evento?: string | null;
  proximo_control?: string | null;
}

export interface CalendarItem {
  origin: 'evento' | 'tratamiento';
  id: number;
  paciente_id: number;
  paciente_nombres: string;
  tipo: string;
  fecha: string; // YYYY-MM-DD
  resultado: string;
  observaciones: string;
  estado_actual: string;
}

interface CalendarioProps {
  patients: Patient[];
  onSelectPatient: (id: number) => void;
  seleccionada: number | null;
  filtroAnio?: string;
  items: CalendarItem[];
}

type Mode = 'mes' | 'semana' | 'agenda';

export default function Calendario({ patients, onSelectPatient, seleccionada, filtroAnio, items = [] }: CalendarioProps) {
  const [modo, setModo] = useState<Mode>('mes');
  const [refFecha, setRefFecha] = useState<Date>(() => {
    const d = new Date();
    return new Date(Date.UTC(d.getFullYear(), d.getMonth(), 1));
  });

  // If user filters by a specific year, make the calendar jump to that year
  useEffect(() => {
    if (filtroAnio) {
      const targetYear = parseInt(filtroAnio, 10);
      if (!isNaN(targetYear) && refFecha.getUTCFullYear() !== targetYear) {
        setRefFecha((prev) => {
          const next = new Date(prev.getTime());
          next.setUTCFullYear(targetYear);
          return next;
        });
      }
    }
  }, [filtroAnio, refFecha]);

  const virtualControls: CalendarItem[] = patients
    .filter(p => p.proximo_control)
    .map(p => ({
      origin: 'evento',
      id: -p.id,
      paciente_id: p.id,
      paciente_nombres: p.nombres,
      tipo: 'Control Programado',
      fecha: p.proximo_control!,
      resultado: 'PROGRAMADO',
      observaciones: '',
      estado_actual: p.estado_actual
    }));

  // Combine both actual events/treatments and virtual scheduled controls
  const todosLosEventos = [...items, ...virtualControls];

  const eventsFormatted = todosLosEventos.map(item => ({
    ...item,
    fechaDia: item.fecha.slice(0, 10)
  }));

  // Helper to color code calendar items according to their type and results
  const getEstiloCita = (tipo: string, resultado: string) => {
    const t = tipo.toUpperCase();
    const r = (resultado || '').toUpperCase();

    // Treatments -> Soft Purple
    if (
      t.includes('CRIOTERAPIA') ||
      t.includes('TERMOCOAGULACION') ||
      t.includes('CONIZACION') ||
      t.includes('LEEP') ||
      t.includes('HISTERECTOMIA') ||
      t.includes('TRATAMIENTO')
    ) {
      return {
        background: 'var(--pausa-papel)',
        borderColor: 'var(--pausa)',
        color: 'var(--pausa)',
      };
    }

    // Abnormal/Positive results -> Soft Red
    if (
      r.includes('POSITIVO') ||
      r.includes('ALTERADO') ||
      r.includes('NIC') ||
      r.includes('CÁNCER') ||
      r.includes('CANCER') ||
      r.includes('LESION') ||
      r.includes('LESIÓN') ||
      r.includes('AGUS') ||
      r.includes('HSIL') ||
      r.includes('LSIL') ||
      r.includes('ASC-US') ||
      r.includes('ASC-H')
    ) {
      return {
        background: 'var(--senal-papel)',
        borderColor: 'var(--senal)',
        color: 'var(--senal)',
      };
    }

    // Normal/Negative results -> Soft Green
    if (r.includes('NORMAL') || r.includes('NEGATIVO') || r.includes('SANO')) {
      return {
        background: 'color-mix(in srgb, var(--rango) 10%, #ffffff)',
        borderColor: 'var(--rango)',
        color: 'var(--rango)',
      };
    }

    // Controls & Referrals -> Neutral/Blue
    return {
      background: 'var(--papel)',
      borderColor: 'var(--regla-fuerte)',
      color: 'var(--tinta)',
    };
  };

  // Helper to change reference date
  const navegar = (direccion: number) => {
    setRefFecha((prev) => {
      const next = new Date(prev.getTime());
      if (modo === 'mes') {
        next.setUTCMonth(next.getUTCMonth() + direccion);
      } else if (modo === 'semana') {
        next.setUTCDate(next.getUTCDate() + direccion * 7);
      } else {
        next.setUTCMonth(next.getUTCMonth() + direccion);
      }
      return next;
    });
  };

  // Render header controls
  const renderCabecera = () => {
    let titulo = '';
    if (modo === 'mes' || modo === 'agenda') {
      titulo = refFecha.toLocaleDateString('es-PE', { month: 'long', year: 'numeric', timeZone: 'UTC' });
    } else {
      // Week start and end dates
      const start = getInicioSemana(refFecha);
      const end = new Date(start.getTime());
      end.setUTCDate(end.getUTCDate() + 6);
      titulo = `${start.getUTCDate()} - ${end.getUTCDate()} de ${start.toLocaleDateString('es-PE', { month: 'short', year: 'numeric', timeZone: 'UTC' })}`;
    }

    return (
      <div className="cal-header">
        <div className="cal-titulo">
          <CalendarIcon size={18} aria-hidden="true" />
          <span className="cal-fecha-titulo">{titulo}</span>
        </div>

        <div className="cal-nav">
          <button type="button" className="btn btn--icono" onClick={() => navegar(-1)} aria-label="Anterior">
            <ChevronLeft size={16} />
          </button>
          <button type="button" className="btn" onClick={() => setRefFecha(new Date())}>Hoy</button>
          <button type="button" className="btn btn--icono" onClick={() => navegar(1)} aria-label="Siguiente">
            <ChevronRight size={16} />
          </button>
        </div>

        <div className="cal-modos">
          <button
            type="button"
            className={`btn-modo ${modo === 'mes' ? 'btn-modo--activo' : ''}`}
            onClick={() => setModo('mes')}
          >
            Mes
          </button>
          <button
            type="button"
            className={`btn-modo ${modo === 'semana' ? 'btn-modo--activo' : ''}`}
            onClick={() => setModo('semana')}
          >
            Semana
          </button>
          <button
            type="button"
            className={`btn-modo ${modo === 'agenda' ? 'btn-modo--activo' : ''}`}
            onClick={() => setModo('agenda')}
          >
            Agenda
          </button>
        </div>
      </div>
    );
  };

  // Helper calculations for calendar views
  const getInicioSemana = (d: Date): Date => {
    const date = new Date(d.getTime());
    const day = date.getUTCDay();
    const diff = date.getUTCDate() - day + (day === 0 ? -6 : 1); // adjust when day is sunday
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), diff));
  };

  // View: Monthly Grid
  const renderMes = () => {
    const mes = refFecha.getUTCMonth();
    const anio = refFecha.getUTCFullYear();

    // Find start day of the month (0 = Sun, 1 = Mon...)
    const primerDia = new Date(Date.UTC(anio, mes, 1));
    let diaSemana = primerDia.getUTCDay();
    diaSemana = diaSemana === 0 ? 6 : diaSemana - 1; // start on Monday

    const diasMes = new Date(Date.UTC(anio, mes + 1, 0)).getUTCDate();
    const cuadricula: (Date | null)[] = [];

    // Empty spaces before first day
    for (let i = 0; i < diaSemana; i++) {
      cuadricula.push(null);
    }

    // Days of the month
    for (let d = 1; d <= diasMes; d++) {
      cuadricula.push(new Date(Date.UTC(anio, mes, d)));
    }

    const diasSemanaNombres = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];

    return (
      <div className="cal-mes-grid">
        {diasSemanaNombres.map((name) => (
          <div key={name} className="cal-dia-semana-nombre rotulo">{name}</div>
        ))}
        {cuadricula.map((dia, idx) => {
          if (!dia) return <div key={`empty-${idx}`} className="cal-dia-celda cal-dia-celda--vacio" />;

          const isoStr = dia.toISOString().slice(0, 10);
          const citas = eventsFormatted.filter((item) => item.fechaDia === isoStr);
          const esHoy = new Date().toISOString().slice(0, 10) === isoStr;

          return (
            <div key={isoStr} className={`cal-dia-celda ${esHoy ? 'cal-dia-celda--hoy' : ''}`}>
              <span className="cal-dia-numero">{dia.getUTCDate()}</span>
              <div className="cal-dia-citas">
                {citas.map((item) => {
                  const estilo = getEstiloCita(item.tipo, item.resultado);
                  const shortName = item.paciente_nombres.split(' ')[0];
                  return (
                    <button
                      key={`${item.origin}-${item.id}`}
                      type="button"
                      className={`cal-cita-badge ${seleccionada === item.paciente_id ? 'cal-cita-badge--seleccionada' : ''}`}
                      onClick={() => onSelectPatient(item.paciente_id)}
                      title={`${item.paciente_nombres} - ${item.tipo}: ${item.resultado}`}
                      style={estilo}
                    >
                      {shortName}: {item.tipo} ({item.resultado})
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    );
  };

  // View: Weekly Grid
  const renderSemana = () => {
    const inicio = getInicioSemana(refFecha);
    const diasSemana: Date[] = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(inicio.getTime());
      d.setUTCDate(d.getUTCDate() + i);
      diasSemana.push(d);
    }

    const diasSemanaNombres = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'];

    return (
      <div className="cal-semana-grid">
        {diasSemana.map((dia, idx) => {
          const isoStr = dia.toISOString().slice(0, 10);
          const citas = eventsFormatted.filter((item) => item.fechaDia === isoStr);
          const esHoy = new Date().toISOString().slice(0, 10) === isoStr;

          return (
            <div key={isoStr} className={`cal-semana-columna ${esHoy ? 'cal-semana-columna--hoy' : ''}`}>
              <div className="cal-semana-dia-cabecera">
                <span className="rotulo">{diasSemanaNombres[idx]}</span>
                <span className="cal-semana-dia-numero">{dia.getUTCDate()}</span>
              </div>
              <div className="cal-semana-citas">
                {citas.map((item) => {
                  const estilo = getEstiloCita(item.tipo, item.resultado);
                  return (
                    <button
                      key={`${item.origin}-${item.id}`}
                      type="button"
                      className={`cal-cita-tarjeta ${seleccionada === item.paciente_id ? 'cal-cita-tarjeta--seleccionada' : ''}`}
                      onClick={() => onSelectPatient(item.paciente_id)}
                      style={estilo}
                    >
                      <span className="cal-cita-paciente" style={{ fontWeight: 'bold' }}>{item.paciente_nombres}</span>
                      <span className="cal-cita-tipo" style={{ fontSize: '0.75rem', opacity: 0.9 }}>{item.tipo}</span>
                      <span className="cal-cita-resultado rotulo" style={{ display: 'inline-block', marginTop: '2px', fontSize: '0.6875rem', letterSpacing: '0.05em' }}>{item.resultado}</span>
                    </button>
                  );
                })}
                {citas.length === 0 && (
                  <span className="cal-semana-vacio">Sin controles</span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    );
  };

  // View: Agenda List
  const renderAgenda = () => {
    const mes = refFecha.getUTCMonth();
    const anio = refFecha.getUTCFullYear();

    // Filter appointments belonging to the reference month
    const citasMes = eventsFormatted
      .filter((item) => {
        const d = aDia(item.fechaDia);
        return d && d.getUTCMonth() === mes && d.getUTCFullYear() === anio;
      })
      .sort((a, b) => a.fechaDia.localeCompare(b.fechaDia));

    if (citasMes.length === 0) {
      return (
        <div className="cal-agenda-vacio">
          <p>No hay eventos o controles programados para este mes.</p>
        </div>
      );
    }

    return (
      <div className="cal-agenda-lista">
        {citasMes.map((item) => {
          const estilo = getEstiloCita(item.tipo, item.resultado);
          return (
            <button
              key={`${item.origin}-${item.id}`}
              type="button"
              className={`cal-agenda-item ${seleccionada === item.paciente_id ? 'cal-agenda-item--seleccionada' : ''}`}
              onClick={() => onSelectPatient(item.paciente_id)}
              style={{
                borderLeft: `4px solid ${estilo.borderColor}`,
                background: estilo.background,
                color: estilo.color,
                marginBottom: '0.5rem',
                padding: '0.75rem',
                textAlign: 'left',
                display: 'flex',
                alignItems: 'center',
                width: '100%'
              }}
            >
              <div className="cal-agenda-fecha cifra" style={{ marginRight: '1rem', fontWeight: 'bold' }}>
                {fecha(item.fechaDia)}
              </div>
              <div className="cal-agenda-paciente" style={{ flex: 1 }}>
                <span className="cal-agenda-nombre" style={{ display: 'block', fontWeight: 'bold' }}>{item.paciente_nombres}</span>
                <span className="cal-agenda-meta" style={{ fontSize: '0.75rem', opacity: 0.8 }}>
                  {item.tipo} {item.resultado ? `· ${item.resultado}` : ''}
                </span>
              </div>
              <div className="cal-agenda-estado">
                <span className="badge-estado" style={{ background: estilo.borderColor, color: '#fff', fontSize: '0.6875rem', padding: '2px 6px', borderRadius: '3px' }}>
                  {item.estado_actual}
                </span>
              </div>
            </button>
          );
        })}
      </div>
    );
  };

  return (
    <div className="cal-contenedor">
      {renderCabecera()}
      <div className="cal-cuerpo">
        {modo === 'mes' && renderMes()}
        {modo === 'semana' && renderSemana()}
        {modo === 'agenda' && renderAgenda()}
      </div>
    </div>
  );
}
