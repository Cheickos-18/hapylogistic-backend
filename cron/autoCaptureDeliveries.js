// cron/autoCaptureDeliveries.js
// À lancer toutes les heures via node-cron ou pm2-cron
// Capture automatiquement les paiements 48h après delivery_confirmed_at sans confirmation client

const db     = require('../config/database');
const { stripe } = require('../services/stripe');

const DELAY_HOURS = 48;

async function autoCaptureDeliveries() {
  console.log('[AutoCapture] Vérification des livraisons en attente...');
  try {
    const [rows] = await db.execute(`
      SELECT * FROM bookings
      WHERE status = 'delivered'
        AND receipt_confirmed_at IS NULL
        AND delivery_confirmed_at IS NOT NULL
        AND delivery_confirmed_at <= DATE_SUB(NOW(), INTERVAL ? HOUR)
    `, [DELAY_HOURS]);

    console.log(`[AutoCapture] ${rows.length} réservation(s) à capturer automatiquement`);

    for (const booking of rows) {
      try {
        await stripe.paymentIntents.capture(booking.payment_intent_id);
        await db.execute(
          "UPDATE bookings SET status = 'completed', receipt_confirmed_at = NOW() WHERE id = ?",
          [booking.id]
        );
        await db.execute(
          'UPDATE users SET total_trips = total_trips + 1 WHERE id = ?',
          [booking.carrier_id]
        );
        console.log(`[AutoCapture] ✅ Booking ${booking.id} capturé automatiquement (48h écoulées)`);
      } catch (err) {
        console.error(`[AutoCapture] ❌ Erreur booking ${booking.id}:`, err.message);
      }
    }
  } catch (err) {
    console.error('[AutoCapture] Erreur globale:', err.message);
  }
}

module.exports = autoCaptureDeliveries;
