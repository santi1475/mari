package handlers

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"

	"gestormari/internal/models"

	"github.com/jackc/pgx/v5/pgxpool"
)

type PatientHandler struct {
	Pool *pgxpool.Pool
}

func NewPatientHandler(pool *pgxpool.Pool) *PatientHandler {
	return &PatientHandler{Pool: pool}
}

// SendJSON helper to write JSON responses
func SendJSON(w http.ResponseWriter, status int, data interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(data)
}

// SendError helper to write standard JSON error messages
func SendError(w http.ResponseWriter, status int, message string) {
	SendJSON(w, status, map[string]string{"error": message})
}

// ListPatients handles GET /api/pacientes
func (h *PatientHandler) ListPatients(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		SendError(w, http.StatusMethodNotAllowed, "Method not allowed")
		return
	}

	ctx := r.Context()
	search := strings.TrimSpace(r.URL.Query().Get("search"))
	estado := strings.TrimSpace(r.URL.Query().Get("estado"))

	// Base SQL Query. The two correlated subqueries derive the follow-up window the
	// patient list is built around: when she was last seen, and when she is next due.
	query := `
		SELECT p.id, p.dni, p.nombres, p.historia_clinica, p.estado_actual, p.fecha_registro,
		       (SELECT MAX(e.fecha_evento) FROM eventos_clinicos e WHERE e.paciente_id = p.id) AS ultimo_evento,
		       (SELECT MAX(e.fecha_proximo_control) FROM eventos_clinicos e WHERE e.paciente_id = p.id) AS proximo_control
		FROM pacientes p
		WHERE p.eliminado = FALSE
	`
	args := []interface{}{}
	argIndex := 1

	if search != "" {
		query += " AND (p.nombres ILIKE $" + strconv.Itoa(argIndex) +
			" OR p.dni ILIKE $" + strconv.Itoa(argIndex+1) +
			" OR p.historia_clinica ILIKE $" + strconv.Itoa(argIndex+2) + ")"
		searchPattern := "%" + search + "%"
		args = append(args, searchPattern, searchPattern, searchPattern)
		argIndex += 3
	}

	// "vencidas" and "proximas" are follow-up windows, not values of estado_actual:
	// only a patient whose tracking is running can be overdue for a control.
	switch estado {
	case "":
		// no filter
	case "vencidas":
		query += ` AND p.estado_actual = 'Activa'
			AND (SELECT MAX(e.fecha_proximo_control) FROM eventos_clinicos e WHERE e.paciente_id = p.id) < CURRENT_DATE`
	case "proximas":
		query += ` AND p.estado_actual = 'Activa'
			AND (SELECT MAX(e.fecha_proximo_control) FROM eventos_clinicos e WHERE e.paciente_id = p.id)
			    BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '30 days'`
	default:
		query += " AND p.estado_actual = $" + strconv.Itoa(argIndex)
		args = append(args, estado)
		argIndex++
	}

	// Urgency first: the list answers "who do I call today", so the soonest due date
	// leads and patients with no scheduled control fall to the end.
	query += " ORDER BY proximo_control ASC NULLS LAST, p.nombres ASC"

	rows, err := h.Pool.Query(ctx, query, args...)
	if err != nil {
		SendError(w, http.StatusInternalServerError, "Database query error: "+err.Error())
		return
	}
	defer rows.Close()

	patients := []models.Patient{}
	for rows.Next() {
		var p models.Patient
		err := rows.Scan(&p.ID, &p.DNI, &p.Nombres, &p.HistoriaClinica, &p.EstadoActual, &p.FechaRegistro,
			&p.UltimoEvento, &p.ProximoControl)
		if err != nil {
			SendError(w, http.StatusInternalServerError, "Error scanning patient: "+err.Error())
			return
		}
		patients = append(patients, p)
	}

	SendJSON(w, http.StatusOK, patients)
}

