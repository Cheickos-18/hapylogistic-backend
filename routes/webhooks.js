// routes/webhooks.js — Webhooks Stripe
const express = require('express');
const router  = express.Router();
const { stripe } = require('../services/stripe');
const db = require('../config/database');
const email = require('../services/emailService');

// ── Calcule et stocke le net réel HapyLogistic après frais Stripe ──
// (commission visée − frais de traitement Stripe réels)
// Ne peut être calculé qu'au moment de la capture, car c'est seulement
// à cet instant que Stripe génère le balance_transaction avec les frais réels.
async function recordStripeFeesForBooking(paymentIntentId) {
  try {
    const pi = await stripe.paymentIntents.retrieve(paymentIntentId, {
      expand: ['latest_charge.balance_transaction'],
    });

    const charge = pi.latest_charge;
    if (!charge || !charge.balance_transaction) {
      console.warn(`[Fees] Pas de balance_transaction disponible pour ${paymentIntentId}`);
      return;
    }

    // balance_transaction.fee = frais Stripe réels en centimes
    const stripeFee = charge.balance_transaction.fee / 100;

    const [rows] = await db.execute(
      'SELECT platform_fee FROM bookings WHERE payment_intent_id = ?',
      [paymentIntentId]
    );
    if (!rows.length) {
      console.warn(`[Fees] Aucune réservation trouvée pour ${paymentIntentId}`);
      return;
    }

    const platformFee        = parseFloat(rows[0].platform_fee);
    const netAfterStripeFees = Math.round((platformFee - stripeFee) * 100) / 100;

    await db.execute(
      `UPDATE bookings
       SET stripe_processing_fee = ?, net_after_stripe_fees = ?
       WHERE payment_intent_id = ?`,
      [stripeFee, netAfterStripeFees, paymentIntentId]
    );

    console.log(`💶 [Fees] ${paymentIntentId} — commission visée: ${platformFee}€, frais Stripe: ${stripeFee}€, net réel: ${netAfterStripeFees}€`);
  } catch (err) {
    console.error('[Fees] Erreur calcul frais Stripe:', err.message);
  }
}

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
        await db.execute(
          "UPDATE bookings SET status = 'paid' WHERE payment_intent_id = ? AND status = 'awaiting_payment'",
          [pi.id]
        );
        console.log(`✅ Booking passé à 'paid' via webhook: ${pi.id}`);

        // ── Emails de confirmation réservation ──
        // Envoyés ici car c'est le seul moment où le paiement est GARANTI
        try {
          const [bookings] = await db.execute(
            'SELECT * FROM bookings WHERE payment_intent_id = ?',
            [pi.id]
          );
          if (bookings.length) {
            const booking = bookings[0];
            const [listings]    = await db.execute('SELECT * FROM listings WHERE id = ?', [booking.listing_id]);
            const [clientRows]  = await db.execute('SELECT * FROM users WHERE id = ?', [booking.client_id]);
            const [carrierRows] = await db.execute('SELECT * FROM users WHERE id = ?', [booking.carrier_id]);

            if (listings.length && clientRows.length && carrierRows.length) {
              const listing = listings[0];
              const client  = clientRows[0];
              const carrier = carrierRows[0];

              // Email 1 — Confirmation au client avec code de collecte
              await email.sendBookingConfirmation({
                to:         client.email,
                firstName:  client.first_name,
                booking,
                listing,
                pickupCode: booking.pickup_code,
              });

              // Email 2 — Nouvelle réservation au transporteur
              await email.sendNewBookingToCarrier({
                to:               carrier.email,
                carrierFirstName: carrier.first_name,
                booking,
                listing,
                client: {
                  firstName: client.first_name,
                  lastName:  client.last_name,
                  email:     client.email,
                },
              });

              console.log(`📧 Emails de confirmation envoyés pour booking ${booking.id}`);
            }
          }
        } catch (emailErr) {
          console.error('[EMAIL] sendBookingConfirmation failed:', emailErr.message);
        }

        break;
      }

      // ── Paiement capturé (transporteur payé) ──
      case 'payment_intent.succeeded': {
        const pi = event.data.object;
        await db.execute(
          "UPDATE bookings SET status = 'completed' WHERE payment_intent_id = ? AND status = 'delivered'",
          [pi.id]
        );
        console.log(`✅ Booking passé à 'completed' via webhook: ${pi.id}`);

        // ── Calcul du net réel HapyLogistic après frais Stripe ──
        // (commission visée − frais de traitement Stripe), stocké en BDD
        await recordStripeFeesForBooking(pi.id);

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
        const [rows] = await db.execute(
          'SELECT * FROM bookings WHERE payment_intent_id = ?',
          [pi.id]
        );
        if (rows.length && !['completed', 'refunded', 'cancelled'].includes(rows[0].status)) {
          await db.execute(
            "UPDATE bookings SET status = 'cancelled' WHERE payment_intent_id = ?",
            [pi.id]
          );
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
    console.error(`Erreur traitement webhook ${event.type}:`, err.message);
  }

  // Toujours répondre 200 à Stripe
  res.json({ received: true });
});

module.exports = router;
