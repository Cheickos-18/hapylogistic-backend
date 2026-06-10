// routes/webhooks.js — Webhooks Stripe
const express = require('express');
const router  = express.Router();
const { stripe } = require('../services/stripe');
const db = require('../config/database');

router.post('/stripe', async (req, res) => {
  const sig    = req.headers['stripe-signature'];
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, secret);
  } catch (err) {
    console.error('Webhook signature invalide:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  console.log(`📨 Webhook: ${event.type}`);

  try {
    switch (event.type) {

      // ── Paiement autorisé (escrow) — client débité, fonds bloqués ──
      // C'est le signal fiable que le paiement est bien passé
      case 'payment_intent.amount_capturable_updated': {
        const pi = event.data.object;
        // Ne mettre à jour que si le statut est encore awaiting_payment
        // pour ne pas écraser un statut plus avancé (paid, in_transit, etc.)
        await db.execute(
          "UPDATE bookings SET status = 'paid' WHERE payment_intent_id = ? AND status = 'awaiting_payment'",
          [pi.id]
        );
        console.log(`✅ Booking passé à 'paid' via webhook: ${pi.id}`);
        break;
      }

      // ── Paiement capturé (transporteur payé) ──
      // Se déclenche après confirm-receipt ou auto-capture 48h
      // Ne pas écraser 'delivered' → 'completed' si le flux normal est déjà passé par là
      case 'payment_intent.succeeded': {
        const pi = event.data.object;
        // Mettre à jour uniquement si le statut est 'delivered'
        // (la capture vient juste d'avoir lieu)
        // Si c'est déjà 'completed', ne rien faire
        await db.execute(
          "UPDATE bookings SET status = 'completed' WHERE payment_intent_id = ? AND status = 'delivered'",
          [pi.id]
        );
        console.log(`✅ Booking passé à 'completed' via webhook: ${pi.id}`);
        break;
      }

      // ── Paiement échoué ──
      case 'payment_intent.payment_failed': {
        const pi = event.data.object;
        await db.execute(
          "UPDATE bookings SET status = 'cancelled' WHERE payment_intent_id = ? AND status = 'awaiting_payment'",
          [pi.id]
        );
        console.log(`❌ Paiement échoué, booking annulé: ${pi.id}`);
        break;
      }

      // ── PaymentIntent annulé (expiration 7 jours ou annulation manuelle) ──
      case 'payment_intent.canceled': {
        const pi = event.data.object;
        // Restituer le stock si annulation Stripe automatique
        const [rows] = await db.execute(
          'SELECT * FROM bookings WHERE payment_intent_id = ?',
          [pi.id]
        );
        if (rows.length && !['completed', 'refunded', 'cancelled'].includes(rows[0].status)) {
          await db.execute(
            "UPDATE bookings SET status = 'cancelled' WHERE payment_intent_id = ?",
            [pi.id]
          );
          // Restituer le stock
          await db.execute(
            'UPDATE listings SET available_kg = available_kg + ?, status = ? WHERE id = ?',
            [parseFloat(rows[0].weight_kg), 'active', rows[0].listing_id]
          );
          console.log(`⏰ Booking annulé par expiration Stripe (7j): ${pi.id}`);
        }
        break;
      }

      // ── KYC transporteur complété ──
      case 'account.updated': {
        const account = event.data.object;
        if (account.details_submitted && account.charges_enabled) {
          await db.execute(
            "UPDATE users SET status = 'active' WHERE stripe_account_id = ?",
            [account.id]
          );
          console.log(`✅ KYC complété pour compte Stripe ${account.id}`);
        }
        break;
      }

      // ── Chargeback détecté ──
      case 'charge.dispute.created': {
        const dispute = event.data.object;
        console.log(`⚠️ Chargeback détecté: ${dispute.id} — montant: ${dispute.amount / 100} €`);
        // Marquer la réservation comme disputée pour investigation manuelle
        await db.execute(
          "UPDATE bookings SET status = 'disputed' WHERE payment_intent_id = ?",
          [dispute.payment_intent]
        );
        break;
      }

      default:
        break;
    }
  } catch (err) {
    // Ne pas retourner d'erreur à Stripe (sinon il re-tentera)
    // Logger seulement pour investigation
    console.error(`Erreur traitement webhook ${event.type}:`, err.message);
  }

  // Toujours répondre 200 à Stripe
  res.json({ received: true });
});

module.exports = router;