// GetPatientDetail handles GET /api/pacientes/{id}
func (h *PatientHandler) GetPatientDetail(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		SendError(w, http.StatusMethodNotAllowed, "Method not allowed")
		return
	}

	ctx := r.Context()

	// Simple path param extraction
	parts := strings.Split(r.URL.Path, "/")
	if len(parts) < 4 {
		SendError(w, http.StatusBadRequest, "Invalid URL path")
		return
	}
	idStr := parts[3]
	patientID, err := strconv.Atoi(idStr)
	if err != nil {
		SendError(w, http.StatusBadRequest, "Invalid patient ID")
		return
	}

	var detail models.PatientDetail

	// 1. Get Patient General Info
	err = h.Pool.QueryRow(ctx,
		"SELECT id, dni, nombres, historia_clinica, estado_actual, fecha_registro FROM pacientes WHERE id = $1 AND eliminado = FALSE",
		patientID,
	).Scan(&detail.Patient.ID, &detail.Patient.DNI, &detail.Patient.Nombres, &detail.Patient.HistoriaClinica, &detail.Patient.EstadoActual, &detail.Patient.FechaRegistro)

	if err != nil {
		SendError(w, http.StatusNotFound, "Patient not found")
		return
	}

	// 2. Get Contact Details
	var c models.Contact
	err = h.Pool.QueryRow(ctx,
		"SELECT id, paciente_id, celular, direccion, distrito FROM contactos WHERE paciente_id = $1",
		patientID,
	).Scan(&c.ID, &c.PacienteID, &c.Celular, &c.Direccion, &c.Distrito)
	if err == nil {
		detail.Contact = &c
	}

	// 3. Get Pregnancy History
	pRows, err := h.Pool.Query(ctx,
		"SELECT id, paciente_id, fecha_probable_parto, fecha_nacimiento_real, fecha_fin_puerperio, activa FROM gestaciones WHERE paciente_id = $1 ORDER BY id DESC",
		patientID,
	)
	if err == nil {
		defer pRows.Close()
		detail.Gestaciones = []models.Pregnancy{}
		for pRows.Next() {
			var g models.Pregnancy
			pRows.Scan(&g.ID, &g.PacienteID, &g.FechaProbableParto, &g.FechaNacimientoReal, &g.FechaFinPuerperio, &g.Activa)
			detail.Gestaciones = append(detail.Gestaciones, g)
		}
	}

	// 4. Get Clinical Events History
	eRows, err := h.Pool.Query(ctx,
		"SELECT id, paciente_id, tipo_evento, fecha_evento, resultado, establecimiento, fecha_proximo_control, observaciones FROM eventos_clinicos WHERE paciente_id = $1 ORDER BY fecha_evento DESC, id DESC",
		patientID,
	)
	if err == nil {
		defer eRows.Close()
		detail.Eventos = []models.ClinicalEvent{}
		for eRows.Next() {
			var ev models.ClinicalEvent
			eRows.Scan(&ev.ID, &ev.PacienteID, &ev.TipoEvento, &ev.FechaEvento, &ev.Resultado, &ev.Establecimiento, &ev.FechaProximoControl, &ev.Observaciones)
			detail.Eventos = append(detail.Eventos, ev)
		}
	}

	// 5. Get Treatment History
	tRows, err := h.Pool.Query(ctx,
		"SELECT id, paciente_id, tipo_tratamiento, fecha_tratamiento, ginecologo_responsable, observaciones FROM tratamientos WHERE paciente_id = $1 ORDER BY fecha_tratamiento DESC",
		patientID,
	)
	if err == nil {
		defer tRows.Close()
		detail.Tratamientos = []models.Treatment{}
		for tRows.Next() {
			var tr models.Treatment
			tRows.Scan(&tr.ID, &tr.PacienteID, &tr.TipoTratamiento, &tr.FechaTratamiento, &tr.GinecologoResponsable, &tr.Observaciones)
			detail.Tratamientos = append(detail.Tratamientos, tr)
		}
	}

	SendJSON(w, http.StatusOK, detail)
}

// CreatePatientRequest defines expected payload for registering a patient
type CreatePatientRequest struct {
	DNI             string    `json:"dni"`
	Nombres         string    `json:"nombres"`
	HistoriaClinica string    `json:"historia_clinica"`
	Celular         string    `json:"celular"`
	Direccion       string    `json:"direccion"`
	Distrito        string    `json:"distrito"`
	FechaToma       string    `json:"fecha_toma"` // DD/MM/YYYY
	ResultadoVPH    string    `json:"resultado_vph"` // e.g. "VPH 16, VPH Otros A/R"
	Observaciones   string    `json:"observaciones"`
}

