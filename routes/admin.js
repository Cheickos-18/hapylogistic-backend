// routes/admin.js — Outils de modération réservés aux administrateurs
const express       = require('express');
const router         = express.Router();
const db             = require('../config/database');
const auth           = require('../middleware/auth');
const requireAdmin   = require('../middleware/requireAdmin');

// ── GET /api/admin/flagged-messages ───────────────────────────────────────────
// Liste les messages signalés par le filtre de modération (services/contentFilter.js).
// Par défaut : uniquement ceux pas encore traités (reviewed_at IS NULL).
// ?status=all pour voir aussi les messages déjà traités.
router.get('/flagged-messages', auth, requireAdmin, async (req, res) => {
  const showAll = req.query.status === 'all';
  try {
    const [rows] = await db.execute(`
      SELECT
        m.id, m.booking_id, m.content, m.flag_reason,
        m.created_at, m.reviewed_at, m.reviewed_by,
        sender.first_name   AS sender_first_name,
        sender.last_name    AS sender_last_name,
        sender.role         AS sender_role,
        receiver.first_name AS receiver_first_name,
        receiver.last_name  AS receiver_last_name,
        b.status             AS booking_status
      FROM messages m
      JOIN users sender    ON sender.id = m.sender_id
      JOIN users receiver  ON receiver.id = m.receiver_id
      LEFT JOIN bookings b ON b.id = m.booking_id
      WHERE m.is_flagged = 1
      ${showAll ? '' : 'AND m.reviewed_at IS NULL'}
      ORDER BY m.created_at DESC
      LIMIT 200
    `);
    res.json({ count: rows.length, messages: rows });
  } catch (err) {
    console.error('Erreur GET /admin/flagged-messages:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── POST /api/admin/flagged-messages/:id/resolve ──────────────────────────────
// Marque un message signalé comme traité (revu par un admin).
// Ne supprime rien : is_flagged et flag_reason restent en place pour l'historique,
// seul reviewed_at/reviewed_by change — c'est ça qui détermine "traité" ou non.
router.post('/flagged-messages/:id/resolve', auth, requireAdmin, async (req, res) => {
  try {
    const [rows] = await db.execute('SELECT id FROM messages WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Message introuvable' });

    await db.execute(
      'UPDATE messages SET reviewed_at = NOW(), reviewed_by = ? WHERE id = ?',
      [req.user.id, req.params.id]
    );
    res.json({ success: true, message: 'Message marqué comme traité' });
  } catch (err) {
    console.error('Erreur POST /admin/flagged-messages/:id/resolve:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;
