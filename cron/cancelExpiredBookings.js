// cron/cancelExpiredBookings.js
// Annule les réservations 'paid' sans activité depuis 6 jours (avant expiration Stripe à 7j)
// À lancer une fois par jour via node-cron

const db = require('../config/database');
const { stripe } = require('../services/stripe');

const EXPIRY_HOURS = 144; // 6 jours — 1 jour avant l'expiration Stripe (7j)

async function cancelExpiredBookings() {
  console.log('[CancelExpired] Vérification des réservations expirées...');
  try {
    const [rows] = await db.execute(`
      SELECT * FROM bookings
      WHERE status IN ('paid', 'in_transit')
        AND created_at <= DATE_SUB(NOW(), INTERVAL ? HOUR)
    `, [EXPIRY_HOURS]);

    console.log(`[CancelExpired] ${rows.length} réservation(s) expirée(s) à annuler`);

    for (const booking of rows) {
      try {
        // Récupérer le statut Stripe actuel
        const pi = await stripe.paymentIntents.retrieve(booking.payment_intent_id);

        if (pi.status === 'requires_capture') {
          // Annuler le PaymentIntent → remboursement automatique client
          await stripe.paymentIntents.cancel(booking.payment_intent_id);
        }
        // Si déjà annulé ou autre statut, juste mettre à jour la DB

        await db.execute(
          "UPDATE bookings SET status = 'cancelled' WHERE id = ?",
          [booking.id]
        );
        // Restituer le stock
        await db.execute(
          'UPDATE listings SET available_kg = available_kg + ?, status = ? WHERE id = ?',
          [parseFloat(booking.weight_kg), 'active', booking.listing_id]
        );
        console.log(`[CancelExpired] ✅ Booking ${booking.id} annulé (6j sans livraison)`);
      } catch (err) {
        console.error(`[CancelExpired] ❌ Erreur booking ${booking.id}:`, err.message);
      }
    }
  } catch (err) {
    console.error('[CancelExpired] Erreur globale:', err.message);
  }
}

module.exports = cancelExpiredBookings;
