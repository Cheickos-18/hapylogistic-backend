// routes/disputes.js — Litiges HapyLogistic
const express = require('express');
const router  = express.Router();
const db      = require('../config/database');
const auth    = require('../middleware/auth');

// ── GET /api/disputes/me ─────────────────────────────────────
// Retourne les litiges du client connecté (avec infos de route)
router.get('/me', auth, async (req, res) => {
  try {
    const [rows] = await db.execute(`
      SELECT
        d.id,
        d.booking_id,
        d.reason,
        d.description,
        d.status,
        d.resolution,
        d.created_at,
        d.updated_at,
        l.origin      AS origin,
        l.destination AS destination
      FROM disputes d
      JOIN bookings b  ON d.booking_id = b.id
      JOIN listings l  ON b.listing_id = l.id
      WHERE d.client_id = ?
      ORDER BY d.created_at DESC
    `, [req.user.id]);

    res.json({ disputes: rows });
  } catch (err) {
    console.error('Erreur GET /disputes/me:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── GET /api/disputes/:id ────────────────────────────────────
// Détail d'un litige (client ou transporteur concerné)
router.get('/:id', auth, async (req, res) => {
  try {
    const [rows] = await db.execute(`
      SELECT
        d.*,
        l.origin, l.destination
      FROM disputes d
      JOIN bookings b ON d.booking_id = b.id
      JOIN listings l ON b.listing_id = l.id
      WHERE d.id = ?
    `, [req.params.id]);

    if (!rows.length) return res.status(404).json({ error: 'Litige introuvable' });
    const dispute = rows[0];

    // Seuls le client et le transporteur concernés peuvent consulter
    if (dispute.client_id !== req.user.id && dispute.carrier_id !== req.user.id) {
      return res.status(403).json({ error: 'Non autorisé' });
    }

    res.json({ dispute });
  } catch (err) {
    console.error('Erreur GET /disputes/:id:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;
