package handlers

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

type EventHandler struct {
	Pool *pgxpool.Pool
}

func NewEventHandler(pool *pgxpool.Pool) *EventHandler {
	return &EventHandler{Pool: pool}
}

type CreateEventRequest struct {
	PacienteID      int    `json:"paciente_id"`
	TipoEvento      string `json:"tipo_evento"` // Molecular, Colposcopia, Control, Biopsia, Referencia
	FechaEvento     string `json:"fecha_evento"` // YYYY-MM-DD or DD/MM/YYYY
	Resultado       string `json:"resultado"`
	Establecimiento string `json:"establecimiento"`
	Observaciones   string `json:"observaciones"`
	// Required when Resultado is "Gestando": without it the pause has no anchor and
	// the +42 day reactivation can never be computed.
	FechaProbableParto string `json:"fecha_probable_parto"`
}

// parseFecha accepts the ISO value a date input submits, and the DD/MM/YYYY the
// historical Excel records use.
func parseFecha(v string) (time.Time, bool) {
	v = strings.TrimSpace(v)
	if v == "" {
		return time.Time{}, false
	}
	if t, err := time.Parse("2006-01-02", v); err == nil {
		return t, true
	}
	if t, err := time.Parse("02/01/2006", v); err == nil {
		return t, true
	}
	return time.Time{}, false
}

