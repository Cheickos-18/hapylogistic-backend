// routes/disputes.js — Litiges HapyLogistic
const express = require('express');
const router  = express.Router();
const db      = require('../config/database');
const auth    = require('../middleware/auth');

// ── GET /api/disputes/me ─────────────────────────────────────
// Client : ses propres litiges
router.get('/me', auth, async (req, res) => {
  try {
    const [rows] = await db.execute(`
      SELECT
        d.id, d.booking_id, d.reason, d.description,
        d.status, d.resolution, d.created_at, d.updated_at,
        d.resolved_by_client, d.resolved_by_carrier,
        b.client_total AS amount,
        l.origin, l.destination, l.departure_date,
        u.first_name AS carrier_first_name,
        u.last_name  AS carrier_last_name
      FROM disputes d
      JOIN bookings b ON d.booking_id = b.id
      JOIN listings l ON b.listing_id = l.id
      JOIN users    u ON d.carrier_id = u.id
      WHERE d.client_id = ?
      ORDER BY d.created_at DESC
    `, [req.user.id]);
    res.json({ disputes: rows });
  } catch (err) {
    console.error('Erreur GET /disputes/me:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── GET /api/disputes/carrier ────────────────────────────────
// Transporteur : litiges sur ses trajets
router.get('/carrier', auth, async (req, res) => {
  try {
    const [rows] = await db.execute(`
      SELECT
        d.id, d.booking_id, d.reason, d.description,
        d.status, d.resolution, d.created_at, d.updated_at,
        d.resolved_by_client, d.resolved_by_carrier,
        b.client_total AS amount,
        l.origin, l.destination, l.departure_date,
        u.first_name AS client_first_name,
        u.last_name  AS client_last_name
      FROM disputes d
      JOIN bookings b ON d.booking_id = b.id
      JOIN listings l ON b.listing_id = l.id
      JOIN users    u ON d.client_id  = u.id
      WHERE d.carrier_id = ?
      ORDER BY d.created_at DESC
    `, [req.user.id]);
    res.json({ disputes: rows });
  } catch (err) {
    console.error('Erreur GET /disputes/carrier:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── GET /api/disputes/:id ────────────────────────────────────
// Détail d'un litige (client ou transporteur concerné)
router.get('/:id', auth, async (req, res) => {
  try {
    const [rows] = await db.execute(`
      SELECT d.*, l.origin, l.destination
      FROM disputes d
      JOIN bookings b ON d.booking_id = b.id
      JOIN listings l ON b.listing_id = l.id
      WHERE d.id = ?
    `, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Litige introuvable' });
    const dispute = rows[0];
    if (dispute.client_id !== req.user.id && dispute.carrier_id !== req.user.id) {
      return res.status(403).json({ error: 'Non autorisé' });
    }
    res.json({ dispute });
  } catch (err) {
    console.error('Erreur GET /disputes/:id:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── POST /api/disputes/:id/respond ───────────────────────────
// Transporteur ou client : ajouter un message au fil du litige
router.post('/:id/respond', auth, async (req, res) => {
  const { message, role } = req.body;
  if (!message || !message.trim()) {
    return res.status(400).json({ error: 'Message requis' });
  }
  try {
    const [rows] = await db.execute(
      'SELECT * FROM disputes WHERE id = ?', [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Litige introuvable' });
    const dispute = rows[0];

    if (dispute.carrier_id !== req.user.id && dispute.client_id !== req.user.id) {
      return res.status(403).json({ error: 'Non autorisé' });
    }

    // Déterminer le rôle de l'expéditeur
    const senderRole = role ||
      (dispute.carrier_id === req.user.id ? 'carrier' : 'client');

    // Parser l'historique existant (rétrocompatible avec l'ancien format texte)
    let history = [];
    if (dispute.resolution) {
      try {
        const parsed = JSON.parse(dispute.resolution);
        if (Array.isArray(parsed)) {
          history = parsed;
        } else {
          // Ancien format JSON non-array : on l'ignore et repart de zéro
          history = [];
        }
      } catch (e) {
        // Ancien format texte brut "[Transporteur] message" → convertir en JSON
        const clean = dispute.resolution
          .replace(/^\[Transporteur\]\s*|\[Carrier\]\s*/i, '').trim();
        if (clean) {
          history = [{
            role: 'carrier',
            text: clean,
            ts: dispute.updated_at
              ? new Date(dispute.updated_at).toISOString()
              : new Date().toISOString()
          }];
        }
      }
    }

    // Ajouter le nouveau message
    history.push({
      role: senderRole,
      text: message.trim(),
      ts: new Date().toISOString()
    });

    await db.execute(
      'UPDATE disputes SET resolution = ?, updated_at = NOW() WHERE id = ?',
      [JSON.stringify(history), dispute.id]
    );

    res.json({ success: true, message: 'Réponse enregistrée', history });
  } catch (err) {
    console.error('Erreur POST /disputes/:id/respond:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── POST /api/disputes/:id/resolve ───────────────────────────
// Le client OU le transporteur marque le litige comme résolu de son côté.
// Quand les DEUX parties ont marqué, le litige passe en status='resolved'.
router.post('/:id/resolve', auth, async (req, res) => {
  try {
    const [rows] = await db.execute(
      'SELECT * FROM disputes WHERE id = ?', [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Litige introuvable' });
    const dispute = rows[0];

    if (dispute.carrier_id !== req.user.id && dispute.client_id !== req.user.id) {
      return res.status(403).json({ error: 'Non autorisé' });
    }
    if (['resolved', 'closed'].includes(dispute.status)) {
      return res.status(400).json({ error: 'Ce litige est déjà résolu' });
    }

    const isClient = dispute.client_id === req.user.id;
    const role     = isClient ? 'client' : 'carrier';

    if (isClient && dispute.resolved_by_client) {
      return res.status(400).json({ error: 'Vous avez déjà marqué ce litige comme résolu' });
    }
    if (!isClient && dispute.resolved_by_carrier) {
      return res.status(400).json({ error: 'Vous avez déjà marqué ce litige comme résolu' });
    }

    const resolvedByClient  = isClient ? 1 : dispute.resolved_by_client;
    const resolvedByCarrier = !isClient ? 1 : dispute.resolved_by_carrier;
    const bothAgreed = !!(resolvedByClient && resolvedByCarrier);

    // Ajouter un message système au fil de discussion
    let history = [];
    if (dispute.resolution) {
      try {
        const parsed = JSON.parse(dispute.resolution);
        if (Array.isArray(parsed)) history = parsed;
      } catch (e) { history = []; }
    }
    history.push({
      role: 'system',
      text: isClient
        ? '🤝 Le client a marqué ce litige comme résolu.'
        : '🤝 Le transporteur a marqué ce litige comme résolu.',
      ts: new Date().toISOString(),
    });
    if (bothAgreed) {
      history.push({
        role: 'system',
        text: '✅ Litige résolu par accord mutuel.',
        ts: new Date().toISOString(),
      });
    }

    const newStatus = bothAgreed ? 'resolved' : dispute.status;

    await db.execute(
      `UPDATE disputes
       SET resolved_by_client = ?, resolved_by_carrier = ?, status = ?, resolution = ?, updated_at = NOW()
       WHERE id = ?`,
      [resolvedByClient, resolvedByCarrier, newStatus, JSON.stringify(history), dispute.id]
    );

    res.json({
      success: true,
      bothAgreed,
      status: newStatus,
      resolvedByClient: !!resolvedByClient,
      resolvedByCarrier: !!resolvedByCarrier,
      history,
    });
  } catch (err) {
    console.error('Erreur POST /disputes/:id/resolve:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;
