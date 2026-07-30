package models

import (
	"time"
)

// Patient represents the patients table
type Patient struct {
	ID             int       `json:"id"`
	DNI            string    `json:"dni"`
	Nombres        string    `json:"nombres"`
	HistoriaClinica *string   `json:"historia_clinica"` 
	EstadoActual   string    `json:"estado_actual"`   
	FechaRegistro  time.Time `json:"fecha_registro"`

	UltimoEvento   *time.Time `json:"ultimo_evento,omitempty"`
	ProximoControl *time.Time `json:"proximo_control,omitempty"`
	CepaVPH        string     `json:"cepa_vph,omitempty"`
}

// Contact represents the contactos table
type Contact struct {
	ID        int     `json:"id"`
	PacienteID int    `json:"paciente_id"`
	Celular   *string `json:"celular"`
	Direccion *string `json:"direccion"`
	Distrito  *string `json:"distrito"`
}

// Pregnancy represents the gestaciones table
type Pregnancy struct {
	ID                 int        `json:"id"`
	PacienteID         int        `json:"paciente_id"`
	FechaProbableParto *time.Time `json:"fecha_probable_parto"`
	FechaNacimientoReal *time.Time `json:"fecha_nacimiento_real"`
	FechaFinPuerperio  *time.Time `json:"fecha_fin_puerperio"`
	Activa             bool       `json:"activa"`
}

// ClinicalEvent represents the eventos_clinicos table
type ClinicalEvent struct {
	ID                 int        `json:"id"`
	PacienteID         int        `json:"paciente_id"`
	TipoEvento         string     `json:"tipo_evento"` 
	FechaEvento        *time.Time `json:"fecha_evento"`
	Resultado          *string    `json:"resultado"`
	Establecimiento    *string    `json:"establecimiento"`
	FechaProximoControl *time.Time `json:"fecha_proximo_control"`
	Observaciones      *string    `json:"observaciones"`
}

// Treatment represents the tratamientos table
type Treatment struct {
	ID                   int        `json:"id"`
	PacienteID           int        `json:"paciente_id"`
	TipoTratamiento      string     `json:"tipo_tratamiento"` 
	FechaTratamiento     *time.Time `json:"fecha_tratamiento"`
	GinecologoResponsable *string    `json:"ginecologo_responsable"`
	Observaciones        *string    `json:"observaciones"`
}

// PatientDetail includes a patient and all of their associated records
type PatientDetail struct {
	Patient        Patient          `json:"patient"`
	Contact        *Contact         `json:"contact,omitempty"`
	Gestaciones    []Pregnancy      `json:"gestaciones,omitempty"`
	Eventos        []ClinicalEvent  `json:"eventos,omitempty"`
	Tratamientos   []Treatment      `json:"tratamientos,omitempty"`
}
