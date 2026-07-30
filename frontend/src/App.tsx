import React, { useCallback, useEffect, useRef, useState } from 'react';
import './App.css';
import { supabase } from './supabase';
import Calendario from './calendario';
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  ChevronRight,
  Plus,
  RotateCw,
  Search,
  Trash,
  X,
} from 'lucide-react';
import {
  RESULTADOS,
  TIPOS_EVENTO,
  avanceVentana,
  consecuencia,
  fecha,
  fueraDeRango,
  seguimiento,
  textoSenal,
  type Seguimiento,
} from './clinical';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:8080/api';

/** Posición del límite del rango dentro de la pista, deja sitio para dibujar lo vencido. */
const LIMITE = 0.72;

interface Patient {
  id: number;
  dni: string;
  nombres: string;
  historia_clinica: string | null;
  estado_actual: string;
  fecha_registro: string;
  ultimo_evento?: string | null;
  proximo_control?: string | null;
  cepa_vph?: string;
}

interface Contact {
  id: number;
  paciente_id: number;
  celular: string | null;
  direccion: string | null;
  distrito: string | null;
}

interface Pregnancy {
  id: number;
  paciente_id: number;
  fecha_probable_parto: string | null;
  fecha_nacimiento_real: string | null;
  fecha_fin_puerperio: string | null;
  activa: boolean;
}

interface ClinicalEvent {
  id: number;
  paciente_id: number;
  tipo_evento: string;
  fecha_evento: string | null;
  resultado: string | null;
  establecimiento: string | null;
  fecha_proximo_control: string | null;
  observaciones: string | null;
}

interface Treatment {
  id: number;
  paciente_id: number;
  tipo_tratamiento: string;
  fecha_tratamiento: string | null;
  ginecologo_responsable: string | null;
  observaciones: string | null;
}

interface PatientDetail {
  patient: Patient;
  contact?: Contact;
  gestaciones?: Pregnancy[];
  eventos?: ClinicalEvent[];
  tratamientos?: Treatment[];
}

const FILTROS = [
  { valor: '', etiqueta: 'Todas', senal: false },
  { valor: 'Activa', etiqueta: 'En seguimiento', senal: false },
  { valor: 'vencidas', etiqueta: 'Vencidas', senal: true },
  { valor: 'proximas', etiqueta: 'Próximos 30 días', senal: false },
  { valor: 'Pausada', etiqueta: 'Gestando', senal: false },
  { valor: 'Derivada', etiqueta: 'Derivadas', senal: false },
  { valor: 'Cerrada', etiqueta: 'Cerradas', senal: false },
] as const;

/** El cuerpo del error del backend viene como JSON {error}; si no, se usa tal cual. */
async function leerError(res: Response): Promise<string> {
  const texto = await res.text();
  try {
    const j = JSON.parse(texto);
    if (typeof j?.error === 'string') return j.error;
  } catch {
    /* no era JSON */
  }
  return texto.slice(0, 300) || `El servidor respondió ${res.status}.`;
}

// --- Diálogo con semántica y foco --------------------------------------------

function Dialogo({
  titulo,
  onCerrar,
  children,
}: {
  titulo: string;
  onCerrar: () => void;
  children: React.ReactNode;
}) {
  const caja = useRef<HTMLDivElement>(null);
  const previo = useRef<HTMLElement | null>(null);

  useEffect(() => {
    previo.current = document.activeElement as HTMLElement | null;
    const foco = caja.current?.querySelector<HTMLElement>(
      'input, select, textarea, button:not([data-cerrar])',
    );
    foco?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCerrar();
        return;
      }
      if (e.key !== 'Tab' || !caja.current) return;

      // Trampa de foco: sin esto se tabula a los controles que quedan bajo el velo.
      const focos = Array.from(
        caja.current.querySelectorAll<HTMLElement>(
          'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => !el.hasAttribute('disabled'));
      if (focos.length === 0) return;

      const primero = focos[0];
      const ultimo = focos[focos.length - 1];
      if (e.shiftKey && document.activeElement === primero) {
        e.preventDefault();
        ultimo.focus();
      } else if (!e.shiftKey && document.activeElement === ultimo) {
        e.preventDefault();
        primero.focus();
      }
    };

    document.addEventListener('keydown', onKey);
    const overflowPrevio = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflowPrevio;
      previo.current?.focus();
    };
  }, [onCerrar]);

  return (
    <div
      className="velo"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCerrar();
      }}
    >
      <div className="dialogo" role="dialog" aria-modal="true" aria-labelledby="dlg-titulo" ref={caja}>
        <div className="dialogo-cabecera">
          <h2 id="dlg-titulo">{titulo}</h2>
          <button type="button" className="dialogo-cerrar" onClick={onCerrar} aria-label="Cerrar" data-cerrar>
            <X size={20} aria-hidden="true" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

/** ¿Hay sitio para las dos columnas, o el informe se abre encima del registro? */
function useDosColumnas() {
  const consulta = '(min-width: 62.5rem)';
  const [ancha, setAncha] = useState(() => window.matchMedia(consulta).matches);
  useEffect(() => {
    const mq = window.matchMedia(consulta);
    const alCambiar = () => setAncha(mq.matches);
    mq.addEventListener('change', alCambiar);
    return () => mq.removeEventListener('change', alCambiar);
  }, []);
  return ancha;
}

// --- Barra de rango de referencia ---------------------------------------------

function BarraRango({ patient, estado }: { patient: Patient; estado: Seguimiento }) {
  const avance = avanceVentana(patient.ultimo_evento, patient.proximo_control);

  if (avance === null) {
    return <div className="rango rango--vacio" aria-hidden="true" />;
  }

  const tope = 1 / LIMITE;
  const ancho = Math.min(Math.max(avance, 0), tope) * LIMITE * 100;

  return (
    <div
      className={`rango${estado.clase === 'vencida' ? ' rango--fuera' : ''}`}
      aria-hidden="true"
      style={{ ['--avance' as string]: `${ancho}%`, ['--limite' as string]: `${LIMITE * 100}%` }}
    >
      <span className="rango-relleno" />
      <span className="rango-limite" />
    </div>
  );
}

// --- Fila del registro ---------------------------------------------------------

function Fila({
  patient,
  activa,
  onAbrir,
  seleccionado,
  onToggleSeleccion,
  modoExportar,
}: {
  patient: Patient;
  activa: boolean;
  onAbrir: () => void;
  seleccionado: boolean;
  onToggleSeleccion: (e: React.MouseEvent | React.ChangeEvent) => void;
  modoExportar: boolean;
}) {
  const estado = seguimiento(patient.estado_actual, patient.proximo_control);
  const texto = textoSenal(estado);
  const marca =
    estado.clase === 'vencida' ? '▲' : estado.clase === 'suspendido' ? '❙❙' : estado.clase === 'proxima' ? '●' : '·';

  return (
    <li className="registro-item">
      {modoExportar && (
        <div className="fila-check-container">
          <input
            type="checkbox"
            checked={seleccionado}
            onChange={onToggleSeleccion}
            onClick={(e) => e.stopPropagation()}
            aria-label={`Seleccionar a ${patient.nombres}`}
          />
        </div>
      )}
      <button
        type="button"
        className={`fila${estado.clase === 'vencida' ? ' fila--vencida' : ''}`}
        aria-current={activa ? 'true' : undefined}
        data-fila={patient.id}
        onClick={onAbrir}
      >
        <span className="fila-persona">
          <span className="fila-nombre">{patient.nombres}</span>
          <span className="fila-ident">
            DNI {patient.dni}
            {patient.historia_clinica && <span className="fila-hc"> · HC {patient.historia_clinica}</span>}
          </span>
        </span>

        {/* El rótulo se ve en columna estrecha y se vuelve solo-lector en ancha: sin él
            la fila se anunciaría como dos fechas sueltas, que es justo lo que hay que
            distinguir. */}
        <span className="fila-fechas">
          <span className="fila-fecha">
            <span className="fila-rotulo">Último evento: </span>
            <b>{fecha(patient.ultimo_evento)}</b>
          </span>
          <span className="fila-fecha">
            <span className="fila-rotulo">Próximo control: </span>
            <b>{fecha(patient.proximo_control)}</b>
          </span>
        </span>

        <BarraRango patient={patient} estado={estado} />

        <span className={`senal senal--${estado.clase}`}>
          <span className="senal-marca" aria-hidden="true">
            {marca}
          </span>
          {texto}
        </span>
      </button>
    </li>
  );
}

// --- Aplicación ----------------------------------------------------------------

