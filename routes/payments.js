// routes/payments.js — Paiements Stripe Connect + Escrow
const express = require('express');
const router  = express.Router();
const db      = require('../config/database');
const auth    = require('../middleware/auth');
const { stripe, calculateFees } = require('../services/stripe');

// ── Générer un code de collecte à 4 chiffres ─────────────────
function generatePickupCode() {
  return String(Math.floor(1000 + Math.random() * 9000));
}

// ── POST /api/payments/intent ────────────────
router.post('/intent', auth, async (req, res) => {
  const { listingId, weightKg, parcelType, recipientName, recipientPhone, notes } = req.body;
  if (!listingId || !weightKg) return res.status(400).json({ error: 'listingId et weightKg requis' });

  try {
    const [listings] = await db.execute(`
      SELECT l.*, u.stripe_account_id
      FROM listings l JOIN users u ON l.carrier_id = u.id
      WHERE l.id = ? AND l.status = 'active'
    `, [listingId]);
    if (!listings.length) return res.status(404).json({ error: 'Annonce introuvable' });

    const listing = listings[0];
    if (parseFloat(weightKg) > parseFloat(listing.available_kg)) {
      return res.status(400).json({ error: `Max ${listing.available_kg} kg disponibles` });
    }

    const [clients] = await db.execute('SELECT * FROM users WHERE id = ?', [req.user.id]);
    const client = clients[0];

    const base    = parseFloat(listing.price_per_kg) * parseFloat(weightKg);
    const amounts = calculateFees(base);

    const piParams = {
      amount:         amounts.clientTotal,
      currency:       'eur',
      capture_method: 'manual',
      description:    `HapyLogistic — ${listing.origin} → ${listing.destination} · ${weightKg}kg`,
      metadata: {
        listingId, clientId: req.user.id, carrierId: listing.carrier_id,
        weightKg: String(weightKg), baseAmount: String(base),
      },
    };

    if (client.stripe_customer_id) piParams.customer = client.stripe_customer_id;
    if (listing.stripe_account_id) {
      piParams.transfer_data        = { destination: listing.stripe_account_id, amount: amounts.carrierNet };
      piParams.application_fee_amount = amounts.platformFee;
    }

    const pi = await stripe.paymentIntents.create(piParams);

    // Générer le code de collecte
    const pickupCode = generatePickupCode();
    const bookingId  = require('crypto').randomUUID();

    await db.execute(`
      INSERT INTO bookings
        (id, listing_id, client_id, carrier_id, weight_kg, parcel_type,
         recipient_name, recipient_phone, special_notes,
         base_amount, client_fee, carrier_fee, client_total, carrier_net, platform_fee,
         payment_intent_id, pickup_code, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'awaiting_payment')
    `, [
      bookingId, listingId, req.user.id, listing.carrier_id,
      parseFloat(weightKg), parcelType || null,
      recipientName || null, recipientPhone || null, notes || null,
      base,
      amounts.clientFee  / 100, amounts.carrierFee / 100,
      amounts.clientTotal/ 100, amounts.carrierNet / 100, amounts.platformFee / 100,
      pi.id, pickupCode,
    ]);

    await db.execute(
      'UPDATE listings SET available_kg = available_kg - ? WHERE id = ?',
      [parseFloat(weightKg), listingId]
    );
    await db.execute(
      "UPDATE listings SET status = 'inactive' WHERE id = ? AND available_kg <= 0",
      [listingId]
    );

    res.json({
      success: true,
      clientSecret: pi.client_secret,
      bookingId,
      amounts: {
        base:        (amounts.base        / 100).toFixed(2),
        clientFee:   (amounts.clientFee   / 100).toFixed(2),
        total:       (amounts.clientTotal / 100).toFixed(2),
        carrierGets: (amounts.carrierNet  / 100).toFixed(2),
      }
    });

  } catch (err) {
    console.error('Erreur payment intent:', err.message);
    res.status(500).json({ error: 'Erreur lors de la création du paiement' });
  }
});

