// routes/admin.js — Outils de modération réservés aux administrateurs
const express       = require('express');
const router         = express.Router();
const db             = require('../config/database');
const auth           = require('../middleware/auth');
const requireAdmin   = require('../middleware/requireAdmin');
const email          = require('../services/emailService');

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
        m.created_at, m.reviewed_at, m.reviewed_by, m.action_taken,
        sender.id            AS sender_id,
        sender.first_name    AS sender_first_name,
        sender.last_name     AS sender_last_name,
        sender.role          AS sender_role,
        sender.confirmed_flags_count AS sender_confirmed_flags_count,
        receiver.first_name  AS receiver_first_name,
        receiver.last_name   AS receiver_last_name,
        b.status              AS booking_status
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
// Traite un message signalé. Deux décisions possibles (body.action) :
//
//  - 'confirm' : le message est réellement problématique après revue humaine.
//    → incrémente users.confirmed_flags_count pour l'expéditeur
//    → envoie un email d'avertissement à l'expéditeur (services/emailService.js)
//    Aucune suspension automatique : c'est volontairement laissé à une décision
//    manuelle de l'admin au cas par cas (voir discussion produit).
//
//  - 'dismiss' : faux positif, rien à signaler. Aucune conséquence, juste archivé.
//
// Par rétrocompatibilité, l'absence de body.action équivaut à 'dismiss'
// (comportement de l'ancienne version de cette route).
router.post('/flagged-messages/:id/resolve', auth, requireAdmin, async (req, res) => {
  const action = req.body?.action === 'confirm' ? 'confirm' : 'dismiss';

  try {
    const [rows] = await db.execute('SELECT id, sender_id FROM messages WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Message introuvable' });
    const message = rows[0];

    await db.execute(
      'UPDATE messages SET reviewed_at = NOW(), reviewed_by = ?, action_taken = ? WHERE id = ?',
      [req.user.id, action, req.params.id]
    );

    if (action === 'confirm') {
      await db.execute(
        'UPDATE users SET confirmed_flags_count = confirmed_flags_count + 1 WHERE id = ?',
        [message.sender_id]
      );

      try {
        const [senderRows] = await db.execute(
          'SELECT email, first_name, confirmed_flags_count FROM users WHERE id = ?',
          [message.sender_id]
        );
        if (senderRows.length) {
          await email.sendModerationWarning({
            to: senderRows[0].email,
            firstName: senderRows[0].first_name,
            flagsCount: senderRows[0].confirmed_flags_count,
          });
        }
      } catch (emailErr) {
        // On ne fait jamais échouer la requête à cause d'un email — l'action de
        // modération (compteur + trace) est déjà enregistrée en base à ce stade.
        console.error('[EMAIL] sendModerationWarning failed:', emailErr.message);
      }
    }

    res.json({
      success: true,
      action,
      message: action === 'confirm'
        ? 'Message confirmé — avertissement envoyé, compteur incrémenté'
        : 'Message rejeté (faux positif) — aucune action prise',
    });
  } catch (err) {
    console.error('Erreur POST /admin/flagged-messages/:id/resolve:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;
