package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"

	"gestormari/internal/db"

	"github.com/xuri/excelize/v2"
)

// dateRegex matches DD/MM/YYYY or DD-MM-YYYY or MM/DD/YY patterns
var dateRegex = regexp.MustCompile(`(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})`)

// parseCleanDate tries to parse a date from Excel cell value, stripping trailing letters (like "C")
func parseCleanDate(val string) (time.Time, string, bool) {
	val = strings.TrimSpace(val)
	if val == "" {
		return time.Time{}, "", false
	}

	// Extract any trailing indicator like "C" or "N"
	indicator := ""
	cleanVal := val
	if strings.HasSuffix(strings.ToUpper(val), " C") || strings.HasSuffix(strings.ToUpper(val), ", C") || strings.HasSuffix(strings.ToUpper(val), ",C") {
		indicator = "C"
		cleanVal = strings.TrimSuffix(strings.TrimSuffix(strings.TrimSuffix(val, "C"), "c"), ",")
		cleanVal = strings.TrimSpace(cleanVal)
	}

	// Try reading as float (Excel serial number)
	if f, err := strconv.ParseFloat(cleanVal, 64); err == nil {
		t, err := excelize.ExcelDateToTime(f, false)
		if err == nil {
			return t, indicator, true
		}
	}

	// Match regex pattern
	matches := dateRegex.FindStringSubmatch(cleanVal)
	if len(matches) == 4 {
		dStr := matches[1]
		mStr := matches[2]
		yStr := matches[3]

		day, _ := strconv.Atoi(dStr)
		month, _ := strconv.Atoi(mStr)
		year, _ := strconv.Atoi(yStr)

		if year < 100 {
			if year > 50 {
				year += 1900
			} else {
				year += 2000
			}
		}

		// Excel data in Peru standard is DD/MM/YYYY
		t := time.Date(year, time.Month(month), day, 0, 0, 0, 0, time.UTC)
		return t, indicator, true
	}

	// Fallback layout checks
	layouts := []string{
		"02/01/2006", "2/1/2006", "02-01-2006", "2-1-2006",
		"02/01/06", "02-01-06", "2006-01-02", "1/2/06", "1/2/2006",
	}
	for _, layout := range layouts {
		if t, err := time.Parse(layout, cleanVal); err == nil {
			return t, indicator, true
		}
	}

	return time.Time{}, "", false
}

