package db

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// LoadEnv reads .env file and sets environment variables manually.
func LoadEnv() {
	// Look for .env in current directory or parent directory
	envPaths := []string{".env", "../.env", "../../.env"}
	var file *os.File
	var err error
	for _, path := range envPaths {
		file, err = os.Open(path)
		if err == nil {
			break
		}
	}
	if err != nil {
		return
	}
	defer file.Close()

	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		parts := strings.SplitN(line, "=", 2)
		if len(parts) == 2 {
			key := strings.TrimSpace(parts[0])
			val := strings.TrimSpace(parts[1])
			val = strings.Trim(val, `"'`)
			os.Setenv(key, val)
		}
	}
}

// ConnectDB initializes a PostgreSQL connection pool using pgxpool.
func ConnectDB(ctx context.Context) (*pgxpool.Pool, error) {
	LoadEnv()
	dbURL := os.Getenv("DATABASE_URL") // Transaction-mode pooler is preferred for standard API
	if dbURL == "" {
		dbURL = os.Getenv("DIRECT_URL")
	}
	if dbURL == "" {
		return nil, fmt.Errorf("neither DATABASE_URL nor DIRECT_URL is set in environment")
	}

	config, err := pgxpool.ParseConfig(dbURL)
	if err != nil {
		return nil, fmt.Errorf("unable to parse database URL: %w", err)
	}

	// Disable prepared statements cache for PgBouncer compatibility in transaction mode
	config.ConnConfig.DefaultQueryExecMode = pgx.QueryExecModeSimpleProtocol

	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		return nil, fmt.Errorf("unable to connect to database: %w", err)
	}

	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("unable to ping database: %w", err)
	}

	return pool, nil
}