export default function App() {
  const [session, setSession] = useState<{ access_token?: string } | null>(null);
  const [simulado, setSimulado] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [authError, setAuthError] = useState('');
  const [entrando, setEntrando] = useState(false);

  const [patients, setPatients] = useState<Patient[]>([]);
  const [busqueda, setBusqueda] = useState('');
  const [filtro, setFiltro] = useState<string>('');
  const [cargandoLista, setCargandoLista] = useState(true);
  const [falloLista, setFalloLista] = useState<string | null>(null);
  const [pulso, setPulso] = useState(0);

  const [seleccionada, setSeleccionada] = useState<number | null>(null);
  const [detalle, setDetalle] = useState<PatientDetail | null>(null);
  const [cargandoDetalle, setCargandoDetalle] = useState(false);
  const [falloDetalle, setFalloDetalle] = useState<string | null>(null);

  const [dialogo, setDialogo] = useState<'paciente' | 'evento' | 'tratamiento' | 'parto' | null>(null);
  const [guardando, setGuardando] = useState(false);
  const [errorForm, setErrorForm] = useState('');
  const [aviso, setAviso] = useState('');

  const [vista, setVista] = useState<'lista' | 'calendario'>('lista');
  const [filtroCepa, setFiltroCepa] = useState<string>('');
  const [filtroAnio, setFiltroAnio] = useState<string>('');
  const [tipoFecha, setTipoFecha] = useState<'proximo_control' | 'ultimo_evento' | 'fecha_registro'>('fecha_registro');
  const [itemsCalendario, setItemsCalendario] = useState<any[]>([]);
  const [editandoEvento, setEditandoEvento] = useState<ClinicalEvent | null>(null);
  const [editandoTratamiento, setEditandoTratamiento] = useState<Treatment | null>(null);
  const [filtrosAvanzadosAbiertos, setFiltrosAvanzadosAbiertos] = useState<boolean>(false);
  const [seleccionados, setSeleccionados] = useState<Set<number>>(new Set());
  const [modoExportar, setModoExportar] = useState<boolean>(false);
  const [mostrarConfirmarSalir, setMostrarConfirmarSalir] = useState<boolean>(false);
  const [pagina, setPagina] = useState<number>(1);
  const [itemsPorPagina, setItemsPorPagina] = useState<number>(10);
  const [editando, setEditando] = useState(false);
  const [editDni, setEditDni] = useState('');
  const [editNombres, setEditNombres] = useState('');
  const [editHistoria, setEditHistoria] = useState('');
  const [editEstado, setEditEstado] = useState('');
  const [editCelular, setEditCelular] = useState('');
  const [editDireccion, setEditDireccion] = useState('');
  const [editDistrito, setEditDistrito] = useState('');

  const dosColumnas = useDosColumnas();
  const cerrarInforme = useRef<HTMLButtonElement>(null);

  const [nuevaPaciente, setNuevaPaciente] = useState({
    dni: '',
    nombres: '',
    historia_clinica: '',
    celular: '',
    direccion: '',
    distrito: 'Porvenir',
    fecha_toma: '',
    resultado_vph: 'VPH Otros A/R',
    observaciones: '',
  });
  const [nuevoEvento, setNuevoEvento] = useState({
    tipo_evento: 'Colposcopia',
    fecha_evento: '',
    resultado: 'NORMAL',
    establecimiento: 'HDSI',
    fecha_probable_parto: '',
    fecha_proximo_control: '',
    observaciones: '',
  });
  const [nuevoTratamiento, setNuevoTratamiento] = useState({
    tipo_tratamiento: 'Crioterapia',
    fecha_tratamiento: '',
    ginecologo_responsable: '',
    observaciones: '',
  });
  const [fechaParto, setFechaParto] = useState('');

  const token = session?.access_token;

  const cabeceras = useCallback((): HeadersInit => {
    const h: HeadersInit = { 'Content-Type': 'application/json' };
    if (token) h['Authorization'] = `Bearer ${token}`;
    return h;
  }, [token]);

  useEffect(() => {
    if (!supabase) return;
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => subscription.unsubscribe();
  }, []);

  // Confirmación de guardado: sin esto la usuaria vuelve al Excel a verificar.
  useEffect(() => {
    if (!aviso) return;
    const t = setTimeout(() => setAviso(''), 4000);
    return () => clearTimeout(t);
  }, [aviso]);

  // La búsqueda espera a que deje de teclear y cancela la petición anterior: sin esto
  // la respuesta de "MAR" puede llegar después de la de "MARIA" y pintar otra lista.
  useEffect(() => {
    if (!session) return;
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      setCargandoLista(true);
      setFalloLista(null);
      try {
        const params = new URLSearchParams();
        if (busqueda.trim()) params.set('search', busqueda.trim());
        if (filtro) params.set('estado', filtro);
        const qs = params.toString();
        const res = await fetch(`${API_BASE_URL}/pacientes${qs ? `?${qs}` : ''}`, {
          headers: cabeceras(),
          signal: ctrl.signal,
        });
        if (!res.ok) throw new Error(await leerError(res));
        const data = (await res.json()) || [];
        setPatients(data);
      } catch (e) {
        if ((e as Error).name === 'AbortError') return;
        setPatients([]);
        setFalloLista(
          e instanceof TypeError
            ? 'No se pudo conectar con el servidor. Revisa que el sistema esté encendido y vuelve a intentar.'
            : (e as Error).message,
        );
      } finally {
        if (!ctrl.signal.aborted) setCargandoLista(false);
      }
    }, 250);

    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [busqueda, filtro, token, cabeceras, pulso]);

  // Fetch calendar events/treatments whenever the data updates or session changes
  useEffect(() => {
    if (!session) return;
    let activo = true;
    async function cargarCalendario() {
      try {
        const res = await fetch(`${API_BASE_URL}/eventos/calendario`, {
          headers: cabeceras(),
        });
        if (!res.ok) throw new Error(await leerError(res));
        const data = await res.json();
        if (activo) {
          setItemsCalendario(data || []);
        }
      } catch (e) {
        console.error("Error loading calendar events:", e);
      }
    }
    cargarCalendario();
    return () => {
      activo = false;
    };
  }, [session, pulso, cabeceras]);

  // Helper to extract VPH strain from observations or raw strain string
  const getVPHStrain = useCallback((cepa: string | null | undefined): string => {
    if (!cepa) return 'VPH Positivo';
    const m = /Cepa\(s\):\s*([^.]+)/i.exec(cepa);
    if (m && m[1]) return m[1].trim();
    // Fallback checks
    const strains: string[] = [];
    const upper = cepa.toUpperCase();
    if (upper.includes('16')) strains.push('VPH 16');
    if (upper.includes('18')) strains.push('VPH 18');
    if (upper.includes('OTROS') || upper.includes('A/R')) strains.push('VPH Otros A/R');
    return strains.length > 0 ? strains.join(', ') : 'VPH Positivo';
  }, []);

  // ponytail: client-side CSV/Excel export
  // Ceiling: browser memory limit for large data Blobs and formatting constraints in standard CSV.
  // Upgrade path: implement server-side Excel generation (e.g. using Excelize in Go) with direct file streaming.
  const exportarExcel = useCallback((pacientesAExportar: Patient[]) => {
    const cabeceras = ['Nombres', 'DNI', 'Historia Clínica', 'Estado Actual', 'Cepa VPH', 'Último Evento', 'Próximo Control', 'Fecha de Registro'];
    const filas = pacientesAExportar.map(p => [
      p.nombres,
      p.dni,
      p.historia_clinica || '',
      p.estado_actual,
      getVPHStrain(p.cepa_vph),
      fecha(p.ultimo_evento),
      fecha(p.proximo_control),
      fecha(p.fecha_registro)
    ]);

    // UTF-16LE format works best with tab delimiters and CRLF line endings
    const csvContent = [
      cabeceras.map(c => `"${c.replace(/"/g, '""')}"`).join('\t'),
      ...filas.map(f => f.map(val => `"${val.replace(/"/g, '""')}"`).join('\t'))
    ].join('\r\n');

    // Convert string to UTF-16LE byte buffer
    const buffer = new ArrayBuffer(csvContent.length * 2 + 2); // 2 bytes per char + 2 bytes for BOM
    const view = new DataView(buffer);
    
    // Write UTF-16LE BOM (0xFEFF -> 0xFF 0xFE in binary)
    view.setUint16(0, 0xFEFF, true);
    
    // Write characters as 16-bit little-endian values
    for (let i = 0; i < csvContent.length; i++) {
      view.setUint16((i + 1) * 2, csvContent.charCodeAt(i), true);
    }

    const blob = new Blob([buffer], { type: 'text/csv;charset=utf-16le;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', `Pacientes_VPH_${new Date().toISOString().slice(0, 10)}.csv`);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }, [getVPHStrain]);

  // Dynamic list of years present in patients across all dates, with robust fallbacks
  const aniosDisponibles = React.useMemo(() => {
    const years = new Set<string>();
    patients.forEach(p => {
      if (p.fecha_registro && p.fecha_registro.length >= 4) {
        years.add(p.fecha_registro.substring(0, 4));
      }
      if (p.ultimo_evento && p.ultimo_evento.length >= 4) {
        years.add(p.ultimo_evento.substring(0, 4));
      }
      if (p.proximo_control && p.proximo_control.length >= 4) {
        years.add(p.proximo_control.substring(0, 4));
      }
    });
    // Ensure all years from 2023 to at least 2028 are always present by default,
    // and dynamically support up to currentYear + 3 for future safety.
    const currentYear = new Date().getFullYear();
    const maxYear = Math.max(currentYear + 3, 2028);
    for (let y = 2023; y <= maxYear; y++) {
      years.add(String(y));
    }
    return Array.from(years).sort((a, b) => b.localeCompare(a));
  }, [patients]);

  // ponytail: client-side-only filtering and pagination
  // Ceiling: performance drops when patient database exceeds 5,000+ records.
  // Upgrade path: migrate filters/pagination to backend sql parameters and standard offset/limit pagination.
  const filteredPatients = React.useMemo(() => {
    return patients.filter((p) => {
      // 1. Filter by VPH strain (Cepa)
      if (filtroCepa) {
        const obs = (p.cepa_vph || '').toUpperCase();
        if (filtroCepa === 'VPH 16' && !obs.includes('16')) return false;
        if (filtroCepa === 'VPH 18' && !obs.includes('18')) return false;
        if (filtroCepa === 'VPH Otros A/R' && !(obs.includes('OTROS') || obs.includes('A/R'))) return false;
      }

      // 2. Filter by Year
      let dateStr: string | null | undefined = null;
      if (tipoFecha === 'ultimo_evento') dateStr = p.ultimo_evento;
      else if (tipoFecha === 'proximo_control') dateStr = p.proximo_control;
      else dateStr = p.fecha_registro;

      if (filtroAnio) {
        if (!dateStr) return false;
        if (dateStr.substring(0, 4) !== filtroAnio) return false;
      }

      return true;
    });
  }, [patients, filtroCepa, tipoFecha, filtroAnio]);

  const filteredCalendarItems = React.useMemo(() => {
    const patientIds = new Set(filteredPatients.map(p => p.id));
    return itemsCalendario.filter(item => patientIds.has(item.paciente_id));
  }, [itemsCalendario, filteredPatients]);

  // Reset page when any filter state changes
  useEffect(() => {
    setPagina(1);
  }, [filtro, busqueda, filtroCepa, filtroAnio, tipoFecha]);

  // Clear selection if current filtered list changes or empty, to avoid hidden selection memory issues
  useEffect(() => {
    const validIds = new Set(filteredPatients.map(p => p.id));
    setSeleccionados(prev => {
      const next = new Set<number>();
      prev.forEach(id => {
        if (validIds.has(id)) next.add(id);
      });
      return next.size === prev.size ? prev : next;
    });
  }, [filteredPatients]);

  // Reset export mode and selection when switching between List and Calendar views
  useEffect(() => {
    setModoExportar(false);
    setSeleccionados(new Set());
  }, [vista]);

  // Pagination calculations
  const totalItems = filteredPatients.length;
  const totalPaginas = Math.ceil(totalItems / itemsPorPagina) || 1;
  const paginaValida = Math.min(Math.max(pagina, 1), totalPaginas);
  const startIndex = (paginaValida - 1) * itemsPorPagina;
  const paginatedPatients = filteredPatients.slice(startIndex, startIndex + itemsPorPagina);

  const cargarDetalle = useCallback(
    async (id: number) => {
      setCargandoDetalle(true);
      setFalloDetalle(null);
      try {
        const res = await fetch(`${API_BASE_URL}/pacientes/${id}`, { headers: cabeceras() });
        if (!res.ok) throw new Error(await leerError(res));
        const data = await res.json();
        setDetalle({ ...data, tratamientos: data.tratamientos || data.tratamintos || [] });
      } catch (e) {
        setDetalle(null);
        setFalloDetalle(
          e instanceof TypeError
            ? 'No se pudo conectar con el servidor para abrir el expediente.'
            : (e as Error).message,
        );
      } finally {
        setCargandoDetalle(false);
      }
    },
    [cabeceras],
  );

  useEffect(() => {
    setEditando(false);
    if (seleccionada === null) {
      setDetalle(null);
      return;
    }
    cargarDetalle(seleccionada);
  }, [seleccionada, cargarDetalle]);

  // Abrir un expediente mueve el foco dentro de él; cerrarlo lo devuelve a la fila
  // de la que se salió. En el celular el informe tapa el registro, así que sin esto
  // el foco se queda en un botón que ya no se ve.
  useEffect(() => {
    if (seleccionada !== null) cerrarInforme.current?.focus();
  }, [seleccionada]);

  const cerrar = useCallback(() => {
    setEditando(false);
    const id = seleccionada;
    setSeleccionada(null);
    requestAnimationFrame(() => {
      document.querySelector<HTMLElement>(`[data-fila="${id}"]`)?.focus();
    });
  }, [seleccionada]);

  const refrescar = useCallback(() => {
    // Un contador, no `setBusqueda(b => b)`: React descarta un valor idéntico y el
    // efecto de lista nunca se volvería a disparar, dejando la paciente marcada como
    // vencida con las fechas viejas justo después de registrarle el control.
    setPulso((p) => p + 1);
    if (seleccionada !== null) cargarDetalle(seleccionada);
  }, [seleccionada, cargarDetalle]);

  async function enviar(url: string, cuerpo: unknown, exito: string, metodo: string = 'POST') {
    setGuardando(true);
    setErrorForm('');
    try {
      const res = await fetch(url, {
        method: metodo,
        headers: cabeceras(),
        body: cuerpo !== null && cuerpo !== undefined ? JSON.stringify(cuerpo) : undefined,
      });
      if (!res.ok) throw new Error(await leerError(res));
      setDialogo(null);
      setAviso(exito);
      refrescar();
      return true;
    } catch (e) {
      setErrorForm(
        e instanceof TypeError
          ? 'No se pudo conectar con el servidor. No se guardó nada; tus datos siguen aquí.'
          : (e as Error).message,
      );
      return false;
    } finally {
      setGuardando(false);
    }
  }

  const iniciarEdicionEvento = (ev: ClinicalEvent) => {
    setEditandoEvento(ev);
    setNuevoEvento({
      tipo_evento: ev.tipo_evento || 'Colposcopia',
      fecha_evento: ev.fecha_evento ? ev.fecha_evento.split('T')[0] : '',
      resultado: ev.resultado || 'NORMAL',
      establecimiento: ev.establecimiento || '',
      fecha_probable_parto: '',
      fecha_proximo_control: ev.fecha_proximo_control ? ev.fecha_proximo_control.split('T')[0] : '',
      observaciones: ev.observaciones || '',
    });
    setErrorForm('');
    setDialogo('evento');
  };

  const iniciarEdicionTratamiento = (tr: Treatment) => {
    setEditandoTratamiento(tr);
    setNuevoTratamiento({
      tipo_tratamiento: tr.tipo_tratamiento || 'Crioterapia',
      fecha_tratamiento: tr.fecha_tratamiento ? tr.fecha_tratamiento.split('T')[0] : '',
      ginecologo_responsable: tr.ginecologo_responsable || '',
      observaciones: tr.observaciones || '',
    });
    setErrorForm('');
    setDialogo('tratamiento');
  };

  const iniciarEdicion = (det: PatientDetail) => {
    setEditDni(det.patient.dni);
    setEditNombres(det.patient.nombres);
    setEditHistoria(det.patient.historia_clinica || '');
    setEditEstado(det.patient.estado_actual);
    setEditCelular(det.contact?.celular || '');
    setEditDireccion(det.contact?.direccion || '');
    setEditDistrito(det.contact?.distrito || '');
    setEditando(true);
    setErrorForm('');
  };

  async function guardarCambios(e: React.FormEvent) {
    e.preventDefault();
    if (seleccionada === null) return;
    setGuardando(true);
    setErrorForm('');
    try {
      const cuerpo = {
        dni: editDni,
        nombres: editNombres,
        historia_clinica: editHistoria || '',
        estado_actual: editEstado,
        celular: editCelular || '',
        direccion: editDireccion || '',
        distrito: editDistrito || '',
      };
      const res = await fetch(`${API_BASE_URL}/pacientes/${seleccionada}`, {
        method: 'PUT',
        headers: cabeceras(),
        body: JSON.stringify(cuerpo),
      });
      if (!res.ok) throw new Error(await leerError(res));
      setAviso('Paciente actualizado con éxito.');
      setEditando(false);
      refrescar();
    } catch (e) {
      setErrorForm(
        e instanceof TypeError
          ? 'No se pudo conectar con el servidor para guardar los cambios.'
          : (e as Error).message,
      );
    } finally {
      setGuardando(false);
    }
  }

  async function eliminarPaciente() {
    if (seleccionada === null || !detalle) return;
    const confirmacion = window.confirm(
      `¿Está completamente segura de eliminar la ficha de ${detalle.patient.nombres}? Esta acción no se puede deshacer de forma simple.`
    );
    if (!confirmacion) return;

    setGuardando(true);
    setErrorForm('');
    try {
      const res = await fetch(`${API_BASE_URL}/pacientes/${seleccionada}`, {
        method: 'DELETE',
        headers: cabeceras(),
      });
      if (!res.ok) throw new Error(await leerError(res));
      setAviso('Paciente eliminado con éxito.');
      setSeleccionada(null);
      setEditando(false);
      refrescar();
    } catch (e) {
      setErrorForm(
        e instanceof TypeError
          ? 'No se pudo conectar con el servidor para eliminar al paciente.'
          : (e as Error).message,
      );
    } finally {
      setGuardando(false);
    }
  }

  async function iniciarSesion(e: React.FormEvent) {
    e.preventDefault();
    if (!supabase) {
      // Sin Supabase configurado no hay autenticación real. Se permite para desarrollo
      // local, pero la sesión queda marcada en pantalla en vez de pasar inadvertida.
      setSimulado(true);
      setSession({});
      return;
    }
    setEntrando(true);
    setAuthError('');
    try {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;
    } catch (err) {
      setAuthError((err as Error).message || 'No se pudo iniciar sesión.');
    } finally {
      setEntrando(false);
    }
  }

  async function cerrarSesion() {
    if (supabase) await supabase.auth.signOut();
    setSession(null);
    setSimulado(false);
    setSeleccionada(null);
    setEmail('');
    setPassword('');
  }

  // --- Ingreso ---------------------------------------------------------------

  if (!session) {
    return (
      <div className="ingreso">
        <form onSubmit={iniciarSesion}>
          <div className="ingreso-marca">Gestor Mari · P.S. Gran Chimú</div>
          <h1>Iniciar sesión</h1>

          {authError && (
            <p className="error-form" role="alert">
              <AlertTriangle size={16} aria-hidden="true" />
              {authError}
            </p>
          )}

          <div className="campo">
            <label htmlFor="ing-correo">Correo electrónico</label>
            <input
              id="ing-correo"
              type="email"
              autoComplete="username"
              placeholder="ejemplo@granchimu.gob.pe"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>

          <div className="campo">
            <label htmlFor="ing-clave">Contraseña</label>
            <input
              id="ing-clave"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>

          <button type="submit" className="btn btn--principal" disabled={entrando}>
            {entrando ? 'Verificando…' : 'Ingresar'}
          </button>

          {!supabase && (
            <p className="aviso-simulado">
              <strong>Modo sin autenticación.</strong> Falta configurar <code>VITE_SUPABASE_URL</code> y{' '}
              <code>VITE_SUPABASE_ANON_KEY</code>: cualquier credencial abre el sistema. No usar con datos
              reales de pacientes.
            </p>
          )}
        </form>
      </div>
    );
  }

  // --- Aplicación ------------------------------------------------------------

  const filtroActivo = FILTROS.find((f) => f.valor === filtro);
  const hoy = new Date().toLocaleDateString('es-PE', { day: '2-digit', month: 'short', year: 'numeric' });
  const gestacion = detalle?.gestaciones?.find((g) => g.activa);
  const estadoDetalle = detalle
    ? seguimiento(
        detalle.patient.estado_actual,
        detalle.eventos?.reduce<string | null>(
          (max, ev) => (ev.fecha_proximo_control && (!max || ev.fecha_proximo_control > max) ? ev.fecha_proximo_control : max),
          null,
        ),
      )
    : null;

  return (
    <div className={`app${seleccionada !== null ? ' app--dividido' : ''}`}>
      <header className="membrete">
        <div className="membrete-fila">
          <span className="membrete-marca">
            Gestor Mari <span>· P.S. Gran Chimú · Micro Red Porvenir</span>
          </span>
          <span className="membrete-conteo">
            {hoy}
            {simulado && ' · sesión sin autenticar'}
            <button type="button" className="enlace-salir" onClick={() => setMostrarConfirmarSalir(true)}>
              Salir
            </button>
          </span>
        </div>

        <div className="membrete-titulo">
          <h1>Cohorte VPH(+)</h1>

          <div className="vista-selector">
            <button
              type="button"
              className={`btn-vista ${vista === 'lista' ? 'btn-vista--activo' : ''}`}
              onClick={() => setVista('lista')}
            >
              Lista
            </button>
            <button
              type="button"
              className={`btn-vista ${vista === 'calendario' ? 'btn-vista--activo' : ''}`}
              onClick={() => setVista('calendario')}
            >
              Calendario
            </button>
          </div>

          {vista === 'lista' && (
            <span className="membrete-conteo">
              {cargandoLista
                ? 'consultando…'
                : falloLista
                  ? '—'
                  : `${patients.length} ${patients.length === 1 ? 'paciente' : 'pacientes'} · ${filtroActivo?.etiqueta.toLowerCase() ?? 'todas'}`}
            </span>
          )}
          <button type="button" className="btn btn--principal btn--nueva" onClick={() => setDialogo('paciente')}>
            <Plus size={16} aria-hidden="true" />
            Nueva ficha
          </button>
        </div>

        {vista === 'lista' && (
          <div className="indice" role="group" aria-label="Filtros de seguimiento">
            {FILTROS.map((f) => (
              <button
                key={f.valor || 'todas'}
                type="button"
                aria-pressed={filtro === f.valor}
                className={`indice-tab${f.senal ? ' indice-tab--senal' : ''}`}
                onClick={() => setFiltro(f.valor)}
              >
                {f.etiqueta}
              </button>
            ))}
          </div>
        )}
      </header>

      <div className="cuerpo">
        {/* En una columna el informe se superpone: el registro que queda debajo no debe
            seguir siendo tabulable ni anunciable. */}
        <section
          className="panel-registro"
          aria-label="Registro de pacientes"
          inert={!dosColumnas && seleccionada !== null}
        >
          <div className="buscador">
            <div className="buscador-principal">
              <div className="buscador-input-wrapper">
                <Search size={18} aria-hidden="true" />
                <label className="sr-only" htmlFor="buscar">
                  Buscar paciente por nombre, DNI o historia clínica
                </label>
                <input
                  id="buscar"
                  type="search"
                  placeholder={vista === 'calendario' ? "Buscar en el calendario..." : "Buscar por nombre, DNI o historia clínica"}
                  value={busqueda}
                  onChange={(e) => setBusqueda(e.target.value)}
                  disabled={modoExportar}
                />
              </div>
              <button
                type="button"
                className={`btn btn--secundario btn--filtros-maestros ${filtrosAvanzadosAbiertos ? 'btn--activo' : ''}`}
                onClick={() => setFiltrosAvanzadosAbiertos(!filtrosAvanzadosAbiertos)}
                title="Filtros maestros"
                disabled={modoExportar}
              >
                Filtros
              </button>
              {!modoExportar && (busqueda || filtroCepa || filtroAnio) && (
                <button
                  type="button"
                  className="btn btn--danger"
                  onClick={() => {
                    setBusqueda('');
                    setFiltroCepa('');
                    setFiltroAnio('');
                  }}
                  title="Limpiar filtros"
                  style={{ padding: '0 0.75rem', minWidth: 'auto' }}
                >
                  <Trash size={16} aria-hidden="true" />
                </button>
              )}
              {vista === 'lista' && (
                !modoExportar ? (
                  <button
                    type="button"
                    className="btn btn--exportar"
                    onClick={() => setModoExportar(true)}
                    title="Activar modo exportación"
                  >
                    Exportar
                  </button>
                ) : (
                  <>
                    <button
                      type="button"
                      className="btn btn--exportar"
                      onClick={() => {
                        const seleccionadosList = patients.filter(p => seleccionados.has(p.id));
                        exportarExcel(seleccionadosList);
                      }}
                      disabled={seleccionados.size === 0}
                      title="Exportar seleccionadas"
                    >
                      Exportar ({seleccionados.size})
                    </button>
                    <button
                      type="button"
                      className="btn btn--exportar btn--secundario"
                      onClick={() => exportarExcel(filteredPatients)}
                      title="Exportar todas las que coinciden con los filtros"
                    >
                      Exportar todas
                    </button>
                    <button
                      type="button"
                      className="btn btn--cancelar"
                      onClick={() => {
                        setModoExportar(false);
                        setSeleccionados(new Set());
                      }}
                      title="Salir del modo exportación"
                    >
                      Cancelar
                    </button>
                  </>
                )
              )}
            </div>

            {filtrosAvanzadosAbiertos && (
              <div className="filtros-avanzados">
                <div className="campo">
                  <label htmlFor="filtro-cepa">Cepa VPH</label>
                  <select
                    id="filtro-cepa"
                    value={filtroCepa}
                    onChange={(e) => setFiltroCepa(e.target.value)}
                  >
                    <option value="">Todas las cepas</option>
                    <option value="VPH 16">VPH 16</option>
                    <option value="VPH 18">VPH 18</option>
                    <option value="VPH Otros A/R">VPH Otros A/R</option>
                  </select>
                </div>

                <div className="campo">
                  <label htmlFor="filtro-tipo-fecha">Filtrar fecha por</label>
                  <select
                    id="filtro-tipo-fecha"
                    value={tipoFecha}
                    onChange={(e) => setTipoFecha(e.target.value as any)}
                  >
                    <option value="fecha_registro">Fecha de registro</option>
                    <option value="ultimo_evento">Último evento</option>
                    <option value="proximo_control">Próximo control</option>
                  </select>
                </div>

                <div className="campo">
                  <label htmlFor="filtro-anio">Año</label>
                  <select
                    id="filtro-anio"
                    value={filtroAnio}
                    onChange={(e) => setFiltroAnio(e.target.value)}
                  >
                    <option value="">Todos los años</option>
                    {aniosDisponibles.map((y) => (
                      <option key={y} value={y}>
                        {y}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            )}
          </div>

          {vista === 'calendario' ? (
            <Calendario
              patients={filteredPatients}
              onSelectPatient={setSeleccionada}
              seleccionada={seleccionada}
              filtroAnio={filtroAnio}
              items={filteredCalendarItems}
            />
          ) : (
            <>
              {modoExportar ? (
                <div className="registro-encabezado-wrapper">
                  <div className="fila-check-container header-check-container" aria-hidden="true">
                    <input
                      type="checkbox"
                      checked={paginatedPatients.length > 0 && paginatedPatients.every(p => seleccionados.has(p.id))}
                      onChange={(e) => {
                        const checked = e.target.checked;
                        const nuevos = new Set(seleccionados);
                        paginatedPatients.forEach(p => {
                          if (checked) nuevos.add(p.id);
                          else nuevos.delete(p.id);
                        });
                        setSeleccionados(nuevos);
                      }}
                      aria-label="Seleccionar todos los pacientes de esta página"
                    />
                  </div>
                  <div className="registro-encabezado" aria-hidden="true">
                    <span className="rotulo">Paciente</span>
                    <span className="rotulo">Último</span>
                    <span className="rotulo">Próximo</span>
                    <span className="rotulo">Intervalo</span>
                    <span className="rotulo">Señal</span>
                  </div>
                </div>
              ) : (
                <div className="registro-encabezado" aria-hidden="true" style={{ position: 'sticky', top: 0, zIndex: 1, borderBottom: '1px solid var(--tinta)' }}>
                  <span className="rotulo">Paciente</span>
                  <span className="rotulo">Último</span>
                  <span className="rotulo">Próximo</span>
                  <span className="rotulo">Intervalo</span>
                  <span className="rotulo">Señal</span>
                </div>
              )}

              {falloLista ? (
                <div className="estado-vacio estado-fallo" role="alert">
                  <h2>No se pudo leer el registro</h2>
                  <p>{falloLista}</p>
                  <button type="button" className="btn" onClick={refrescar}>
                    <RotateCw size={16} aria-hidden="true" />
                    Reintentar
                  </button>
                </div>
              ) : cargandoLista ? (
                <p className="estado-vacio">Consultando el registro…</p>
              ) : filteredPatients.length === 0 ? (
                <div className="estado-vacio">
                  <h2>
                    {filtro === 'vencidas'
                      ? 'Ninguna paciente vencida'
                      : (busqueda || filtroCepa || filtroAnio)
                        ? 'Sin coincidencias'
                        : 'Sin pacientes en este filtro'}
                  </h2>
                  <p>
                    {filtro === 'vencidas'
                      ? 'Todas las pacientes en seguimiento están dentro de su plazo de control.'
                      : (busqueda || filtroCepa || filtroAnio)
                        ? 'Ninguna paciente coincide con los filtros aplicados.'
                        : 'El registro respondió correctamente: no hay pacientes en este estado.'}
                  </p>
                </div>
              ) : (
                <>
                  <ol className="registro">
                    {paginatedPatients.map((p) => (
                      <Fila
                        key={p.id}
                        patient={p}
                        activa={seleccionada === p.id}
                        onAbrir={() => setSeleccionada(p.id)}
                        seleccionado={seleccionados.has(p.id)}
                        onToggleSeleccion={() => {
                          const nuevos = new Set(seleccionados);
                          if (nuevos.has(p.id)) nuevos.delete(p.id);
                          else nuevos.add(p.id);
                          setSeleccionados(nuevos);
                        }}
                        modoExportar={modoExportar}
                      />
                    ))}
                  </ol>
                  <div className="paginacion">
                    <div className="paginacion-info">
                      <span>
                        {startIndex + 1} - {Math.min(startIndex + itemsPorPagina, totalItems)} de {totalItems}
                      </span>
                      <select
                        className="select-limite"
                        value={itemsPorPagina}
                        onChange={(e) => setItemsPorPagina(Number(e.target.value))}
                        aria-label="Filas por página"
                      >
                        <option value={10}>10 filas</option>
                        <option value={25}>25 filas</option>
                        <option value={50}>50 filas</option>
                        <option value={100}>100 filas</option>
                      </select>
                    </div>
                    <div className="paginacion-botones">
                      <button
                        type="button"
                        className="btn btn--chico"
                        disabled={paginaValida === 1}
                        onClick={() => setPagina(paginaValida - 1)}
                      >
                        Anterior
                      </button>
                      <span className="paginacion-actual">
                        Pág. {paginaValida} de {totalPaginas}
                      </span>
                      <button
                        type="button"
                        className="btn btn--chico"
                        disabled={paginaValida === totalPaginas}
                        onClick={() => setPagina(paginaValida + 1)}
                      >
                        Siguiente
                      </button>
                    </div>
                  </div>
                </>
              )}
            </>
          )}
        </section>

        {seleccionada !== null && (
          <section className="panel-informe" aria-label="Expediente de la paciente">
            <button type="button" className="informe-volver" ref={cerrarInforme} onClick={cerrar}>
              <ArrowLeft size={18} aria-hidden="true" />
              Cerrar informe
            </button>

            {falloDetalle ? (
              <div className="estado-vacio estado-fallo" role="alert">
                <h2>No se pudo abrir el expediente</h2>
                <p>{falloDetalle}</p>
                <button type="button" className="btn" onClick={() => cargarDetalle(seleccionada)}>
                  <RotateCw size={16} aria-hidden="true" />
                  Reintentar
                </button>
              </div>
            ) : cargandoDetalle || !detalle ? (
              <p className="estado-vacio">Abriendo expediente…</p>
            ) : (
              <>
                {editando ? (
                  <div className="informe-scroll" tabIndex={0} role="group" aria-label="Editar expediente">
                    <div className="informe-cabecera">
                      <h2>Editar expediente</h2>
                      <p className="informe-ident">Modificando los datos personales y de contacto de {detalle.patient.nombres}.</p>
                    </div>
                    <form onSubmit={guardarCambios} className="informe-edicion">
                      <div className="campo">
                        <label htmlFor="edit-nombres">Nombres completos</label>
                        <input
                          id="edit-nombres"
                          type="text"
                          value={editNombres}
                          onChange={(e) => setEditNombres(e.target.value)}
                          required
                        />
                      </div>
                      <div className="campo-grupo">
                        <div className="campo">
                          <label htmlFor="edit-dni">DNI</label>
                          <input
                            id="edit-dni"
                            type="text"
                            value={editDni}
                            onChange={(e) => setEditDni(e.target.value)}
                            required
                          />
                        </div>
                        <div className="campo">
                          <label htmlFor="edit-historia">Historia Clínica</label>
                          <input
                            id="edit-historia"
                            type="text"
                            value={editHistoria}
                            onChange={(e) => setEditHistoria(e.target.value)}
                          />
                        </div>
                      </div>
                      <div className="campo">
                        <label htmlFor="edit-estado">Estado de Seguimiento</label>
                        <select
                          id="edit-estado"
                          value={editEstado}
                          onChange={(e) => setEditEstado(e.target.value)}
                          required
                        >
                          <option value="Activa">Activa (En seguimiento)</option>
                          <option value="Pausada">Pausada (Gestando)</option>
                          <option value="Derivada">Derivada</option>
                          <option value="Cerrada">Cerrada</option>
                        </select>
                      </div>
                      <div className="campo">
                        <label htmlFor="edit-celular">Celular</label>
                        <input
                          id="edit-celular"
                          type="text"
                          value={editCelular}
                          onChange={(e) => setEditCelular(e.target.value)}
                        />
                      </div>
                      <div className="campo">
                        <label htmlFor="edit-direccion">Dirección</label>
                        <input
                          id="edit-direccion"
                          type="text"
                          value={editDireccion}
                          onChange={(e) => setEditDireccion(e.target.value)}
                        />
                      </div>
                      <div className="campo">
                        <label htmlFor="edit-distrito">Distrito</label>
                        <input
                          id="edit-distrito"
                          type="text"
                          value={editDistrito}
                          onChange={(e) => setEditDistrito(e.target.value)}
                        />
                      </div>

                      {errorForm && <p className="error-form" style={{ color: 'var(--senal)', marginTop: '0.5rem' }}>{errorForm}</p>}

                      <div className="acciones-edicion">
                        <button type="submit" className="btn btn--principal" disabled={guardando}>
                          {guardando ? 'Guardando...' : 'Guardar'}
                        </button>
                        <button type="button" className="btn" onClick={() => setEditando(false)} disabled={guardando}>
                          Cancelar
                        </button>
                        <button
                          type="button"
                          className="btn btn--danger"
                          onClick={eliminarPaciente}
                          disabled={guardando}
                          style={{ marginLeft: 'auto' }}
                        >
                          Eliminar ficha
                        </button>
                      </div>
                    </form>
                  </div>
                ) : (
                  <>
                    {/* Enfocable a propósito: es la única forma de recorrer un historial
                        largo con el teclado, porque dentro no hay ningún control. */}
                    <div className="informe-scroll" tabIndex={0} role="group" aria-label="Contenido del expediente">
                      <div className="informe-cabecera">
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <h2>{detalle.patient.nombres}</h2>
                          <button
                            type="button"
                            className="btn btn--chico"
                            onClick={() => iniciarEdicion(detalle)}
                          >
                            Editar
                          </button>
                        </div>
                        <p className="informe-ident">
                          DNI {detalle.patient.dni}
                          {detalle.patient.historia_clinica ? ` · HC ${detalle.patient.historia_clinica}` : ''} ·{' '}
                          {detalle.patient.estado_actual}
                        </p>

                        {estadoDetalle && (
                          <div className={`veredicto veredicto--${estadoDetalle.clase}`}>
                            <span className="veredicto-titular">{textoSenal(estadoDetalle)}</span>
                            {gestacion ? (
                              <span className="veredicto-detalle">
                                FPP {fecha(gestacion.fecha_probable_parto)} · reanuda{' '}
                                {fecha(gestacion.fecha_fin_puerperio)}
                              </span>
                            ) : (
                              <span className="veredicto-detalle">
                                Control programado: {fecha(
                                  detalle.eventos?.reduce<string | null>(
                                    (max, ev) =>
                                      ev.fecha_proximo_control && (!max || ev.fecha_proximo_control > max)
                                        ? ev.fecha_proximo_control
                                        : max,
                                    null,
                                  ),
                                )}
                              </span>
                            )}
                          </div>
                        )}
                      </div>

                      <section className="seccion">
                        <h3>Contacto</h3>
                        <div className="datos">
                          <div>
                            <span className="dato-etiqueta">Celular</span>
                            <span className="dato-valor dato-valor--cifra">
                              {detalle.contact?.celular || '—'}
                            </span>
                          </div>
                          <div>
                            <span className="dato-etiqueta">Dirección</span>
                            <span className="dato-valor">
                              {detalle.contact?.direccion
                                ? `${detalle.contact.direccion}${detalle.contact.distrito ? `, ${detalle.contact.distrito}` : ''}`
                                : '—'}
                            </span>
                          </div>
                        </div>
                      </section>

                      <section className="seccion">
                        <h3>Historial clínico</h3>
                        {detalle.eventos && detalle.eventos.length > 0 ? (
                          <ol className="resultados">
                            {detalle.eventos.map((ev) => (
                              <li key={ev.id} className="resultado">
                                <span className="resultado-fecha">{fecha(ev.fecha_evento)}</span>
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '1rem', width: '100%' }}>
                                  <div>
                                    <span className="resultado-titulo">
                                      {ev.tipo_evento}
                                      {ev.resultado && (
                                        <>
                                          {' · '}
                                          <span
                                            className={`resultado-valor${fueraDeRango(ev.resultado) ? ' resultado-valor--fuera' : ''}`}
                                          >
                                            {fueraDeRango(ev.resultado) && (
                                              <span aria-hidden="true">▲ </span>
                                            )}
                                            {ev.resultado}
                                          </span>
                                        </>
                                      )}
                                    </span>
                                    <span className="resultado-meta">
                                      {ev.establecimiento ? `${ev.establecimiento}` : 'Establecimiento no registrado'}
                                      {ev.fecha_proximo_control &&
                                        ` · próximo control ${fecha(ev.fecha_proximo_control)}`}
                                    </span>
                                    {ev.observaciones && <p className="resultado-nota">{ev.observaciones}</p>}
                                  </div>
                                  <button
                                    type="button"
                                    className="btn btn--chico"
                                    onClick={() => iniciarEdicionEvento(ev)}
                                  >
                                    Editar
                                  </button>
                                </div>
                              </li>
                            ))}
                          </ol>
                        ) : (
                          <p className="vacio-seccion">Sin eventos clínicos registrados.</p>
                        )}
                      </section>

                      <section className="seccion">
                        <h3>Tratamientos</h3>
                        {detalle.tratamientos && detalle.tratamientos.length > 0 ? (
                          <ol className="resultados">
                            {detalle.tratamientos.map((tr) => (
                              <li key={tr.id} className="resultado">
                                <span className="resultado-fecha">{fecha(tr.fecha_tratamiento)}</span>
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '1rem', width: '100%' }}>
                                  <div>
                                    <span className="resultado-titulo">{tr.tipo_tratamiento}</span>
                                    <span className="resultado-meta">
                                      {tr.ginecologo_responsable
                                        ? `Ginecólogo: ${tr.ginecologo_responsable}`
                                        : 'Ginecólogo no registrado'}
                                    </span>
                                    {tr.observaciones && <p className="resultado-nota">{tr.observaciones}</p>}
                                  </div>
                                  <button
                                    type="button"
                                    className="btn btn--chico"
                                    onClick={() => iniciarEdicionTratamiento(tr)}
                                  >
                                    Editar
                                  </button>
                                </div>
                              </li>
                            ))}
                          </ol>
                        ) : (
                          <p className="vacio-seccion">Sin tratamientos registrados.</p>
                        )}
                      </section>
                    </div>

                    <div className="acciones">
                      <button
                        type="button"
                        className="btn btn--principal"
                        onClick={() => {
                          setErrorForm('');
                          setDialogo('evento');
                        }}
                      >
                        Registrar evento
                        <ChevronRight size={16} aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        className="btn"
                        onClick={() => {
                          setErrorForm('');
                          setDialogo('tratamiento');
                        }}
                      >
                        Registrar tratamiento
                      </button>
                      {detalle.patient.estado_actual === 'Pausada' && (
                        <button
                          type="button"
                          className="btn btn--pausa"
                          onClick={() => {
                            setErrorForm('');
                            setDialogo('parto');
                          }}
                        >
                          Registrar parto
                        </button>
                      )}
                    </div>
                  </>
                )}
              </>
            )}
          </section>
        )}
      </div>

      {aviso && (
        <p className="aviso" role="status">
          <Check size={16} aria-hidden="true" />
          {aviso}
        </p>
      )}

      {/* --- Nueva ficha --- */}
      {dialogo === 'paciente' && (
        <Dialogo titulo="Nueva ficha de tamizaje VPH(+)" onCerrar={() => setDialogo(null)}>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const ok = await enviar(`${API_BASE_URL}/pacientes`, nuevaPaciente, 'Ficha registrada.');
              if (ok)
                setNuevaPaciente({
                  dni: '',
                  nombres: '',
                  historia_clinica: '',
                  celular: '',
                  direccion: '',
                  distrito: 'Porvenir',
                  fecha_toma: '',
                  resultado_vph: 'VPH Otros A/R',
                  observaciones: '',
                });
            }}
          >
            <div className="dialogo-cuerpo">
              {errorForm && (
                <p className="error-form" role="alert">
                  <AlertTriangle size={16} aria-hidden="true" />
                  {errorForm}
                </p>
              )}

              <div className="campo">
                <label htmlFor="np-nombres">Nombres y apellidos</label>
                <input
                  id="np-nombres"
                  value={nuevaPaciente.nombres}
                  onChange={(e) => setNuevaPaciente({ ...nuevaPaciente, nombres: e.target.value })}
                  required
                />
              </div>

              <div className="campo-par">
                <div className="campo">
                  <label htmlFor="np-dni">DNI</label>
                  <input
                    id="np-dni"
                    inputMode="numeric"
                    value={nuevaPaciente.dni}
                    onChange={(e) => setNuevaPaciente({ ...nuevaPaciente, dni: e.target.value })}
                    required
                  />
                </div>
                <div className="campo">
                  <label htmlFor="np-hc">Historia clínica</label>
                  <input
                    id="np-hc"
                    value={nuevaPaciente.historia_clinica}
                    onChange={(e) => setNuevaPaciente({ ...nuevaPaciente, historia_clinica: e.target.value })}
                  />
                </div>
              </div>

              <div className="campo-par">
                <div className="campo">
                  <label htmlFor="np-cel">Celular</label>
                  <input
                    id="np-cel"
                    type="tel"
                    inputMode="tel"
                    value={nuevaPaciente.celular}
                    onChange={(e) => setNuevaPaciente({ ...nuevaPaciente, celular: e.target.value })}
                  />
                </div>
                <div className="campo">
                  <label htmlFor="np-distrito">Distrito</label>
                  <input
                    id="np-distrito"
                    value={nuevaPaciente.distrito}
                    onChange={(e) => setNuevaPaciente({ ...nuevaPaciente, distrito: e.target.value })}
                  />
                </div>
              </div>

              <div className="campo">
                <label htmlFor="np-dir">Dirección</label>
                <input
                  id="np-dir"
                  value={nuevaPaciente.direccion}
                  onChange={(e) => setNuevaPaciente({ ...nuevaPaciente, direccion: e.target.value })}
                />
              </div>

              <div className="campo-par">
                <div className="campo">
                  <label htmlFor="np-toma">Fecha de toma de muestra</label>
                  <input
                    id="np-toma"
                    type="date"
                    value={nuevaPaciente.fecha_toma}
                    onChange={(e) => setNuevaPaciente({ ...nuevaPaciente, fecha_toma: e.target.value })}
                    required
                  />
                </div>
                <div className="campo">
                  <label htmlFor="np-cepa">Cepa detectada</label>
                  <select
                    id="np-cepa"
                    value={nuevaPaciente.resultado_vph}
                    onChange={(e) => setNuevaPaciente({ ...nuevaPaciente, resultado_vph: e.target.value })}
                  >
                    <option>VPH Otros A/R</option>
                    <option>VPH 16</option>
                    <option>VPH 18</option>
                    <option>VPH 16, VPH Otros A/R</option>
                    <option>VPH 18, VPH Otros A/R</option>
                    <option>VPH 16, VPH 18</option>
                  </select>
                </div>
              </div>

              <div className="campo">
                <label htmlFor="np-obs">Observaciones</label>
                <textarea
                  id="np-obs"
                  value={nuevaPaciente.observaciones}
                  onChange={(e) => setNuevaPaciente({ ...nuevaPaciente, observaciones: e.target.value })}
                />
              </div>
            </div>

            <div className="dialogo-pie">
              <button type="button" className="btn" onClick={() => setDialogo(null)}>
                Cancelar
              </button>
              <button type="submit" className="btn btn--principal" disabled={guardando}>
                {guardando ? 'Guardando…' : 'Guardar ficha'}
              </button>
            </div>
          </form>
        </Dialogo>
      )}

      {dialogo === 'evento' && seleccionada !== null && (
        <Dialogo titulo={editandoEvento ? "Modificar evento clínico" : "Registrar evento clínico"} onCerrar={() => { setDialogo(null); setEditandoEvento(null); }}>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              let ok;
              if (editandoEvento) {
                ok = await enviar(
                  `${API_BASE_URL}/eventos/${editandoEvento.id}`,
                  {
                    tipo_evento: nuevoEvento.tipo_evento,
                    fecha_evento: nuevoEvento.fecha_evento,
                    resultado: nuevoEvento.resultado,
                    establecimiento: nuevoEvento.establecimiento,
                    fecha_proximo_control: nuevoEvento.fecha_proximo_control || null,
                    observaciones: nuevoEvento.observaciones,
                  },
                  'Evento modificado.',
                  'PUT',
                );
              } else {
                ok = await enviar(
                  `${API_BASE_URL}/eventos`,
                  { paciente_id: seleccionada, ...nuevoEvento },
                  'Evento registrado.',
                );
              }
              if (ok) {
                setEditandoEvento(null);
                setNuevoEvento({
                  tipo_evento: 'Colposcopia',
                  fecha_evento: '',
                  resultado: 'NORMAL',
                  establecimiento: 'HDSI',
                  fecha_probable_parto: '',
                  fecha_proximo_control: '',
                  observaciones: '',
                });
              }
            }}
          >
            <div className="dialogo-cuerpo">
              {errorForm && (
                <p className="error-form" role="alert">
                  <AlertTriangle size={16} aria-hidden="true" />
                  {errorForm}
                </p>
              )}

              <div className="campo-par">
                <div className="campo">
                  <label htmlFor="ne-tipo">Tipo de evento</label>
                  <select
                    id="ne-tipo"
                    value={nuevoEvento.tipo_evento}
                    onChange={(e) => {
                      const tipo = e.target.value;
                      // El resultado depende del tipo, así que se reinicia al primero válido.
                      setNuevoEvento({
                        ...nuevoEvento,
                        tipo_evento: tipo,
                        resultado: RESULTADOS[tipo][0],
                        fecha_probable_parto: '',
                      });
                    }}
                  >
                    {TIPOS_EVENTO.map((t) => (
                      <option key={t.valor} value={t.valor}>
                        {t.etiqueta}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="campo">
                  <label htmlFor="ne-fecha">Fecha del evento</label>
                  <input
                    id="ne-fecha"
                    type="date"
                    value={nuevoEvento.fecha_evento}
                    onChange={(e) => setNuevoEvento({ ...nuevoEvento, fecha_evento: e.target.value })}
                    required
                  />
                </div>
              </div>

              <div className="campo-par">
                <div className="campo">
                  <label htmlFor="ne-resultado">Resultado</label>
                  <select
                    id="ne-resultado"
                    value={nuevoEvento.resultado}
                    onChange={(e) =>
                      setNuevoEvento({
                        ...nuevoEvento,
                        resultado: e.target.value,
                        fecha_probable_parto:
                          e.target.value === 'GESTANDO' ? nuevoEvento.fecha_probable_parto : '',
                      })
                    }
                  >
                    {RESULTADOS[nuevoEvento.tipo_evento].map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="campo">
                  <label htmlFor="ne-estab">Establecimiento</label>
                  <input
                    id="ne-estab"
                    value={nuevoEvento.establecimiento}
                    onChange={(e) => setNuevoEvento({ ...nuevoEvento, establecimiento: e.target.value })}
                  />
                </div>
              </div>

              {/* La FPP es lo que hace reversible la pausa: sin ella el disparador de
                  +42 días no tiene ancla, así que se pide aquí y es obligatoria. */}
              {nuevoEvento.resultado === 'GESTANDO' && (
                <div className="campo">
                  <label htmlFor="ne-fpp">Fecha probable de parto (FPP)</label>
                  <input
                    id="ne-fpp"
                    type="date"
                    value={nuevoEvento.fecha_probable_parto}
                    onChange={(e) => setNuevoEvento({ ...nuevoEvento, fecha_probable_parto: e.target.value })}
                    required
                    aria-describedby="ne-fpp-ayuda"
                  />
                  <span className="campo-ayuda" id="ne-fpp-ayuda">
                    {nuevoEvento.fecha_probable_parto
                      ? `Los controles se reanudarán el ${fecha(
                          new Date(
                            new Date(`${nuevoEvento.fecha_probable_parto}T00:00:00Z`).getTime() +
                              42 * 86_400_000,
                          )
                            .toISOString()
                            .slice(0, 10),
                        )} (FPP + 42 días).`
                      : 'Se usará para calcular el fin del puerperio (FPP + 42 días).'}
                  </span>
                </div>
              )}

              {consecuencia(nuevoEvento.tipo_evento, nuevoEvento.resultado) && (
                <p
                  className={`consecuencia${nuevoEvento.resultado === 'GESTANDO' ? ' consecuencia--pausa' : ''}`}
                >
                  {consecuencia(nuevoEvento.tipo_evento, nuevoEvento.resultado)}
                </p>
              )}

              {editandoEvento && (
                <div className="campo">
                  <label htmlFor="ne-proximo-control">Fecha de próximo control</label>
                  <input
                    id="ne-proximo-control"
                    type="date"
                    value={nuevoEvento.fecha_proximo_control}
                    onChange={(e) => setNuevoEvento({ ...nuevoEvento, fecha_proximo_control: e.target.value })}
                  />
                  <span className="campo-ayuda">
                    Opcional. Modifica o elimina la fecha para cambiar el próximo control agendado de la paciente.
                  </span>
                </div>
              )}

              <div className="campo">
                <label htmlFor="ne-obs">Observaciones</label>
                <textarea
                  id="ne-obs"
                  value={nuevoEvento.observaciones}
                  onChange={(e) => setNuevoEvento({ ...nuevoEvento, observaciones: e.target.value })}
                  aria-describedby="ne-obs-ayuda"
                />
                <span className="campo-ayuda" id="ne-obs-ayuda">
                  Justifica aquí cualquier desviación del protocolo indicada por el ginecólogo.
                </span>
              </div>
            </div>

            <div className="dialogo-pie">
              {editandoEvento && (
                <button
                  type="button"
                  className="btn btn--danger"
                  onClick={async () => {
                    if (window.confirm('¿Está seguro de eliminar este evento clínico? Esta acción no se puede deshacer.')) {
                      const ok = await enviar(`${API_BASE_URL}/eventos/${editandoEvento.id}`, null, 'Evento eliminado.', 'DELETE');
                      if (ok) {
                        setDialogo(null);
                        setEditandoEvento(null);
                      }
                    }
                  }}
                  disabled={guardando}
                  style={{ marginRight: 'auto' }}
                >
                  Eliminar evento
                </button>
              )}
              <button type="button" className="btn" onClick={() => { setDialogo(null); setEditandoEvento(null); }}>
                Cancelar
              </button>
              <button type="submit" className="btn btn--principal" disabled={guardando}>
                {guardando ? 'Guardando…' : (editandoEvento ? 'Guardar cambios' : 'Registrar evento')}
              </button>
            </div>
          </form>
        </Dialogo>
      )}

      {dialogo === 'tratamiento' && seleccionada !== null && (
        <Dialogo titulo={editandoTratamiento ? "Modificar tratamiento" : "Registrar tratamiento"} onCerrar={() => { setDialogo(null); setEditandoTratamiento(null); }}>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              let ok;
              if (editandoTratamiento) {
                ok = await enviar(
                  `${API_BASE_URL}/tratamientos/${editandoTratamiento.id}`,
                  nuevoTratamiento,
                  'Tratamiento modificado.',
                  'PUT',
                );
              } else {
                ok = await enviar(
                  `${API_BASE_URL}/tratamientos`,
                  { paciente_id: seleccionada, ...nuevoTratamiento },
                  'Tratamiento registrado.',
                );
              }
              if (ok) {
                setEditandoTratamiento(null);
                setNuevoTratamiento({
                  tipo_tratamiento: 'Crioterapia',
                  fecha_tratamiento: '',
                  ginecologo_responsable: '',
                  observaciones: '',
                });
              }
            }}
          >
            <div className="dialogo-cuerpo">
              {errorForm && (
                <p className="error-form" role="alert">
                  <AlertTriangle size={16} aria-hidden="true" />
                  {errorForm}
                </p>
              )}

              <div className="campo-par">
                <div className="campo">
                  <label htmlFor="nt-tipo">Tipo de tratamiento</label>
                  <select
                    id="nt-tipo"
                    value={nuevoTratamiento.tipo_tratamiento}
                    onChange={(e) =>
                      setNuevoTratamiento({ ...nuevoTratamiento, tipo_tratamiento: e.target.value })
                    }
                  >
                    <option>Crioterapia</option>
                    <option>Termocoagulación</option>
                    <option>Conización</option>
                    <option>Histerectomía</option>
                  </select>
                </div>
                <div className="campo">
                  <label htmlFor="nt-fecha">Fecha del tratamiento</label>
                  <input
                    id="nt-fecha"
                    type="date"
                    value={nuevoTratamiento.fecha_tratamiento}
                    onChange={(e) =>
                      setNuevoTratamiento({ ...nuevoTratamiento, fecha_tratamiento: e.target.value })
                    }
                    required
                  />
                </div>
              </div>

              <p className="consecuencia">
                {nuevoTratamiento.tipo_tratamiento === 'Crioterapia' ||
                nuevoTratamiento.tipo_tratamiento === 'Termocoagulación'
                  ? 'Programa controles cada 6 meses a partir de esta fecha.'
                  : 'Cierra el seguimiento de tamizaje: el cuello uterino queda seccionado o extirpado. Detalla la justificación en observaciones.'}
              </p>

              <div className="campo">
                <label htmlFor="nt-gine">Ginecólogo responsable</label>
                <input
                  id="nt-gine"
                  value={nuevoTratamiento.ginecologo_responsable}
                  onChange={(e) =>
                    setNuevoTratamiento({ ...nuevoTratamiento, ginecologo_responsable: e.target.value })
                  }
                />
              </div>

              <div className="campo">
                <label htmlFor="nt-obs">Observaciones</label>
                <textarea
                  id="nt-obs"
                  value={nuevoTratamiento.observaciones}
                  onChange={(e) => setNuevoTratamiento({ ...nuevoTratamiento, observaciones: e.target.value })}
                  required={
                    nuevoTratamiento.tipo_tratamiento === 'Conización' ||
                    nuevoTratamiento.tipo_tratamiento === 'Histerectomía'
                  }
                />
              </div>
            </div>

            <div className="dialogo-pie">
              {editandoTratamiento && (
                <button
                  type="button"
                  className="btn btn--danger"
                  onClick={async () => {
                    if (window.confirm('¿Está seguro de eliminar este tratamiento? Esta acción no se puede deshacer.')) {
                      const ok = await enviar(`${API_BASE_URL}/tratamientos/${editandoTratamiento.id}`, null, 'Tratamiento eliminado.', 'DELETE');
                      if (ok) {
                        setDialogo(null);
                        setEditandoTratamiento(null);
                      }
                    }
                  }}
                  disabled={guardando}
                  style={{ marginRight: 'auto' }}
                >
                  Eliminar tratamiento
                </button>
              )}
              <button type="button" className="btn" onClick={() => { setDialogo(null); setEditandoTratamiento(null); }}>
                Cancelar
              </button>
              <button type="submit" className="btn btn--principal" disabled={guardando}>
                {guardando ? 'Guardando…' : (editandoTratamiento ? 'Guardar cambios' : 'Registrar tratamiento')}
              </button>
            </div>
          </form>
        </Dialogo>
      )}

      {/* --- Parto --- */}
      {dialogo === 'parto' && seleccionada !== null && (
        <Dialogo titulo="Registrar parto" onCerrar={() => setDialogo(null)}>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const ok = await enviar(
                `${API_BASE_URL}/gestaciones/parto`,
                { paciente_id: seleccionada, fecha_nacimiento_real: fechaParto },
                'Parto registrado. Seguimiento reactivado.',
              );
              if (ok) setFechaParto('');
            }}
          >
            <div className="dialogo-cuerpo">
              {errorForm && (
                <p className="error-form" role="alert">
                  <AlertTriangle size={16} aria-hidden="true" />
                  {errorForm}
                </p>
              )}

              <div className="campo">
                <label htmlFor="pa-fecha">Fecha real de nacimiento</label>
                <input
                  id="pa-fecha"
                  type="date"
                  value={fechaParto}
                  onChange={(e) => setFechaParto(e.target.value)}
                  required
                />
              </div>

              <p className="consecuencia consecuencia--pausa">
                Finaliza la pausa por gestación. El puerperio termina 42 días después del parto y a partir
                de esa fecha se reanudan los controles pendientes.
              </p>
            </div>

            <div className="dialogo-pie">
              <button type="button" className="btn" onClick={() => setDialogo(null)}>
                Cancelar
              </button>
              <button type="submit" className="btn btn--principal" disabled={guardando}>
                {guardando ? 'Guardando…' : 'Registrar parto'}
              </button>
            </div>
          </form>
        </Dialogo>
      )}

      {/* --- Cierre de Sesión --- */}
      {mostrarConfirmarSalir && (
        <Dialogo titulo="Confirmar cierre de sesión" onCerrar={() => setMostrarConfirmarSalir(false)}>
          <div className="dialogo-cuerpo">
            <p>¿Está segura de que desea cerrar la sesión en el Gestor Mari?</p>
            <p className="informe-ident" style={{ marginTop: '0.5rem' }}>
              Deberá volver a ingresar sus credenciales para acceder al registro de pacientes.
            </p>
          </div>
          <div className="dialogo-pie">
            <button
              type="button"
              className="btn btn--danger"
              onClick={() => {
                setMostrarConfirmarSalir(false);
                cerrarSesion();
              }}
            >
              Cerrar sesión
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => setMostrarConfirmarSalir(false)}
            >
              Cancelar
            </button>
          </div>
        </Dialogo>
      )}
    </div>
  );
}