func main() {
	log.Println("Starting VPH Patient Excel Data Migration...")

	ctx := context.Background()

	// 1. Connect to Supabase
	pool, err := db.ConnectDB(ctx)
	if err != nil {
		log.Fatalf("Error connecting to database: %v", err)
	}
	defer pool.Close()

	// 2. Read and apply schema.sql
	log.Println("Initializing database schema...")
	schemaBytes, err := os.ReadFile("schema.sql")
	if err != nil {
		log.Fatalf("Error reading schema.sql: %v", err)
	}

	_, err = pool.Exec(ctx, string(schemaBytes))
	if err != nil {
		log.Fatalf("Error executing schema.sql: %v", err)
	}
	log.Println("Schema initialized successfully.")

	// 3. Open Excel File
	f, err := excelize.OpenFile("VPH POSTIVOS 2023_2025.xlsx")
	if err != nil {
		log.Fatalf("Error opening Excel file: %v", err)
	}
	defer f.Close()

	sheets := f.GetSheetList()
	if len(sheets) == 0 {
		log.Fatal("Excel file has no sheets.")
	}
	sheetName := sheets[0]
	log.Printf("Reading data from sheet: %s\n", sheetName)

	rows, err := f.GetRows(sheetName)
	if err != nil {
		log.Fatalf("Error reading sheet rows: %v", err)
	}

	if len(rows) < 3 {
		log.Fatal("Excel sheet does not contain enough data rows.")
	}

	log.Printf("Found %d total rows (including headers).\n", len(rows))

	importedCount := 0
	skippedCount := 0

	// Loop starting at index 2 (skip Row 0 major headers and Row 1 subheaders)
	for i := 2; i < len(rows); i++ {
		row := rows[i]
		if len(row) < 12 {
			skippedCount++
			continue
		}

		pacienteName := strings.TrimSpace(row[6])
		dni := strings.TrimSpace(row[7])

		if pacienteName == "" || dni == "" {
			skippedCount++
			continue
		}

		celular := ""
		if len(row) > 8 {
			celular = strings.TrimSpace(row[8])
		}
		hcl := ""
		if len(row) > 9 {
			hcl = strings.TrimSpace(row[9])
		}
		direccion := ""
		if len(row) > 10 {
			direccion = strings.TrimSpace(row[10])
		}

		vph16 := ""
		if len(row) > 17 {
			vph16 = strings.TrimSpace(row[17])
		}
		vph18 := ""
		if len(row) > 18 {
			vph18 = strings.TrimSpace(row[18])
		}
		vphOtros := ""
		if len(row) > 19 {
			vphOtros = strings.TrimSpace(row[19])
		}

		obstetrician := ""
		if len(row) > 49 {
			obstetrician = strings.TrimSpace(row[49])
		}

		log.Printf("[%d] Processing: %s (DNI: %s)\n", i, pacienteName, dni)

		// Start Database Transaction for this Patient
		tx, err := pool.Begin(ctx)
		if err != nil {
			log.Printf("Error starting transaction for row %d: %v\n", i, err)
			continue
		}

		// Insert Patient
		var pacienteID int
		err = tx.QueryRow(ctx,
			"INSERT INTO pacientes (dni, nombres, historia_clinica, estado_actual) VALUES ($1, $2, $3, $4) ON CONFLICT (dni) DO UPDATE SET nombres = EXCLUDED.nombres RETURNING id",
			dni, pacienteName, hcl, "Activa",
		).Scan(&pacienteID)

		if err != nil {
			log.Printf("Error inserting paciente %s: %v\n", pacienteName, err)
			tx.Rollback(ctx)
			continue
		}

		// Insert Contact
		_, err = tx.Exec(ctx,
			"INSERT INTO contactos (paciente_id, celular, direccion, distrito) VALUES ($1, $2, $3, $4)",
			pacienteID, celular, direccion, "Porvenir",
		)
		if err != nil {
			log.Printf("Error inserting contact for %s: %v\n", pacienteName, err)
			tx.Rollback(ctx)
			continue
		}

		// 4. Create Molecular Tamizaje Event
		tomaDateStr := strings.TrimSpace(row[3])
		tomaDate, _, parsed := parseCleanDate(tomaDateStr)
		var eventDate *time.Time
		if parsed {
			eventDate = &tomaDate
		}

		// Build molecular result detail based on virus tipification
		strains := []string{}
		if strings.ToUpper(vph16) == "X" || strings.ToUpper(vph16) == "SÍ" || strings.ToUpper(vph16) == "SI" {
			strains = append(strains, "VPH 16")
		}
		if strings.ToUpper(vph18) == "X" || strings.ToUpper(vph18) == "SÍ" || strings.ToUpper(vph18) == "SI" {
			strains = append(strains, "VPH 18")
		}
		if strings.ToUpper(vphOtros) == "X" || strings.ToUpper(vphOtros) == "SÍ" || strings.ToUpper(vphOtros) == "SI" {
			strains = append(strains, "VPH Otros A/R")
		}
		strainResult := strings.Join(strains, ", ")
		if strainResult == "" {
			strainResult = "VPH Positivo"
		}

		_, err = tx.Exec(ctx,
			"INSERT INTO eventos_clinicos (paciente_id, tipo_evento, fecha_evento, resultado, observaciones) VALUES ($1, $2, $3, $4, $5)",
			pacienteID, "Molecular", eventDate, "POSITIVO", fmt.Sprintf("Cepa(s): %s. Registrado por: %s", strainResult, obstetrician),
		)
		if err != nil {
			log.Printf("Error inserting molecular event for %s: %v\n", pacienteName, err)
			tx.Rollback(ctx)
			continue
		}

		// 5. Create Colposcopy Event (if exists)
		colpoDateStr := ""
		if len(row) > 24 {
			colpoDateStr = strings.TrimSpace(row[24])
		}
		colpoResult := ""
		if len(row) > 25 {
			colpoResult = strings.TrimSpace(row[25])
		}

		colpoDate, _, parsedColpo := parseCleanDate(colpoDateStr)
		if parsedColpo {
			_, err = tx.Exec(ctx,
				"INSERT INTO eventos_clinicos (paciente_id, tipo_evento, fecha_evento, resultado, observaciones) VALUES ($1, $2, $3, $4, $5)",
				pacienteID, "Colposcopia", colpoDate, colpoResult, "Registrado en migración histórica",
			)
			if err != nil {
				log.Printf("Error inserting colposcopy event for %s: %v\n", pacienteName, err)
				tx.Rollback(ctx)
				continue
			}

			// If patient is pregnant, pause the flow
			if strings.Contains(strings.ToUpper(colpoResult), "GESTANDO") || strings.Contains(strings.ToUpper(colpoResult), "EMBARAZADA") {
				_, err = tx.Exec(ctx,
					"UPDATE pacientes SET estado_actual = $1 WHERE id = $2",
					"Pausada", pacienteID,
				)
				if err != nil {
					log.Printf("Error updating state to Pausada for %s: %v\n", pacienteName, err)
				}

				// Insert into gestaciones with active flag
				_, err = tx.Exec(ctx,
					"INSERT INTO gestaciones (paciente_id, activa) VALUES ($1, $2)",
					pacienteID, true,
				)
				if err != nil {
					log.Printf("Error inserting pregnancy record for %s: %v\n", pacienteName, err)
				}
			}
		}

		// 6. Create Controls (1°, 2°, 3° Control)
		// 1° Control
		ctrl1DateStr := ""
		if len(row) > 26 {
			ctrl1DateStr = strings.TrimSpace(row[26])
		}
		ctrl1Result := ""
		if len(row) > 27 {
			ctrl1Result = strings.TrimSpace(row[27])
		}
		ctrl1Date, _, parsedCtrl1 := parseCleanDate(ctrl1DateStr)
		if parsedCtrl1 {
			_, err = tx.Exec(ctx,
				"INSERT INTO eventos_clinicos (paciente_id, tipo_evento, fecha_evento, resultado) VALUES ($1, $2, $3, $4)",
				pacienteID, "Control 1", ctrl1Date, ctrl1Result,
			)
			if err != nil {
				log.Printf("Error inserting Control 1 for %s: %v\n", pacienteName, err)
			}
		}

		// 2° Control
		ctrl2DateStr := ""
		if len(row) > 28 {
			ctrl2DateStr = strings.TrimSpace(row[28])
		}
		ctrl2Result := ""
		if len(row) > 29 {
			ctrl2Result = strings.TrimSpace(row[29])
		}
		ctrl2Date, _, parsedCtrl2 := parseCleanDate(ctrl2DateStr)
		if parsedCtrl2 {
			_, err = tx.Exec(ctx,
				"INSERT INTO eventos_clinicos (paciente_id, tipo_evento, fecha_evento, resultado) VALUES ($1, $2, $3, $4)",
				pacienteID, "Control 2", ctrl2Date, ctrl2Result,
			)
			if err != nil {
				log.Printf("Error inserting Control 2 for %s: %v\n", pacienteName, err)
			}
		}

		// 3° Control
		ctrl3DateStr := ""
		if len(row) > 30 {
			ctrl3DateStr = strings.TrimSpace(row[30])
		}
		ctrl3Result := ""
		if len(row) > 31 {
			ctrl3Result = strings.TrimSpace(row[31])
		}
		ctrl3Date, _, parsedCtrl3 := parseCleanDate(ctrl3DateStr)
		if parsedCtrl3 {
			_, err = tx.Exec(ctx,
				"INSERT INTO eventos_clinicos (paciente_id, tipo_evento, fecha_evento, resultado) VALUES ($1, $2, $3, $4)",
				pacienteID, "Control 3", ctrl3Date, ctrl3Result,
			)
			if err != nil {
				log.Printf("Error inserting Control 3 for %s: %v\n", pacienteName, err)
			}
		}

		// 7. Create Treatments (Crioterapia / Termocoagulación)
		treatDateStr := ""
		if len(row) > 32 {
			treatDateStr = strings.TrimSpace(row[32])
		}
		treatProcedure := ""
		if len(row) > 33 {
			treatProcedure = strings.TrimSpace(row[33])
		}
		observations := ""
		if len(row) > 34 {
			observations = strings.TrimSpace(row[34])
		}

		treatDate, _, parsedTreat := parseCleanDate(treatDateStr)
		if parsedTreat {
			// Normalize treatment names
			normalizedTreat := treatProcedure
			upperTreat := strings.ToUpper(treatProcedure)
			if strings.Contains(upperTreat, "CRIO") {
				normalizedTreat = "Crioterapia"
			} else if strings.Contains(upperTreat, "TERMO") {
				normalizedTreat = "Termocoagulación"
			} else if strings.Contains(upperTreat, "CONI") {
				normalizedTreat = "Conización"
			} else if strings.Contains(upperTreat, "HISTE") {
				normalizedTreat = "Histerectomía"
			}

			_, err = tx.Exec(ctx,
				"INSERT INTO tratamientos (paciente_id, tipo_tratamiento, fecha_tratamiento, observaciones) VALUES ($1, $2, $3, $4)",
				pacienteID, normalizedTreat, treatDate, observations,
			)
			if err != nil {
				log.Printf("Error inserting treatment for %s: %v\n", pacienteName, err)
			}
		}

		// Commit Patient Transaction
		err = tx.Commit(ctx)
		if err != nil {
			log.Printf("Error committing transaction for %s: %v\n", pacienteName, err)
			continue
		}

		importedCount++
	}

	log.Println("\n==============================================")
	log.Printf("Excel Migration Completed Successfully!\n")
	log.Printf("  Total Patients Imported: %d\n", importedCount)
	log.Printf("  Total Rows Skipped/Invalid: %d\n", skippedCount)
	log.Println("==============================================")
}