// CreateEvent handles POST /api/eventos
func (h *EventHandler) CreateEvent(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		SendError(w, http.StatusMethodNotAllowed, "Method not allowed")
		return
	}

	ctx := r.Context()
	var req CreateEventRequest
	err := json.NewDecoder(r.Body).Decode(&req)
	if err != nil {
		SendError(w, http.StatusBadRequest, "Invalid JSON body")
		return
	}

	if req.PacienteID <= 0 || req.TipoEvento == "" {
		SendError(w, http.StatusBadRequest, "PacienteID and TipoEvento are required")
		return
	}

	parsedDate := time.Now()
	if strings.TrimSpace(req.FechaEvento) != "" {
		t, ok := parseFecha(req.FechaEvento)
		if !ok {
			SendError(w, http.StatusBadRequest, "Invalid date format, use YYYY-MM-DD or DD/MM/YYYY")
			return
		}
		parsedDate = t
	}

	// Begin database transaction to apply state machine rules
	tx, err := h.Pool.Begin(ctx)
	if err != nil {
		SendError(w, http.StatusInternalServerError, "Transaction error: "+err.Error())
		return
	}
	defer tx.Rollback(ctx)

	// Verify patient exists and get current state
	var exists bool
	err = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM pacientes WHERE id = $1)", req.PacienteID).Scan(&exists)
	if err != nil || !exists {
		SendError(w, http.StatusNotFound, "Patient not found")
		return
	}

	// Check if this event already exists to make it idempotent
	var existingID int
	err = tx.QueryRow(ctx,
		"SELECT id FROM eventos_clinicos WHERE paciente_id = $1 AND tipo_evento = $2 AND fecha_evento = $3",
		req.PacienteID, req.TipoEvento, parsedDate,
	).Scan(&existingID)
	if err == nil {
		tx.Commit(ctx)
		SendJSON(w, http.StatusOK, map[string]interface{}{
			"message":   "Event already exists (idempotent)",
			"evento_id": existingID,
		})
		return
	}

	// 1. Core Clinical Business Rules - Calculate next control alert
	var nextControlDate *time.Time
	tipoUpper := strings.ToUpper(req.TipoEvento)
	resUpper := strings.ToUpper(req.Resultado)

	if tipoUpper == "COLPOSCOPIA" || strings.Contains(tipoUpper, "CONTROL") {
		if resUpper == "NORMAL" || resUpper == "N" {
			// Rule: 1 year (12 months) for normal colposcopy/controls
			future := parsedDate.AddDate(1, 0, 0)
			nextControlDate = &future
		} else if resUpper == "POSITIVO" || strings.Contains(resUpper, "NIC") {
			// Rule: 6 months for positive/abnormal results
			future := parsedDate.AddDate(0, 6, 0)
			nextControlDate = &future
		} else if strings.Contains(resUpper, "GESTANDO") || strings.Contains(resUpper, "EMBARAZADA") {
			// Rule: Pregnancy pauses flow, changes status to Pausada and registers active gestacion.
			// The FPP is what makes the pause reversible, so it is required here rather
			// than optional: reactivation is FPP + 42 days (end of puerperio).
			fpp, ok := parseFecha(req.FechaProbableParto)
			if !ok {
				SendError(w, http.StatusBadRequest, "Se requiere la fecha probable de parto (FPP) para pausar el seguimiento por gestación")
				return
			}
			finPuerperio := fpp.AddDate(0, 0, 42)

			_, err = tx.Exec(ctx, "UPDATE pacientes SET estado_actual = 'Pausada' WHERE id = $1", req.PacienteID)
			if err != nil {
				SendError(w, http.StatusInternalServerError, "Error updating patient state: "+err.Error())
				return
			}

			// Deactivate other active pregnancies (if any) and insert new one
			tx.Exec(ctx, "UPDATE gestaciones SET activa = false WHERE paciente_id = $1", req.PacienteID)
			_, err = tx.Exec(ctx,
				"INSERT INTO gestaciones (paciente_id, fecha_probable_parto, fecha_fin_puerperio, activa) VALUES ($1, $2, $3, true)",
				req.PacienteID, fpp, finPuerperio,
			)
			if err != nil {
				SendError(w, http.StatusInternalServerError, "Error inserting gestacion record: "+err.Error())
				return
			}

			// Estimated resume date, superseded by the real one when the birth is registered.
			nextControlDate = &finPuerperio
		}
	} else if tipoUpper == "BIOPSIA" {
		if resUpper == "NORMAL" || resUpper == "NEGATIVO" || resUpper == "N" {
			// Rule: Biopsy normal returns immediately to normal annual controls
			future := parsedDate.AddDate(1, 0, 0)
			nextControlDate = &future
		} else if strings.Contains(strings.ToUpper(req.Establecimiento), "IREN") || resUpper == "CÁNCER" || resUpper == "CANCER" {
			// Rule: Positive / Severe biopsy referred to IREN, change state to Derivada (IREN)
			_, err = tx.Exec(ctx, "UPDATE pacientes SET estado_actual = 'Derivada' WHERE id = $1", req.PacienteID)
			if err != nil {
				SendError(w, http.StatusInternalServerError, "Error updating patient state to Derivada: "+err.Error())
				return
			}
		}
	} else if tipoUpper == "MOLECULAR" {
		if resUpper == "NEGATIVO" || resUpper == "NORMAL" || resUpper == "N" {
			// Rule: VPH molecular test negative after normal colposcopies/controls -> Alta Médica (Cerrada)
			_, err = tx.Exec(ctx, "UPDATE pacientes SET estado_actual = 'Cerrada' WHERE id = $1", req.PacienteID)
			if err != nil {
				SendError(w, http.StatusInternalServerError, "Error closing patient track: "+err.Error())
				return
			}
		}
	}

	// 2. Insert Clinical Event
	_, err = tx.Exec(ctx,
		`INSERT INTO eventos_clinicos (paciente_id, tipo_evento, fecha_evento, resultado, establecimiento, fecha_proximo_control, observaciones)
		 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
		req.PacienteID, req.TipoEvento, parsedDate, req.Resultado, req.Establecimiento, nextControlDate, req.Observaciones,
	)
	if err != nil {
		SendError(w, http.StatusInternalServerError, "Error creating clinical event: "+err.Error())
		return
	}

	err = tx.Commit(ctx)
	if err != nil {
		SendError(w, http.StatusInternalServerError, "Database transaction commit error: "+err.Error())
		return
	}

	SendJSON(w, http.StatusCreated, map[string]interface{}{
		"message":                   "Clinical event registered successfully",
		"fecha_proximo_control":     nextControlDate,
	})
}

type CreateTreatmentRequest struct {
	PacienteID           int    `json:"paciente_id"`
	TipoTratamiento      string `json:"tipo_tratamiento"` // Crioterapia, Termocoagulación, Conización, Histerectomía
	FechaTratamiento     string `json:"fecha_tratamiento"`
	GinecologoResponsable string `json:"ginecologo_responsable"`
	Observaciones        string `json:"observaciones"`
}

// CreateTreatment handles POST /api/tratamientos
func (h *EventHandler) CreateTreatment(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		SendError(w, http.StatusMethodNotAllowed, "Method not allowed")
		return
	}

	ctx := r.Context()
	var req CreateTreatmentRequest
	err := json.NewDecoder(r.Body).Decode(&req)
	if err != nil {
		SendError(w, http.StatusBadRequest, "Invalid JSON body")
		return
	}

	if req.PacienteID <= 0 || req.TipoTratamiento == "" {
		SendError(w, http.StatusBadRequest, "PacienteID and TipoTratamiento are required")
		return
	}

	parsedDate := time.Now()
	if strings.TrimSpace(req.FechaTratamiento) != "" {
		t, ok := parseFecha(req.FechaTratamiento)
		if !ok {
			SendError(w, http.StatusBadRequest, "Invalid date format, use YYYY-MM-DD or DD/MM/YYYY")
			return
		}
		parsedDate = t
	}

	tx, err := h.Pool.Begin(ctx)
	if err != nil {
		SendError(w, http.StatusInternalServerError, "Transaction error: "+err.Error())
		return
	}
	defer tx.Rollback(ctx)

	// Verify patient exists
	var exists bool
	err = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM pacientes WHERE id = $1)", req.PacienteID).Scan(&exists)
	if err != nil || !exists {
		SendError(w, http.StatusNotFound, "Patient not found")
		return
	}

	// Check if this treatment already exists to make it idempotent
	var existingID int
	err = tx.QueryRow(ctx,
		"SELECT id FROM tratamientos WHERE paciente_id = $1 AND tipo_tratamiento = $2 AND fecha_tratamiento = $3",
		req.PacienteID, req.TipoTratamiento, parsedDate,
	).Scan(&existingID)
	if err == nil {
		tx.Commit(ctx)
		SendJSON(w, http.StatusOK, map[string]interface{}{
			"message":      "Treatment already exists (idempotent)",
			"treatment_id": existingID,
		})
		return
	}

	// 1. Core Clinical Business Rules - Calculate control alerts post-treatment
	tipoUpper := strings.ToUpper(req.TipoTratamiento)

	if strings.Contains(tipoUpper, "CRIO") || strings.Contains(tipoUpper, "TERMO") {
		// Rule: Minor treatments (Crioterapia / Termocoagulación) -> Controls every 6 months
		future := parsedDate.AddDate(0, 6, 0)
		
		// Create automatic clinical event representing the next scheduled 6-month control
		_, err = tx.Exec(ctx,
			`INSERT INTO eventos_clinicos (paciente_id, tipo_evento, fecha_evento, resultado, observaciones, fecha_proximo_control)
			 VALUES ($1, $2, $3, $4, $5, $6)`,
			req.PacienteID, "Control Post-Tratamiento", parsedDate, "Tratado", "Tratamiento realizado: "+req.TipoTratamiento, future,
		)
		if err != nil {
			SendError(w, http.StatusInternalServerError, "Error creating post-treatment event: "+err.Error())
			return
		}
	} else if strings.Contains(tipoUpper, "HISTE") || strings.Contains(tipoUpper, "CONI") {
		// Rule: Major surgical interventions (Histerectomía / Conización) end tamizaje controls
		_, err = tx.Exec(ctx, "UPDATE pacientes SET estado_actual = 'Cerrada' WHERE id = $1", req.PacienteID)
		if err != nil {
			SendError(w, http.StatusInternalServerError, "Error closing patient case: "+err.Error())
			return
		}

		// Register a clinical closing event
		_, err = tx.Exec(ctx,
			`INSERT INTO eventos_clinicos (paciente_id, tipo_evento, fecha_evento, resultado, observaciones)
			 VALUES ($1, $2, $3, $4, $5)`,
			req.PacienteID, "Cierre Quirúrgico", parsedDate, "FINALIZADO", "Cierre por intervención quirúrgica: "+req.TipoTratamiento+". "+req.Observaciones,
		)
		if err != nil {
			SendError(w, http.StatusInternalServerError, "Error creating closing event: "+err.Error())
			return
		}
	}

	// 2. Insert Treatment Record
	_, err = tx.Exec(ctx,
		`INSERT INTO tratamientos (paciente_id, tipo_tratamiento, fecha_tratamiento, ginecologo_responsable, observaciones)
		 VALUES ($1, $2, $3, $4, $5)`,
		req.PacienteID, req.TipoTratamiento, parsedDate, req.GinecologoResponsable, req.Observaciones,
	)
	if err != nil {
		SendError(w, http.StatusInternalServerError, "Error creating treatment record: "+err.Error())
		return
	}

	err = tx.Commit(ctx)
	if err != nil {
		SendError(w, http.StatusInternalServerError, "Database transaction commit error: "+err.Error())
		return
	}

	SendJSON(w, http.StatusCreated, map[string]interface{}{
		"message": "Treatment registered successfully",
	})
}

type RegisterBirthRequest struct {
	PacienteID         int    `json:"paciente_id"`
	FechaNacimientoReal string `json:"fecha_nacimiento_real"` // YYYY-MM-DD or DD/MM/YYYY
}

// RegisterBirth handles POST /api/gestaciones/parto
func (h *EventHandler) RegisterBirth(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		SendError(w, http.StatusMethodNotAllowed, "Method not allowed")
		return
	}

	ctx := r.Context()
	var req RegisterBirthRequest
	err := json.NewDecoder(r.Body).Decode(&req)
	if err != nil {
		SendError(w, http.StatusBadRequest, "Invalid JSON body")
		return
	}

	if req.PacienteID <= 0 || req.FechaNacimientoReal == "" {
		SendError(w, http.StatusBadRequest, "PacienteID and FechaNacimientoReal are required")
		return
	}

	t, ok := parseFecha(req.FechaNacimientoReal)
	if !ok {
		SendError(w, http.StatusBadRequest, "Invalid date format, use YYYY-MM-DD or DD/MM/YYYY")
		return
	}

	tx, err := h.Pool.Begin(ctx)
	if err != nil {
		SendError(w, http.StatusInternalServerError, "Transaction error: "+err.Error())
		return
	}
	defer tx.Rollback(ctx)

	// Check if birth is already registered for this date to make it idempotent
	var existingID int
	err = tx.QueryRow(ctx,
		"SELECT id FROM gestaciones WHERE paciente_id = $1 AND fecha_nacimiento_real = $2",
		req.PacienteID, t,
	).Scan(&existingID)
	if err == nil {
		tx.Commit(ctx)
		SendJSON(w, http.StatusOK, map[string]interface{}{
			"message": "Birth already registered (idempotent)",
		})
		return
	}

	// 1. Calculate end of puerperio: birth date + 42 days
	finPuerperio := t.AddDate(0, 0, 42)

	// 2. Find and update active pregnancy record
	var gestacionID int
	err = tx.QueryRow(ctx,
		"UPDATE gestaciones SET fecha_nacimiento_real = $1, fecha_fin_puerperio = $2, activa = false WHERE paciente_id = $3 AND activa = true RETURNING id",
		t, finPuerperio, req.PacienteID,
	).Scan(&gestacionID)

	if err != nil {
		SendError(w, http.StatusNotFound, "No active pregnancy record found for this patient: "+err.Error())
		return
	}

	// 3. Reactivate patient state to Activa ("mujer inadvertida" ready to resume controls)
	_, err = tx.Exec(ctx,
		"UPDATE pacientes SET estado_actual = 'Activa' WHERE id = $1",
		req.PacienteID,
	)
	if err != nil {
		SendError(w, http.StatusInternalServerError, "Error updating patient state back to Activa: "+err.Error())
		return
	}

	// 4. Create clinical event logging birth and puerperio end
	_, err = tx.Exec(ctx,
		`INSERT INTO eventos_clinicos (paciente_id, tipo_evento, fecha_evento, resultado, observaciones, fecha_proximo_control)
		 VALUES ($1, $2, $3, $4, $5, $6)`,
		req.PacienteID, "Parto", t, "Fin de Gestación", "Nacimiento registrado. Puerperio finaliza el "+finPuerperio.Format("02/01/2006")+". Reanudación de controles.", finPuerperio,
	)
	if err != nil {
		SendError(w, http.StatusInternalServerError, "Error inserting birth clinical event: "+err.Error())
		return
	}

	err = tx.Commit(ctx)
	if err != nil {
		SendError(w, http.StatusInternalServerError, "Database transaction commit error: "+err.Error())
		return
	}

	SendJSON(w, http.StatusOK, map[string]interface{}{
		"message":              "Birth registered. Patient state reactivated to Activa.",
		"fecha_fin_puerperio":  finPuerperio,
	})
}
