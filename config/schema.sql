-- ─────────────────────────────────────────────
--  HapyLogistic — Base de données MySQL
--  Exécutez ce script dans phpMyAdmin
--  hPanel → Bases de données → phpMyAdmin
-- ─────────────────────────────────────────────

CREATE DATABASE IF NOT EXISTS hapylogistic_db
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

USE hapylogistic_db;

-- ── UTILISATEURS ──
CREATE TABLE IF NOT EXISTS users (
  id            VARCHAR(36)  PRIMARY KEY DEFAULT (UUID()),
  first_name    VARCHAR(100) NOT NULL,
  last_name     VARCHAR(100) NOT NULL,
  email         VARCHAR(255) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  phone         VARCHAR(30),
  role          ENUM('client','carrier') NOT NULL DEFAULT 'client',
  country       VARCHAR(100),
  status        ENUM('pending_kyc','active','suspended') DEFAULT 'active',
  -- Carrier fields
  carrier_level  ENUM('bronze','argent','or') DEFAULT 'bronze',
  carrier_type   ENUM('air','fret','both'),
  total_trips    INT DEFAULT 0,
  average_rating DECIMAL(3,2) DEFAULT 0.00,
  -- Stripe
  stripe_customer_id  VARCHAR(100),
  stripe_account_id   VARCHAR(100),
  -- Timestamps
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_email (email),
  INDEX idx_role  (role)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ── ANNONCES ──
CREATE TABLE IF NOT EXISTS listings (
  id              VARCHAR(36)  PRIMARY KEY DEFAULT (UUID()),
  carrier_id      VARCHAR(36)  NOT NULL,
  origin          VARCHAR(200) NOT NULL,
  destination     VARCHAR(200) NOT NULL,
  country_from    VARCHAR(100),
  country_to      VARCHAR(100),
  zone            ENUM('af','am','me','eu','as','other') DEFAULT 'af',
  departure_date  DATE NOT NULL,
  available_kg    DECIMAL(6,2) NOT NULL,
  price_per_kg    DECIMAL(8,2) NOT NULL,
  type            ENUM('air','fret') DEFAULT 'air',
  description     TEXT,
  status          ENUM('active','full','cancelled','completed') DEFAULT 'active',
  created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (carrier_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_status      (status),
  INDEX idx_destination (destination),
  INDEX idx_departure   (departure_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ── RÉSERVATIONS ──
CREATE TABLE IF NOT EXISTS bookings (
  id                VARCHAR(36)    PRIMARY KEY DEFAULT (UUID()),
  listing_id        VARCHAR(36)    NOT NULL,
  client_id         VARCHAR(36)    NOT NULL,
  carrier_id        VARCHAR(36)    NOT NULL,
  weight_kg         DECIMAL(6,2)   NOT NULL,
  parcel_type       VARCHAR(100),
  recipient_name    VARCHAR(200),
  recipient_phone   VARCHAR(30),
  special_notes     TEXT,
  -- Montants
  base_amount       DECIMAL(10,2)  NOT NULL,
  client_fee        DECIMAL(10,2)  NOT NULL,
  carrier_fee       DECIMAL(10,2)  NOT NULL,
  client_total      DECIMAL(10,2)  NOT NULL,
  carrier_net       DECIMAL(10,2)  NOT NULL,
  platform_fee      DECIMAL(10,2)  NOT NULL,
  -- Stripe
  payment_intent_id VARCHAR(200),
  -- Statut
  status            ENUM('awaiting_payment','paid','in_transit','delivered','completed','disputed','refunded','cancelled') DEFAULT 'awaiting_payment',
  -- Dates
  delivered_at      TIMESTAMP NULL,
  confirmed_by      VARCHAR(50),
  created_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (listing_id)  REFERENCES listings(id),
  FOREIGN KEY (client_id)   REFERENCES users(id),
  FOREIGN KEY (carrier_id)  REFERENCES users(id),
  INDEX idx_client_id  (client_id),
  INDEX idx_carrier_id (carrier_id),
  INDEX idx_status     (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ── LITIGES ──
CREATE TABLE IF NOT EXISTS disputes (
  id                VARCHAR(36) PRIMARY KEY DEFAULT (UUID()),
  booking_id        VARCHAR(36) NOT NULL,
  client_id         VARCHAR(36) NOT NULL,
  carrier_id        VARCHAR(36) NOT NULL,
  reason            VARCHAR(200),
  description       TEXT,
  status            ENUM('open','mediation','resolved','closed') DEFAULT 'open',
  resolution        TEXT,
  payment_intent_id VARCHAR(200),
  created_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (booking_id) REFERENCES bookings(id),
  FOREIGN KEY (client_id)  REFERENCES users(id),
  FOREIGN KEY (carrier_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ── AVIS ──
CREATE TABLE IF NOT EXISTS reviews (
  id          VARCHAR(36)   PRIMARY KEY DEFAULT (UUID()),
  booking_id  VARCHAR(36)   NOT NULL UNIQUE,
  client_id   VARCHAR(36)   NOT NULL,
  carrier_id  VARCHAR(36)   NOT NULL,
  rating      TINYINT       NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment     TEXT,
  created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (booking_id) REFERENCES bookings(id),
  FOREIGN KEY (client_id)  REFERENCES users(id),
  FOREIGN KEY (carrier_id) REFERENCES users(id),
  INDEX idx_carrier_id (carrier_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ── NOTIFICATIONS ──
CREATE TABLE IF NOT EXISTS notifications (
  id         VARCHAR(36) PRIMARY KEY DEFAULT (UUID()),
  user_id    VARCHAR(36) NOT NULL,
  type       VARCHAR(100),
  title      VARCHAR(255),
  message    TEXT,
  is_read    TINYINT(1) DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_user_id (user_id),
  INDEX idx_is_read (is_read)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ── DONNÉES DE DÉMONSTRATION ──
INSERT IGNORE INTO users (id, first_name, last_name, email, password_hash, role, country, status, carrier_level, carrier_type, total_trips, average_rating)
VALUES
  ('demo-carrier-1', 'Nadia', 'D.', 'nadia@demo.com', '$2b$10$demo', 'carrier', 'France', 'active', 'or', 'air', 91, 4.90),
  ('demo-carrier-2', 'Kofi',  'B.', 'kofi@demo.com',  '$2b$10$demo', 'carrier', 'UK',     'active', 'or', 'air', 62, 4.80),
  ('demo-carrier-3', 'Aicha', 'M.', 'aicha@demo.com', '$2b$10$demo', 'carrier', 'France', 'active', 'argent', 'fret', 38, 4.70);

INSERT IGNORE INTO listings (id, carrier_id, origin, destination, country_from, country_to, zone, departure_date, available_kg, price_per_kg, type)
VALUES
  ('demo-lst-1', 'demo-carrier-1', 'Paris, France',   'Abidjan, Côte d\'Ivoire', 'France', 'Ivory Coast', 'af', DATE_ADD(CURDATE(), INTERVAL 7 DAY),  8,  7.00, 'air'),
  ('demo-lst-2', 'demo-carrier-2', 'London, UK',      'Accra, Ghana',            'UK',     'Ghana',       'af', DATE_ADD(CURDATE(), INTERVAL 10 DAY), 5,  8.00, 'air'),
  ('demo-lst-3', 'demo-carrier-3', 'Lyon, France',    'Dakar, Sénégal',          'France', 'Senegal',     'af', DATE_ADD(CURDATE(), INTERVAL 14 DAY), 20, 5.00, 'fret');

SELECT 'Base de données HapyLogistic créée avec succès !' AS message;