// CreatePatient handles POST /api/pacientes
func (h *PatientHandler) CreatePatient(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		SendError(w, http.StatusMethodNotAllowed, "Method not allowed")
		return
	}

	ctx := r.Context()
	var req CreatePatientRequest
	err := json.NewDecoder(r.Body).Decode(&req)
	if err != nil {
		SendError(w, http.StatusBadRequest, "Invalid JSON body")
		return
	}

	req.DNI = strings.TrimSpace(req.DNI)
	req.Nombres = strings.TrimSpace(req.Nombres)

	if req.DNI == "" || req.Nombres == "" {
		SendError(w, http.StatusBadRequest, "DNI and Nombres are required fields")
		return
	}

	var parsedTomaDate *time.Time
	if req.FechaToma != "" {
		t, err := time.Parse("02/01/2006", req.FechaToma)
		if err == nil {
			parsedTomaDate = &t
		} else {
			// Try ISO layout
			t, err = time.Parse("2006-01-02", req.FechaToma)
			if err == nil {
				parsedTomaDate = &t
			}
		}
	}

	tx, err := h.Pool.Begin(ctx)
	if err != nil {
		SendError(w, http.StatusInternalServerError, "Database transaction error: "+err.Error())
		return
	}
	defer tx.Rollback(ctx)

	// 1. Check if patient exists (even if soft-deleted)
	var patientID int
	var existingEliminado bool
	err = tx.QueryRow(ctx, "SELECT id, eliminado FROM pacientes WHERE dni = $1", req.DNI).Scan(&patientID, &existingEliminado)
	if err == nil {
		// Patient exists!
		if existingEliminado {
			// Reactivate the soft-deleted patient (idempotency!)
			_, err = tx.Exec(ctx,
				"UPDATE pacientes SET nombres = $1, historia_clinica = $2, estado_actual = $3, eliminado = FALSE WHERE id = $4",
				req.Nombres, req.HistoriaClinica, "Activa", patientID,
			)
			if err != nil {
				SendError(w, http.StatusInternalServerError, "Error reactivating soft-deleted patient: "+err.Error())
				return
			}
			
			// Update contact info (since it might have changed)
			_, err = tx.Exec(ctx,
				"UPDATE contactos SET celular = $1, direccion = $2, distrito = $3 WHERE paciente_id = $4",
				req.Celular, req.Direccion, req.Distrito, patientID,
			)
			if err != nil {
				SendError(w, http.StatusInternalServerError, "Error updating contact: "+err.Error())
				return
			}
		} else {
			// Already exists and is active, return success to be idempotent
			tx.Commit(ctx)
			SendJSON(w, http.StatusOK, map[string]interface{}{
				"message":    "Patient already exists (idempotent)",
				"paciente_id": patientID,
			})
			return
		}
	} else {
		// Insert new patient
		err = tx.QueryRow(ctx,
			"INSERT INTO pacientes (dni, nombres, historia_clinica, estado_actual) VALUES ($1, $2, $3, $4) RETURNING id",
			req.DNI, req.Nombres, req.HistoriaClinica, "Activa",
		).Scan(&patientID)
		if err != nil {
			SendError(w, http.StatusConflict, "Error inserting patient (DNI or HCL may already exist): "+err.Error())
			return
		}

		// Insert Contact
		_, err = tx.Exec(ctx,
			"INSERT INTO contactos (paciente_id, celular, direccion, distrito) VALUES ($1, $2, $3, $4)",
			patientID, req.Celular, req.Direccion, req.Distrito,
		)
		if err != nil {
			SendError(w, http.StatusInternalServerError, "Error inserting contact: "+err.Error())
			return
		}
	}

	// 3. Create initial Molecular VPH Positive event
	obsText := "Tamizaje VPH positivo inicial. "
	if req.ResultadoVPH != "" {
		obsText += "Cepa(s): " + req.ResultadoVPH + ". "
	}
	obsText += req.Observaciones

	_, err = tx.Exec(ctx,
		"INSERT INTO eventos_clinicos (paciente_id, tipo_evento, fecha_evento, resultado, observaciones) VALUES ($1, $2, $3, $4, $5)",
		patientID, "Molecular", parsedTomaDate, "POSITIVO", obsText,
	)
	if err != nil {
		SendError(w, http.StatusInternalServerError, "Error inserting molecular event: "+err.Error())
		return
	}

	err = tx.Commit(ctx)
	if err != nil {
		SendError(w, http.StatusInternalServerError, "Database transaction commit error: "+err.Error())
		return
	}

	SendJSON(w, http.StatusCreated, map[string]interface{}{
		"message":    "Patient registered successfully",
		"paciente_id": patientID,
	})
}

