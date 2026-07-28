package middleware

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log"
	"math/big"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"gestormari/internal/handlers"

	"github.com/golang-jwt/jwt/v5"
)

type contextKey string

const UserIDKey contextKey = "user_id"

// JWKey matches the structure of keys inside JWKS json
type JWKey struct {
	Alg string   `json:"alg"`
	Kty string   `json:"kty"`
	Kid string   `json:"kid"`
	X   string   `json:"x"`
	Y   string   `json:"y"`
	Crv string   `json:"crv"`
}

type JWKS struct {
	Keys []JWKey `json:"keys"`
}

func (k *JWKey) ToPublicKey() (*ecdsa.PublicKey, error) {
	if k.Kty != "EC" || k.Crv != "P-256" {
		return nil, fmt.Errorf("unsupported key type or curve: %s, %s", k.Kty, k.Crv)
	}
	xBytes, err := base64.RawURLEncoding.DecodeString(k.X)
	if err != nil {
		return nil, fmt.Errorf("error decoding x: %w", err)
	}
	yBytes, err := base64.RawURLEncoding.DecodeString(k.Y)
	if err != nil {
		return nil, fmt.Errorf("error decoding y: %w", err)
	}
	return &ecdsa.PublicKey{
		Curve: elliptic.P256(),
		X:     new(big.Int).SetBytes(xBytes),
		Y:     new(big.Int).SetBytes(yBytes),
	}, nil
}

var (
	jwkCache     = make(map[string]*ecdsa.PublicKey)
	jwkCacheLock sync.RWMutex
	lastFetched  time.Time
)

func getProjectRef() string {
	dbURL := os.Getenv("DATABASE_URL")
	if dbURL == "" {
		dbURL = os.Getenv("DIRECT_URL")
	}
	if dbURL == "" {
		return ""
	}
	parts := strings.Split(dbURL, "@")
	if len(parts) < 2 {
		return ""
	}
	left := parts[0]
	subparts := strings.Split(left, "://")
	userPass := subparts[len(subparts)-1]
	userOnly := strings.Split(userPass, ":")[0]
	userParts := strings.Split(userOnly, ".")
	if len(userParts) == 2 {
		return userParts[1]
	}
	return ""
}

func getJWKSURL() string {
	if url := os.Getenv("SUPABASE_JWKS_URL"); url != "" {
		return url
	}
	ref := getProjectRef()
	if ref != "" {
		return fmt.Sprintf("https://%s.supabase.co/auth/v1/.well-known/jwks.json", ref)
	}
	return ""
}

func fetchJWKS(jwksURL string) error {
	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Get(jwksURL)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("unexpected status code fetching JWKS: %d", resp.StatusCode)
	}

	var jwks JWKS
	if err := json.NewDecoder(resp.Body).Decode(&jwks); err != nil {
		return err
	}

	jwkCacheLock.Lock()
	defer jwkCacheLock.Unlock()

	for _, k := range jwks.Keys {
		pubKey, err := k.ToPublicKey()
		if err != nil {
			continue
		}
		jwkCache[k.Kid] = pubKey
	}
	lastFetched = time.Now()
	return nil
}

// AuthMiddleware validates Supabase JWT token against the SUPABASE_JWT_SECRET or JWKS public keys.
func AuthMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		jwtSecret := os.Getenv("SUPABASE_JWT_SECRET")

		authHeader := r.Header.Get("Authorization")
		if authHeader == "" {
			handlers.SendError(w, http.StatusUnauthorized, "Missing authorization token")
			return
		}

		parts := strings.Split(authHeader, " ")
		if len(parts) != 2 || strings.ToLower(parts[0]) != "bearer" {
			handlers.SendError(w, http.StatusUnauthorized, "Invalid authorization format. Use 'Bearer <token>'")
			return
		}

		tokenString := parts[1]

		// Parse and validate the token
		token, err := jwt.Parse(tokenString, func(t *jwt.Token) (interface{}, error) {
			alg, _ := t.Header["alg"].(string)

			// Support modern Supabase ES256 asymmetric signing
			if strings.ToUpper(alg) == "ES256" {
				kid, _ := t.Header["kid"].(string)
				if kid == "" {
					return nil, fmt.Errorf("missing kid in token header")
				}

				// RLock to inspect cache
				jwkCacheLock.RLock()
				pubKey, exists := jwkCache[kid]
				cacheAge := time.Since(lastFetched)
				jwkCacheLock.RUnlock()

				// Fetch JWKS dynamically if key not present or cache is expired (1 hr)
				if !exists || cacheAge > 1*time.Hour {
					jwksURL := getJWKSURL()
					if jwksURL != "" {
						_ = fetchJWKS(jwksURL)
						jwkCacheLock.RLock()
						pubKey, exists = jwkCache[kid]
						jwkCacheLock.RUnlock()
					}
				}

				if !exists {
					return nil, fmt.Errorf("public key not found for kid: %s", kid)
				}
				return pubKey, nil
			}

			// Fallback: HS256 symmetric signing (requires SUPABASE_JWT_SECRET)
			if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
				return nil, fmt.Errorf("unexpected signing method: %v", t.Header["alg"])
			}
			return []byte(jwtSecret), nil
		})

		if err != nil || !token.Valid {
			handlers.SendError(w, http.StatusUnauthorized, "Invalid or expired token: "+err.Error())
			return
		}

		if claims, ok := token.Claims.(jwt.MapClaims); ok {
			if sub, ok := claims["sub"].(string); ok {
				ctx := context.WithValue(r.Context(), UserIDKey, sub)
				next.ServeHTTP(w, r.WithContext(ctx))
				return
			}
		}

		next.ServeHTTP(w, r)
	})
}

// --- Request Logger Middleware ---

type responseWriterWrapper struct {
	http.ResponseWriter
	statusCode int
}

func (w *responseWriterWrapper) WriteHeader(code int) {
	w.statusCode = code
	w.ResponseWriter.WriteHeader(code)
}

func LoggingMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		wrapper := &responseWriterWrapper{ResponseWriter: w, statusCode: http.StatusOK}
		next.ServeHTTP(wrapper, r)
		log.Printf("[API] %s %s | Status: %d | Duration: %s", r.Method, r.URL.Path, wrapper.statusCode, time.Since(start))
	})
}
