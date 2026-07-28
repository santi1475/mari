-- schema.sql
-- Database Schema for HPV Patient Tracking System (gestormari)

-- Drop existing tables to ensure clean initialization
DROP TABLE IF EXISTS tratamientos CASCADE;
DROP TABLE IF EXISTS eventos_clinicos CASCADE;
DROP TABLE IF EXISTS gestaciones CASCADE;
DROP TABLE IF EXISTS contactos CASCADE;
DROP TABLE IF EXISTS pacientes CASCADE;

-- Patients Table
CREATE TABLE pacientes (
    id SERIAL PRIMARY KEY,
    dni VARCHAR(20) UNIQUE NOT NULL,
    nombres VARCHAR(250) NOT NULL,
    historia_clinica VARCHAR(50),
    estado_actual VARCHAR(50) DEFAULT 'Activa' NOT NULL, -- Activa, Pausada, Derivada, Cerrada
    fecha_registro TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
    eliminado BOOLEAN DEFAULT FALSE NOT NULL
);

-- Contact Information Table
CREATE TABLE contactos (
    id SERIAL PRIMARY KEY,
    paciente_id INTEGER NOT NULL REFERENCES pacientes(id) ON DELETE CASCADE,
    celular VARCHAR(50),
    direccion TEXT,
    distrito VARCHAR(100)
);

-- Pregnancy Tracking Table
CREATE TABLE gestaciones (
    id SERIAL PRIMARY KEY,
    paciente_id INTEGER NOT NULL REFERENCES pacientes(id) ON DELETE CASCADE,
    fecha_probable_parto DATE,
    fecha_nacimiento_real DATE,
    fecha_fin_puerperio DATE, -- Calculated as FPP + 42 days (end of puerperio)
    activa BOOLEAN DEFAULT TRUE NOT NULL
);

-- Clinical Events (Molecular test, Colposcopy, Controls, Referrals)
CREATE TABLE eventos_clinicos (
    id SERIAL PRIMARY KEY,
    paciente_id INTEGER NOT NULL REFERENCES pacientes(id) ON DELETE CASCADE,
    tipo_evento VARCHAR(100) NOT NULL, -- Molecular, Colposcopia, Control, Biopsia, Referencia
    fecha_evento DATE,
    resultado VARCHAR(250),
    establecimiento VARCHAR(150),
    fecha_proximo_control DATE,
    observaciones TEXT
);

-- Treatments Table (Cryotherapy, Thermo-coagulation, Conization, Hysterectomy)
CREATE TABLE tratamientos (
    id SERIAL PRIMARY KEY,
    paciente_id INTEGER NOT NULL REFERENCES pacientes(id) ON DELETE CASCADE,
    tipo_tratamiento VARCHAR(100) NOT NULL, -- Crioterapia, Termocoagulación, Conización, Histerectomía
    fecha_tratamiento DATE,
    ginecologo_responsable VARCHAR(200),
    observaciones TEXT
);

-- Create indexes for performance on frequent queries
CREATE INDEX idx_pacientes_dni ON pacientes(dni);
CREATE INDEX idx_pacientes_historia ON pacientes(historia_clinica);
CREATE INDEX idx_eventos_paciente ON eventos_clinicos(paciente_id);
CREATE INDEX idx_eventos_fecha ON eventos_clinicos(fecha_evento);
