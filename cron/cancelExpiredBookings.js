// cron/cancelExpiredBookings.js
// Deux règles :
// 1. Réservations 'paid' sans collecte depuis 6 jours → remboursement (avant expiration Stripe 7j)
// 2. Réservations 'in_transit' sans livraison depuis 21 jours → remboursement automatique
// À lancer une fois par jour via node-cron

const db = require('../config/database');
const { stripe } = require('../services/stripe');

const PAID_EXPIRY_HOURS    = 144; // 6 jours — avant expiration Stripe (7j)
const TRANSIT_EXPIRY_HOURS = 504; // 21 jours — délai max de livraison

async function cancelExpiredBookings() {
  console.log('[CancelExpired] Vérification des réservations expirées...');
  try {

    // ── Cas 1 : réservations 'paid' sans collecte depuis 6 jours ──
    const [paidRows] = await db.execute(`
      SELECT * FROM bookings
      WHERE status = 'paid'
        AND created_at <= DATE_SUB(NOW(), INTERVAL ? HOUR)
    `, [PAID_EXPIRY_HOURS]);

    console.log(`[CancelExpired] ${paidRows.length} réservation(s) 'paid' expirée(s)`);

    for (const booking of paidRows) {
      try {
        const pi = await stripe.paymentIntents.retrieve(booking.payment_intent_id);
        if (pi.status === 'requires_capture') {
          await stripe.paymentIntents.cancel(booking.payment_intent_id);
        }
        await db.execute("UPDATE bookings SET status = 'cancelled' WHERE id = ?", [booking.id]);
        await db.execute(
          'UPDATE listings SET available_kg = available_kg + ?, status = ? WHERE id = ?',
          [parseFloat(booking.weight_kg), 'active', booking.listing_id]
        );
        console.log(`[CancelExpired] ✅ ${booking.id} annulé (6j sans collecte)`);
      } catch (err) {
        console.error(`[CancelExpired] ❌ ${booking.id}:`, err.message);
      }
    }

    // ── Cas 2 : réservations 'in_transit' sans livraison depuis 21 jours ──
    const [transitRows] = await db.execute(`
      SELECT * FROM bookings
      WHERE status = 'in_transit'
        AND pickup_confirmed_at <= DATE_SUB(NOW(), INTERVAL ? HOUR)
    `, [TRANSIT_EXPIRY_HOURS]);

    console.log(`[CancelExpired] ${transitRows.length} réservation(s) 'in_transit' expirée(s)`);

    for (const booking of transitRows) {
      try {
        const pi = await stripe.paymentIntents.retrieve(booking.payment_intent_id);
        if (pi.status === 'requires_capture') {
          await stripe.paymentIntents.cancel(booking.payment_intent_id);
        } else if (pi.status === 'succeeded') {
          await stripe.refunds.create({ payment_intent: booking.payment_intent_id });
        }
        await db.execute("UPDATE bookings SET status = 'refunded' WHERE id = ?", [booking.id]);
        await db.execute(
          'UPDATE listings SET available_kg = available_kg + ?, status = ? WHERE id = ?',
          [parseFloat(booking.weight_kg), 'active', booking.listing_id]
        );
        console.log(`[CancelExpired] ✅ ${booking.id} remboursé (21j sans livraison)`);
      } catch (err) {
        console.error(`[CancelExpired] ❌ ${booking.id}:`, err.message);
      }
    }

  } catch (err) {
    console.error('[CancelExpired] Erreur globale:', err.message);
  }
}

module.exports = cancelExpiredBookings;
