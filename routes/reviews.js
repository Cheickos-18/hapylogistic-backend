// routes/reviews.js — Avis clients
const express = require('express');
const router  = express.Router();
const db      = require('../config/database');
const auth    = require('../middleware/auth');

// ── POST /api/reviews ────────────────────────
router.post('/', auth, async (req, res) => {
  const { bookingId, rating, comment } = req.body;
  if (!bookingId || !rating) return res.status(400).json({ error: 'bookingId et rating requis' });
  if (rating < 1 || rating > 5) return res.status(400).json({ error: 'Note entre 1 et 5' });

  try {
    const [bookings] = await db.execute(
      'SELECT * FROM bookings WHERE id = ? AND client_id = ? AND status = ?',
      [bookingId, req.user.id, 'completed']
    );
    if (!bookings.length) return res.status(403).json({ error: 'Réservation introuvable ou non terminée' });
    const booking = bookings[0];

    const id = require('crypto').randomUUID();
    await db.execute(`
      INSERT INTO reviews (id, booking_id, client_id, carrier_id, rating, comment)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [id, bookingId, req.user.id, booking.carrier_id, rating, comment || null]);

    // Recalculer la note moyenne du transporteur
    const [avg] = await db.execute(
      'SELECT AVG(rating) AS avg_rating, COUNT(*) AS total FROM reviews WHERE carrier_id = ?',
      [booking.carrier_id]
    );
    await db.execute(
      'UPDATE users SET average_rating = ? WHERE id = ?',
      [parseFloat(avg[0].avg_rating).toFixed(2), booking.carrier_id]
    );

    // Mise à jour du niveau automatique
    const trips  = bookings[0].carrier_id;
    const [uRows] = await db.execute('SELECT total_trips, average_rating FROM users WHERE id = ?', [booking.carrier_id]);
    const u = uRows[0];
    let newLevel = 'bronze';
    if (u.total_trips >= 20 && parseFloat(u.average_rating) >= 4.6) newLevel = 'or';
    else if (u.total_trips >= 5  && parseFloat(u.average_rating) >= 4.2) newLevel = 'argent';
    await db.execute('UPDATE users SET carrier_level = ? WHERE id = ?', [newLevel, booking.carrier_id]);

    res.status(201).json({ success: true, reviewId: id, message: 'Avis publié' });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Vous avez déjà laissé un avis pour cette réservation' });
    console.error('Erreur review:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── GET /api/reviews/carrier/:carrierId ──────
router.get('/carrier/:carrierId', async (req, res) => {
  try {
    const [rows] = await db.execute(`
      SELECT r.*, u.first_name, u.last_name
      FROM reviews r JOIN users u ON r.client_id = u.id
      WHERE r.carrier_id = ?
      ORDER BY r.created_at DESC
      LIMIT 20
    `, [req.params.carrierId]);
    res.json({ reviews: rows });
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;
