// routes/payments.js — Paiements Stripe Connect + Escrow
const express = require('express');
const router  = express.Router();
const db      = require('../config/database');
const auth    = require('../middleware/auth');
const { stripe, calculateFees } = require('../services/stripe');

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

    // Créer PaymentIntent en mode escrow (capture_method: manual)
    const piParams = {
      amount:   amounts.clientTotal,
      currency: 'eur',
      capture_method: 'manual',
      description: `HapyLogistic — ${listing.origin} → ${listing.destination} · ${weightKg}kg`,
      metadata: {
        listingId, clientId: req.user.id, carrierId: listing.carrier_id,
        weightKg: String(weightKg), baseAmount: String(base),
      },
    };

    if (client.stripe_customer_id) piParams.customer = client.stripe_customer_id;
    if (listing.stripe_account_id) {
      piParams.transfer_data = {
        destination: listing.stripe_account_id,
        amount: amounts.carrierNet,
      };
      piParams.application_fee_amount = amounts.platformFee;
    }

    const pi = await stripe.paymentIntents.create(piParams);

    // Créer la réservation en DB
    const bookingId = require('crypto').randomUUID();
    await db.execute(`
      INSERT INTO bookings
        (id, listing_id, client_id, carrier_id, weight_kg, parcel_type,
         recipient_name, recipient_phone, special_notes,
         base_amount, client_fee, carrier_fee, client_total, carrier_net, platform_fee,
         payment_intent_id, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'awaiting_payment')
    `, [
      bookingId, listingId, req.user.id, listing.carrier_id,
      parseFloat(weightKg), parcelType || null,
      recipientName || null, recipientPhone || null, notes || null,
      base,
      amounts.clientFee / 100, amounts.carrierFee / 100,
      amounts.clientTotal / 100, amounts.carrierNet / 100, amounts.platformFee / 100,
      pi.id,
    ]);

    console.log(`✅ Booking créé: ${bookingId} | listing: ${listingId} | client: ${req.user.id} | pi: ${pi.id}`);

    res.json({
      success: true,
      clientSecret: pi.client_secret,
      bookingId,
      amounts: {
        base:        (amounts.base       / 100).toFixed(2),
        clientFee:   (amounts.clientFee  / 100).toFixed(2),
        total:       (amounts.clientTotal/ 100).toFixed(2),
        carrierGets: (amounts.carrierNet / 100).toFixed(2),
      }
    });

  } catch (err) {
    console.error('Erreur payment intent:', err.message);
    res.status(500).json({ error: 'Erreur lors de la création du paiement' });
  }
});

// ── POST /api/payments/confirm-delivery/:id ──
router.post('/confirm-delivery/:id', auth, async (req, res) => {
  try {
    const [rows] = await db.execute('SELECT * FROM bookings WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Réservation introuvable' });
    const booking = rows[0];
    if (booking.client_id !== req.user.id && booking.carrier_id !== req.user.id) {
      return res.status(403).json({ error: 'Non autorisé' });
    }
    await db.execute(
      'UPDATE bookings SET status = ?, delivered_at = NOW(), confirmed_by = ? WHERE id = ?',
      ['delivered', req.user.role, booking.id]
    );
    res.json({ success: true, message: 'Livraison confirmée' });
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── POST /api/payments/capture/:id ───────────
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

// ── POST /api/payments/refund/:id ───────────
router.post('/refund/:id', auth, async (req, res) => {
  const { reason, amount } = req.body;
  try {
    const [rows] = await db.execute('SELECT * FROM bookings WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Réservation introuvable' });
    const booking = rows[0];
    const refundParams = { payment_intent: booking.payment_intent_id, reason: reason || 'requested_by_customer' };
    if (amount) refundParams.amount = Math.round(parseFloat(amount) * 100);
    await stripe.refunds.create(refundParams);
    await db.execute('UPDATE bookings SET status = ? WHERE id = ?', ['refunded', booking.id]);
    res.json({ success: true, message: 'Remboursement effectué' });
  } catch (err) {
    console.error('Erreur refund:', err.message);
    res.status(500).json({ error: 'Erreur lors du remboursement' });
  }
});

// ── POST /api/payments/dispute/:id ──────────
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

// ── GET /api/payments/bookings/me ───────────
router.get('/bookings/me', auth, async (req, res) => {
  try {
    const field = req.user.role === 'carrier' ? 'carrier_id' : 'client_id';

    // 🔍 DEBUG — voir ce qui est réellement en base
    const [debug] = await db.execute(
      `SELECT id, listing_id, client_id, carrier_id, status, payment_intent_id FROM bookings WHERE ${field} = ?`,
      [req.user.id]
    );
    console.log(`🔍 DEBUG bookings (role=${req.user.role}, id=${req.user.id}):`, JSON.stringify(debug));

    const [rows] = await db.execute(`
      SELECT b.*, l.origin, l.destination, l.departure_date,
        u.first_name, u.last_name
      FROM bookings b
      JOIN listings l ON b.listing_id = l.id
      JOIN users u ON u.id = ${field === 'client_id' ? 'b.carrier_id' : 'b.client_id'}
      WHERE b.${field} = ?
      ORDER BY b.created_at DESC
    `, [req.user.id]);

    console.log(`📦 Résultat avec JOIN: ${rows.length} réservations`);

    res.json({ bookings: rows });
  } catch (err) {
    console.error('Erreur bookings/me:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;
