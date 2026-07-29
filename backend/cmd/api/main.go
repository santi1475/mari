package main

import (
	"context"
	"log"
	"net/http"
	"os"

	"gestormari/internal/db"
	"gestormari/internal/handlers"
	"gestormari/internal/middleware"
)

func main() {
	log.Println("Starting gestormari API backend...")

	ctx := context.Background()

	// 1. Initialize PostgreSQL Connection Pool (Supabase)
	pool, err := db.ConnectDB(ctx)
	if err != nil {
		log.Fatalf("Critical error connecting to database: %v", err)
	}
	defer pool.Close()

	log.Println("Database connection pool established successfully.")

	// Run dynamic schema migration to ensure column 'eliminado' exists
	_, err = pool.Exec(ctx, "ALTER TABLE pacientes ADD COLUMN IF NOT EXISTS eliminado BOOLEAN DEFAULT FALSE NOT NULL")
	if err != nil {
		log.Printf("Warning: Failed to run schema migration: %v\n", err)
	} else {
		log.Println("Database schema checked/updated successfully (eliminado column verified).")
	}

	// 2. Initialize Handlers
	patientHandler := handlers.NewPatientHandler(pool)
	eventHandler := handlers.NewEventHandler(pool)

	// 3. Set up Routing using Go Standard Library mux
	mux := http.NewServeMux()

	// Patients API Endpoints (Protected)
	mux.Handle("/api/pacientes", middleware.AuthMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost {
			patientHandler.CreatePatient(w, r)
		} else if r.Method == http.MethodGet {
			patientHandler.ListPatients(w, r)
		} else {
			handlers.SendError(w, http.StatusMethodNotAllowed, "Method not allowed")
		}
	})))

	mux.Handle("/api/pacientes/", middleware.AuthMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			patientHandler.GetPatientDetail(w, r)
		} else if r.Method == http.MethodPut {
			patientHandler.UpdatePatient(w, r)
		} else if r.Method == http.MethodDelete {
			patientHandler.DeletePatient(w, r)
		} else {
			handlers.SendError(w, http.StatusMethodNotAllowed, "Method not allowed")
		}
	})))

	// Events and Treatments API Endpoints (Protected)
	mux.Handle("/api/eventos", middleware.AuthMiddleware(http.HandlerFunc(eventHandler.CreateEvent)))
	mux.Handle("/api/tratamientos", middleware.AuthMiddleware(http.HandlerFunc(eventHandler.CreateTreatment)))
	mux.Handle("/api/gestaciones/parto", middleware.AuthMiddleware(http.HandlerFunc(eventHandler.RegisterBirth)))

	// Auth Debug (Protected - tests if token and secret are correct)
	mux.Handle("/api/auth/debug", middleware.AuthMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		userID := r.Context().Value(middleware.UserIDKey)
		handlers.SendJSON(w, http.StatusOK, map[string]interface{}{
			"authenticated": true,
			"user_id":       userID,
			"message":       "Felicidades, el SUPABASE_JWT_SECRET en el .env es correcto y está validando tokens con éxito.",
		})
	})))

	// Health Check (Public)
	mux.HandleFunc("/api/health", func(w http.ResponseWriter, r *http.Request) {
		handlers.SendJSON(w, http.StatusOK, map[string]string{"status": "healthy"})
	})

	// 4. Wrap Routing with CORS middleware for Frontend consumption
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	log.Printf("Server listening on port %s...\n", port)
	err = http.ListenAndServe(":"+port, enableCORS(middleware.LoggingMiddleware(mux)))
	if err != nil {
		log.Fatalf("Server error: %v", err)
	}
}

// enableCORS provides cross-origin resource sharing headers for frontend API consumers.
func enableCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS, PUT, DELETE")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
		
		// Handle preflight options requests
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusOK)
			return
		}
		
		next.ServeHTTP(w, r)
	})
}
