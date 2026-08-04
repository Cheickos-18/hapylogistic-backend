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
    // CORRECTION : cette formule était différente de celle utilisée dans
    // routes/payments.js (confirm-receipt) — elle ignorait le niveau
    // "platine" et ajoutait une exigence de note minimale absente ailleurs.
    // Résultat : un transporteur passé en "platine" par payments.js pouvait
    // se faire rétrograder en "or" au premier avis suivant, dès que sa note
    // repassait sous 4.6 — les deux formules se contredisaient en
    // permanence. Alignée ici sur l'unique référence (payments.js), basée
    // uniquement sur le nombre de trajets, sans condition de note.
    const [uRows] = await db.execute(
      'SELECT total_trips FROM users WHERE id = ?',
      [booking.carrier_id]
    );
    const totalTrips = uRows[0].total_trips;
    let newLevel = 'bronze';
    if (totalTrips >= 100)     newLevel = 'platine';
    else if (totalTrips >= 30) newLevel = 'or';
    else if (totalTrips >= 10) newLevel = 'argent';
    await db.execute(
      'UPDATE users SET carrier_level = ? WHERE id = ?',
      [newLevel, booking.carrier_id]
    );
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
      SELECT
        r.*,
        u.first_name, u.last_name,
        l.origin, l.destination
      FROM reviews r
      JOIN users u ON r.client_id = u.id
      JOIN bookings b ON r.booking_id = b.id
      JOIN listings l ON b.listing_id = l.id
      WHERE r.carrier_id = ?
      ORDER BY r.created_at DESC
      LIMIT 20
    `, [req.params.carrierId]);
    res.json({ reviews: rows });
  } catch (err) {
    console.error('Erreur reviews/carrier:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});
module.exports = router;
