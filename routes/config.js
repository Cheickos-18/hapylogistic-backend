// ─────────────────────────────────────────────────────────────────────────────
//  routes/config.js — Endpoint GET /api/config
//  Expose la clé publique Stripe (et autres config publiques) au frontend
//  sans jamais exposer les clés secrètes.
//
//  Dans server.js : app.use('/api', require('./routes/config'));
// ─────────────────────────────────────────────────────────────────────────────
const express = require('express');
const router = express.Router();

router.get('/config', (req, res) => {
  res.json({
    stripePk: process.env.STRIPE_PUBLIC_KEY, // pk_live_... en production
    version: '1.0.0',
  });
});

module.exports = router;
