// cron/autoResolveStaleReturns.js
// Cas de non-conformité de contenu signalée par le transporteur (voir
// routes/payments.js — POST /verify-content/:id) : si le client n'a
// toujours pas confirmé avoir récupéré son colis (code de retour saisi)
// depuis 48h, on considère que le transporteur ne répond pas / garde le
// colis. On rembourse alors automatiquement le client et on ouvre un
// litige pour examen par l'équipe support — la suspension du compte
// transporteur et toute suite restent une décision humaine.
// À lancer une fois par heure via node-cron.
const db = require('../config/database');
const { stripe } = require('../services/stripe');
const email = require('../services/emailService');

const RETURN_EXPIRY_HOURS = 48; // 48h sans confirmation du client → escalade automatique

async function autoResolveStaleReturns() {
  console.log('[AutoResolveReturns] Vérification des signalements de non-conformité expirés...');
  try {
    const [rows] = await db.execute(`
      SELECT * FROM bookings
      WHERE status = 'paid'
        AND return_code IS NOT NULL
        AND return_confirmed_at IS NULL
        AND return_code_generated_at <= DATE_SUB(NOW(), INTERVAL ? HOUR)
    `, [RETURN_EXPIRY_HOURS]);
    console.log(`[AutoResolveReturns] ${rows.length} réservation(s) en attente de retour expirée(s)`);

    for (const booking of rows) {
      try {
        const pi = await stripe.paymentIntents.retrieve(booking.payment_intent_id);
        if (pi.status === 'requires_capture') {
          await stripe.paymentIntents.cancel(booking.payment_intent_id);
        } else if (pi.status === 'succeeded') {
          await stripe.refunds.create({ payment_intent: booking.payment_intent_id });
        }

        await db.execute("UPDATE bookings SET status = 'disputed' WHERE id = ?", [booking.id]);
        await db.execute(
          'UPDATE listings SET available_kg = available_kg + ?, status = ? WHERE id = ?',
          [parseFloat(booking.weight_kg), 'active', booking.listing_id]
        );

        const disputeId = require('crypto').randomUUID();
        await db.execute(`
          INSERT INTO disputes (id, booking_id, client_id, carrier_id, reason, description, payment_intent_id)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `, [
          disputeId, booking.id, booking.client_id, booking.carrier_id,
          'non_conformite_non_resolue',
          `Non-conformité de contenu signalée par le transporteur, jamais confirmée par le client après ${RETURN_EXPIRY_HOURS}h (code de retour non transmis ou colis non restitué). Remboursement automatique déjà effectué. Dossier à examiner en priorité.`,
          booking.payment_intent_id,
        ]);

        try {
          const [listings]    = await db.execute('SELECT * FROM listings WHERE id = ?', [booking.listing_id]);
          const [clientRows]  = await db.execute('SELECT * FROM users WHERE id = ?', [booking.client_id]);
          const [carrierRows] = await db.execute('SELECT * FROM users WHERE id = ?', [booking.carrier_id]);

          if (listings.length && clientRows.length) {
            await email.sendRefundNotification({
              to:           clientRows[0].email,
              firstName:    clientRows[0].first_name,
              booking,
              listing:      listings[0],
              refundAmount: parseFloat(booking.client_total),
              reason:       `Absence de confirmation du retour de colis par le transporteur sous ${RETURN_EXPIRY_HOURS}h. Remboursement automatique effectué et litige ouvert par notre équipe.`,
            });
          }
          if (listings.length && clientRows.length && carrierRows.length) {
            await email.sendDisputeOpened({
              clientEmail:  clientRows[0].email,
              carrierEmail: carrierRows[0].email,
              client:  { firstName: clientRows[0].first_name,  lastName: clientRows[0].last_name },
              carrier: { firstName: carrierRows[0].first_name, lastName: carrierRows[0].last_name },
              booking,
              listing: listings[0],
              reason:  `Colis non restitué / code de retour non confirmé sous ${RETURN_EXPIRY_HOURS}h — dossier escaladé automatiquement.`,
            });
          }
        } catch (emailErr) {
          console.error(`[AutoResolveReturns] Email ${booking.id}:`, emailErr.message);
        }

        console.log(`[AutoResolveReturns] ✅ ${booking.id} remboursé + litige ${disputeId} ouvert (48h sans confirmation retour)`);
      } catch (err) {
        console.error(`[AutoResolveReturns] ❌ ${booking.id}:`, err.message);
      }
    }
  } catch (err) {
    console.error('[AutoResolveReturns] Erreur globale:', err.message);
  }
}

module.exports = autoResolveStaleReturns;