// ── GET /api/payments/bookings/:id/pickup-code ─────────────
// Réservé au CLIENT — affiche le code de collecte
router.get('/bookings/:id/pickup-code', auth, async (req, res) => {
  try {
    const [rows] = await db.execute('SELECT * FROM bookings WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Réservation introuvable' });
    const booking = rows[0];

    if (booking.client_id !== req.user.id) {
      return res.status(403).json({ error: 'Non autorisé' });
    }
    if (!['paid', 'in_transit'].includes(booking.status) && booking.status !== 'awaiting_payment') {
      return res.status(400).json({ error: 'Code non disponible pour ce statut' });
    }

    res.json({ pickupCode: booking.pickup_code });
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── POST /api/payments/confirm-pickup/:id ────────────────────
// Réservé au TRANSPORTEUR — soumet le code de collecte
// Si correct → statut passe à 'in_transit'
router.post('/confirm-pickup/:id', auth, async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'Code requis' });

  try {
    const [rows] = await db.execute('SELECT * FROM bookings WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Réservation introuvable' });
    const booking = rows[0];

    if (booking.carrier_id !== req.user.id) {
      return res.status(403).json({ error: 'Réservé au transporteur' });
    }
    if (booking.status !== 'paid') {
      return res.status(400).json({ error: 'La réservation doit être en statut payé' });
    }
    if (booking.pickup_code !== String(code).trim()) {
      return res.status(400).json({ error: 'Code incorrect — vérifiez avec le client' });
    }

    await db.execute(
      'UPDATE bookings SET status = ?, pickup_confirmed_at = NOW() WHERE id = ?',
      ['in_transit', booking.id]
    );
    res.json({ success: true, message: 'Collecte confirmée — colis en transit ✅' });
  } catch (err) {
    console.error('Erreur confirm-pickup:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── POST /api/payments/confirm-delivery/:id ──────────────────
// Réservé au TRANSPORTEUR — marque le colis comme livré
router.post('/confirm-delivery/:id', auth, async (req, res) => {
  try {
    const [rows] = await db.execute('SELECT * FROM bookings WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Réservation introuvable' });
    const booking = rows[0];

    if (booking.carrier_id !== req.user.id) {
      return res.status(403).json({ error: 'Réservé au transporteur' });
    }
    if (!['paid', 'in_transit'].includes(booking.status)) {
      return res.status(400).json({ error: 'Statut invalide pour confirmer la livraison' });
    }

    await db.execute(
      'UPDATE bookings SET status = ?, delivered_at = NOW(), delivery_confirmed_at = NOW() WHERE id = ?',
      ['delivered', booking.id]
    );
    res.json({ success: true, message: 'Livraison marquée — en attente de confirmation client (48h)' });
  } catch (err) {
    console.error('Erreur confirm-delivery:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── POST /api/payments/confirm-receipt/:id ───────────────────
// Réservé au CLIENT — confirme la réception → capture Stripe
router.post('/confirm-receipt/:id', auth, async (req, res) => {
  try {
    const [rows] = await db.execute('SELECT * FROM bookings WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Réservation introuvable' });
    const booking = rows[0];

    if (booking.client_id !== req.user.id) {
      return res.status(403).json({ error: 'Réservé au client' });
    }
    if (booking.status !== 'delivered') {
      return res.status(400).json({ error: 'Le transporteur n\'a pas encore marqué la livraison' });
    }

    await stripe.paymentIntents.capture(booking.payment_intent_id);
    await db.execute(
      'UPDATE bookings SET status = ?, receipt_confirmed_at = NOW() WHERE id = ?',
      ['completed', booking.id]
    );
    await db.execute(
      'UPDATE users SET total_trips = total_trips + 1 WHERE id = ?',
      [booking.carrier_id]
    );
    res.json({ success: true, message: 'Réception confirmée — transporteur payé immédiatement' });
  } catch (err) {
    console.error('Erreur confirm-receipt:', err.message);
    res.status(500).json({ error: 'Erreur lors de la confirmation: ' + err.message });
  }
});

// ── POST /api/payments/capture/:id ───────────────────────────
// Appelé par le cron job (auto-libération 48h)
router.post('/capture/:id', auth, async (req, res) => {
  try {
    const [rows] = await db.execute('SELECT * FROM bookings WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Réservation introuvable' });
    const booking = rows[0];

    if (booking.status !== 'delivered') {
      return res.status(400).json({ error: 'La livraison doit être confirmée d\'abord' });
    }

    await stripe.paymentIntents.capture(booking.payment_intent_id);
    await db.execute('UPDATE bookings SET status = ? WHERE id = ?', ['completed', booking.id]);
    await db.execute(
      'UPDATE users SET total_trips = total_trips + 1 WHERE id = ?',
      [booking.carrier_id]
    );
    res.json({ success: true, message: 'Paiement capturé — transporteur payé' });
  } catch (err) {
    console.error('Erreur capture:', err.message);
    res.status(500).json({ error: 'Erreur lors de la capture' });
  }
});

// ── POST /api/payments/refund/:id ────────────────────────────
router.post('/refund/:id', auth, async (req, res) => {
  const { reason, amount } = req.body;
  try {
    const [rows] = await db.execute('SELECT * FROM bookings WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Réservation introuvable' });
    const booking = rows[0];

    if (booking.client_id !== req.user.id) {
      return res.status(403).json({ error: 'Non autorisé' });
    }

    const pi = await stripe.paymentIntents.retrieve(booking.payment_intent_id);

    if (pi.status === 'requires_capture') {
      await stripe.paymentIntents.cancel(booking.payment_intent_id);
    } else if (pi.status === 'succeeded') {
      const refundParams = { payment_intent: booking.payment_intent_id, reason: reason || 'requested_by_customer' };
      if (amount) refundParams.amount = Math.round(parseFloat(amount) * 100);
      await stripe.refunds.create(refundParams);
    } else {
      return res.status(400).json({ error: `Impossible d'annuler un paiement en statut: ${pi.status}` });
    }

    await db.execute('UPDATE bookings SET status = ? WHERE id = ?', ['refunded', booking.id]);
    await db.execute(
      'UPDATE listings SET available_kg = available_kg + ?, status = ? WHERE id = ?',
      [parseFloat(booking.weight_kg), 'active', booking.listing_id]
    );
    res.json({ success: true, message: 'Réservation annulée — remboursement en cours' });
  } catch (err) {
    console.error('Erreur refund:', err.message);
    res.status(500).json({ error: 'Erreur lors du remboursement: ' + err.message });
  }
});

// ── POST /api/payments/dispute/:id ───────────────────────────
router.post('/dispute/:id', auth, async (req, res) => {
  const { reason, description } = req.body;
  try {
    const [rows] = await db.execute('SELECT * FROM bookings WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Réservation introuvable' });
    const booking = rows[0];

    await db.execute('UPDATE bookings SET status = ? WHERE id = ?', ['disputed', booking.id]);
    const disputeId = require('crypto').randomUUID();
    await db.execute(`
      INSERT INTO disputes (id, booking_id, client_id, carrier_id, reason, description, payment_intent_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [disputeId, booking.id, booking.client_id, booking.carrier_id, reason || null, description || null, booking.payment_intent_id]);
    res.status(201).json({ success: true, disputeId, message: 'Litige ouvert. Notre équipe vous contactera sous 48h.' });
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── GET /api/payments/bookings/received ──────────────────────
router.get('/bookings/received', auth, async (req, res) => {
  if (req.user.role !== 'carrier') {
    return res.status(403).json({ error: 'Réservé aux transporteurs' });
  }
  try {
    const [rows] = await db.execute(`
      SELECT b.*,
        l.origin, l.destination, l.departure_date,
        u.first_name, u.last_name, u.email AS client_email
      FROM bookings b
      JOIN listings l ON b.listing_id = l.id
      JOIN users u ON u.id = b.client_id
      WHERE b.carrier_id = ?
      ORDER BY b.created_at DESC
    `, [req.user.id]);
    res.json({ bookings: rows });
  } catch (err) {
    console.error('Erreur bookings/received:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── GET /api/payments/bookings/me ────────────────────────────
router.get('/bookings/me', auth, async (req, res) => {
  try {
    const field = req.user.role === 'carrier' ? 'carrier_id' : 'client_id';
    const [rows] = await db.execute(`
      SELECT b.*, l.origin, l.destination, l.departure_date,
        u.first_name, u.last_name
      FROM bookings b
      JOIN listings l ON b.listing_id = l.id
      JOIN users u ON u.id = ${field === 'client_id' ? 'b.carrier_id' : 'b.client_id'}
      WHERE b.${field} = ?
      ORDER BY b.created_at DESC
    `, [req.user.id]);
    res.json({ bookings: rows });
  } catch (err) {
    console.error('Erreur bookings/me:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;
