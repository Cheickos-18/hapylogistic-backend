// ─────────────────────────────────────────────
//  HapyLogistic — Serveur principal
//  Node.js + Express + MySQL + Stripe Connect
//  Optimisé pour Hostinger Business
// ─────────────────────────────────────────────
require('dotenv').config();
const express   = require('express');
const cors      = require('cors');
const helmet    = require('helmet');
const rateLimit = require('express-rate-limit');

const app  = express();
const PORT = process.env.PORT || 3001;

// ── Sécurité ──────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));

// CORS — autorise le frontend Hostinger
app.use(cors({
  origin: [
    process.env.FRONTEND_URL || 'https://hapylogistic.com',
    'http://localhost:3000',
    'http://localhost:5500',
  ],
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
}));

// Rate limiting
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 200 });
const strict  = rateLimit({ windowMs: 60 * 1000, max: 20 });
app.use('/api/', limiter);
app.use('/api/auth/', strict);
app.use('/api/payments/', strict);

// ── IMPORTANT : webhook Stripe AVANT express.json() ──
app.use('/api/webhooks/stripe', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));

// ── Routes ────────────────────────────────────
app.use('/api/auth',     require('./routes/auth'));
app.use('/api/listings', require('./routes/listings'));
app.use('/api/payments', require('./routes/payments'));
app.use('/api/reviews',  require('./routes/reviews'));
app.use('/api/webhooks', require('./routes/webhooks'));

// ── Health check (pour Hostinger monitoring) ──
app.get('/health', (req, res) => {
  res.json({
    status:  'ok',
    service: 'HapyLogistic API',
    version: '1.0.0',
    env:     process.env.NODE_ENV || 'development',
    time:    new Date().toISOString(),
  });
});

// ── Infos API (racine) ────────────────────────
app.get('/', (req, res) => {
  res.json({
    name:    'HapyLogistic API',
    version: '1.0.0',
    docs:    '/health',
    routes: [
      'POST /api/auth/register',
      'POST /api/auth/login',
      'GET  /api/auth/me',
      'GET  /api/listings',
      'POST /api/listings',
      'POST /api/payments/intent',
      'POST /api/payments/confirm-delivery/:id',
      'POST /api/payments/capture/:id',
      'GET  /api/payments/bookings/me',
      'POST /api/reviews',
      'GET  /api/reviews/carrier/:id',
    ]
  });
});

// ── 404 ───────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: 'Route introuvable' });
});

// ── Erreur globale ────────────────────────────
app.use((err, req, res, next) => {
  console.error('Erreur:', err.message);
  res.status(500).json({ error: 'Erreur serveur interne' });
});

// ── Démarrage ─────────────────────────────────
app.listen(PORT, () => {
  console.log(`
  ╔══════════════════════════════════════╗
  ║   HapyLogistic API                  ║
  ║   Port    : ${PORT}                    ║
  ║   Mode    : ${process.env.NODE_ENV || 'development'}              ║
  ║   Health  : http://localhost:${PORT}/health ║
  ╚══════════════════════════════════════╝
  `);
});

module.exports = app;
