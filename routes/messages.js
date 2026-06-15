// routes/messages.js — Messagerie HapyLogistic
const express = require('express');
const router  = express.Router();
const db      = require('../config/database');
const auth    = require('../middleware/auth');

// ── GET /api/messages/:bookingId ─────────────────────────────
// Récupère tous les messages d'une réservation (polling)
router.get('/:bookingId', auth, async (req, res) => {
  try {
    // Vérifier que l'utilisateur est bien client ou transporteur de cette réservation
    const [bookings] = await db.execute(
      'SELECT client_id, carrier_id FROM bookings WHERE id = ?',
      [req.params.bookingId]
    );
    if (!bookings.length) return res.status(404).json({ error: 'Réservation introuvable' });
    const b = bookings[0];
    if (b.client_id !== req.user.id && b.carrier_id !== req.user.id) {
      return res.status(403).json({ error: 'Non autorisé' });
    }

    // Récupérer les messages avec le prénom de l'expéditeur
    const [messages] = await db.execute(`
      SELECT m.id, m.booking_id, m.sender_id, m.receiver_id,
             m.content, m.is_read, m.created_at,
             u.first_name AS sender_name
      FROM messages m
      JOIN users u ON m.sender_id = u.id
      WHERE m.booking_id = ?
      ORDER BY m.created_at ASC
    `, [req.params.bookingId]);

    // Marquer les messages reçus comme lus
    await db.execute(
      'UPDATE messages SET is_read = 1 WHERE booking_id = ? AND receiver_id = ? AND is_read = 0',
      [req.params.bookingId, req.user.id]
    );

    res.json({ messages });
  } catch (err) {
    console.error('Erreur GET /messages:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── POST /api/messages/:bookingId ────────────────────────────
// Envoyer un message
router.post('/:bookingId', auth, async (req, res) => {
  const { content } = req.body;
  if (!content || !content.trim()) {
    return res.status(400).json({ error: 'Message vide' });
  }
  try {
    const [bookings] = await db.execute(
      'SELECT client_id, carrier_id FROM bookings WHERE id = ?',
      [req.params.bookingId]
    );
    if (!bookings.length) return res.status(404).json({ error: 'Réservation introuvable' });
    const b = bookings[0];

    if (b.client_id !== req.user.id && b.carrier_id !== req.user.id) {
      return res.status(403).json({ error: 'Non autorisé' });
    }

    // Le destinataire est l'autre partie
    const receiverId = req.user.id === b.client_id ? b.carrier_id : b.client_id;

    const msgId = require('crypto').randomUUID();
    await db.execute(
      'INSERT INTO messages (id, booking_id, sender_id, receiver_id, content) VALUES (?, ?, ?, ?, ?)',
      [msgId, req.params.bookingId, req.user.id, receiverId, content.trim()]
    );

    // Créer une notification pour le destinataire
    const [senders] = await db.execute(
      'SELECT first_name FROM users WHERE id = ?', [req.user.id]
    );
    const senderName = senders[0]?.first_name || 'Quelqu\'un';
    const notifId = require('crypto').randomUUID();
    await db.execute(
      `INSERT INTO notifications (id, user_id, type, title, message)
       VALUES (?, ?, 'message', ?, ?)`,
      [notifId, receiverId, `Nouveau message de ${senderName}`, content.trim().slice(0, 100)]
    );

    res.status(201).json({
      success: true,
      message: {
        id: msgId,
        booking_id: req.params.bookingId,
        sender_id: req.user.id,
        receiver_id: receiverId,
        content: content.trim(),
        is_read: 0,
        created_at: new Date().toISOString(),
        sender_name: senderName,
      }
    });
  } catch (err) {
    console.error('Erreur POST /messages:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── GET /api/messages/unread/counts ──────────────────────────
// Nombre de messages non lus, regroupés par réservation, pour
// l'utilisateur connecté (badge 💬 sur les listes de réservations
// du dashboard — évite un appel par réservation).
router.get('/unread/counts', auth, async (req, res) => {
  try {
    const [rows] = await db.execute(
      `SELECT booking_id, COUNT(*) AS count
       FROM messages
       WHERE receiver_id = ? AND is_read = 0
       GROUP BY booking_id`,
      [req.user.id]
    );
    const counts = {};
    rows.forEach(r => { counts[r.booking_id] = Number(r.count); });
    res.json({ counts });
  } catch (err) {
    console.error('Erreur GET /messages/unread/counts:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── GET /api/messages/:bookingId/unread ──────────────────────
// Nombre de messages non lus (pour le badge)
router.get('/:bookingId/unread', auth, async (req, res) => {
  try {
    const [rows] = await db.execute(
      'SELECT COUNT(*) AS count FROM messages WHERE booking_id = ? AND receiver_id = ? AND is_read = 0',
      [req.params.bookingId, req.user.id]
    );
    res.json({ count: rows[0].count });
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;