// UpdatePatientRequest defines expected payload for editing a patient
type UpdatePatientRequest struct {
	DNI             string `json:"dni"`
	Nombres         string `json:"nombres"`
	HistoriaClinica string `json:"historia_clinica"`
	EstadoActual    string `json:"estado_actual"`
	Celular         string `json:"celular"`
	Direccion       string `json:"direccion"`
	Distrito        string `json:"distrito"`
}

// UpdatePatient handles PUT /api/pacientes/{id}
func (h *PatientHandler) UpdatePatient(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPut {
		SendError(w, http.StatusMethodNotAllowed, "Method not allowed")
		return
	}

	ctx := r.Context()
	parts := strings.Split(r.URL.Path, "/")
	if len(parts) < 4 {
		SendError(w, http.StatusBadRequest, "Invalid URL path")
		return
	}
	idStr := parts[3]
	patientID, err := strconv.Atoi(idStr)
	if err != nil {
		SendError(w, http.StatusBadRequest, "Invalid patient ID")
		return
	}

	var req UpdatePatientRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		SendError(w, http.StatusBadRequest, "Invalid JSON body")
		return
	}

	req.DNI = strings.TrimSpace(req.DNI)
	req.Nombres = strings.TrimSpace(req.Nombres)
	req.EstadoActual = strings.TrimSpace(req.EstadoActual)

	if req.DNI == "" || req.Nombres == "" || req.EstadoActual == "" {
		SendError(w, http.StatusBadRequest, "DNI, Nombres, and EstadoActual are required fields")
		return
	}

	tx, err := h.Pool.Begin(ctx)
	if err != nil {
		SendError(w, http.StatusInternalServerError, "Database transaction error: "+err.Error())
		return
	}
	defer tx.Rollback(ctx)

	// Update Patients table
	_, err = tx.Exec(ctx,
		"UPDATE pacientes SET dni = $1, nombres = $2, historia_clinica = $3, estado_actual = $4 WHERE id = $5",
		req.DNI, req.Nombres, req.HistoriaClinica, req.EstadoActual, patientID,
	)
	if err != nil {
		SendError(w, http.StatusInternalServerError, "Error updating patient: "+err.Error())
		return
	}

	// Update or Insert Contact Details
	var contactExists bool
	err = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM contactos WHERE paciente_id = $1)", patientID).Scan(&contactExists)
	if err != nil {
		SendError(w, http.StatusInternalServerError, "Database check error: "+err.Error())
		return
	}

	if contactExists {
		_, err = tx.Exec(ctx,
			"UPDATE contactos SET celular = $1, direccion = $2, distrito = $3 WHERE paciente_id = $4",
			req.Celular, req.Direccion, req.Distrito, patientID,
		)
	} else {
		_, err = tx.Exec(ctx,
			"INSERT INTO contactos (paciente_id, celular, direccion, distrito) VALUES ($1, $2, $3, $4)",
			patientID, req.Celular, req.Direccion, req.Distrito,
		)
	}
	if err != nil {
		SendError(w, http.StatusInternalServerError, "Error updating contact: "+err.Error())
		return
	}

	if err := tx.Commit(ctx); err != nil {
		SendError(w, http.StatusInternalServerError, "Transaction commit error: "+err.Error())
		return
	}

	SendJSON(w, http.StatusOK, map[string]string{"message": "Patient updated successfully"})
}

// DeletePatient handles DELETE /api/pacientes/{id} (logical deletion/soft delete)
func (h *PatientHandler) DeletePatient(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodDelete {
		SendError(w, http.StatusMethodNotAllowed, "Method not allowed")
		return
	}

	ctx := r.Context()
	parts := strings.Split(r.URL.Path, "/")
	if len(parts) < 4 {
		SendError(w, http.StatusBadRequest, "Invalid URL path")
		return
	}
	idStr := parts[3]
	patientID, err := strconv.Atoi(idStr)
	if err != nil {
		SendError(w, http.StatusBadRequest, "Invalid patient ID")
		return
	}

	_, err = h.Pool.Exec(ctx, "UPDATE pacientes SET eliminado = TRUE WHERE id = $1", patientID)
	if err != nil {
		SendError(w, http.StatusInternalServerError, "Error deleting patient: "+err.Error())
		return
	}

	SendJSON(w, http.StatusOK, map[string]string{"message": "Patient deleted logically"})
}
