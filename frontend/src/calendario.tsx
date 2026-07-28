import { useState } from 'react';
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

interface CalendarioProps {
  patients: Patient[];
  onSelectPatient: (id: number) => void;
  seleccionada: number | null;
}

type Mode = 'mes' | 'semana' | 'agenda';

export default function Calendario({ patients, onSelectPatient, seleccionada }: CalendarioProps) {
  const [modo, setModo] = useState<Mode>('mes');
  const [refFecha, setRefFecha] = useState<Date>(() => {
    const d = new Date();
    return new Date(Date.UTC(d.getFullYear(), d.getMonth(), 1));
  });

  // Filter patients that have a scheduled next control
  const patientsConCita = patients.filter((p) => p.proximo_control);

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
          const citas = patientsConCita.filter((p) => p.proximo_control === isoStr);
          const esHoy = new Date().toISOString().slice(0, 10) === isoStr;

          return (
            <div key={isoStr} className={`cal-dia-celda ${esHoy ? 'cal-dia-celda--hoy' : ''}`}>
              <span className="cal-dia-numero">{dia.getUTCDate()}</span>
              <div className="cal-dia-citas">
                {citas.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    className={`cal-cita-badge cal-cita-badge--${p.estado_actual.toLowerCase()} ${seleccionada === p.id ? 'cal-cita-badge--seleccionada' : ''}`}
                    onClick={() => onSelectPatient(p.id)}
                    title={p.nombres}
                  >
                    {p.nombres.split(' ')[0]}
                  </button>
                ))}
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
          const citas = patientsConCita.filter((p) => p.proximo_control === isoStr);
          const esHoy = new Date().toISOString().slice(0, 10) === isoStr;

          return (
            <div key={isoStr} className={`cal-semana-columna ${esHoy ? 'cal-semana-columna--hoy' : ''}`}>
              <div className="cal-semana-dia-cabecera">
                <span className="rotulo">{diasSemanaNombres[idx]}</span>
                <span className="cal-semana-dia-numero">{dia.getUTCDate()}</span>
              </div>
              <div className="cal-semana-citas">
                {citas.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    className={`cal-cita-tarjeta cal-cita-tarjeta--${p.estado_actual.toLowerCase()} ${seleccionada === p.id ? 'cal-cita-tarjeta--seleccionada' : ''}`}
                    onClick={() => onSelectPatient(p.id)}
                  >
                    <span className="cal-cita-paciente">{p.nombres}</span>
                    <span className="cal-cita-estado rotulo">{p.estado_actual}</span>
                  </button>
                ))}
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
    const citasMes = patientsConCita
      .filter((p) => {
        const d = aDia(p.proximo_control);
        return d && d.getUTCMonth() === mes && d.getUTCFullYear() === anio;
      })
      .sort((a, b) => (a.proximo_control || '').localeCompare(b.proximo_control || ''));

    if (citasMes.length === 0) {
      return (
        <div className="cal-agenda-vacio">
          <p>No hay controles de seguimiento programados para este mes.</p>
        </div>
      );
    }

    return (
      <div className="cal-agenda-lista">
        {citasMes.map((p) => (
          <button
            key={p.id}
            type="button"
            className={`cal-agenda-item ${seleccionada === p.id ? 'cal-agenda-item--seleccionada' : ''}`}
            onClick={() => onSelectPatient(p.id)}
          >
            <div className="cal-agenda-fecha cifra">{fecha(p.proximo_control)}</div>
            <div className="cal-agenda-paciente">
              <span className="cal-agenda-nombre">{p.nombres}</span>
              <span className="cal-agenda-meta">
                DNI {p.dni} {p.historia_clinica ? `· HC ${p.historia_clinica}` : ''}
              </span>
            </div>
            <div className="cal-agenda-estado">
              <span className={`badge-estado badge-estado--${p.estado_actual.toLowerCase()}`}>
                {p.estado_actual}
              </span>
            </div>
          </button>
        ))}
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
