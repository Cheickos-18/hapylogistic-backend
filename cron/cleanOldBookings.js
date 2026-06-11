// cron/cleanOldBookings.js
// Supprime les réservations terminées/annulées/remboursées après 48h
// Appelé tous les jours à 4h dans server.js

const db = require('../config/database');

async function cleanOldBookings() {
  console.log('[Cron] cleanOldBookings — démarrage', new Date().toISOString());

  try {
    // Supprimer les réservations dans ces statuts finaux après 48h
    const [result] = await db.execute(`
      DELETE FROM bookings
      WHERE status IN ('cancelled', 'completed', 'refunded')
        AND updated_at < NOW() - INTERVAL 48 HOUR
    `);

    console.log(`[Cron] cleanOldBookings — ${result.affectedRows} réservation(s) supprimée(s)`);
  } catch (err) {
    console.error('[Cron] cleanOldBookings — erreur:', err.message);
  }
}

module.exports = cleanOldBookings;
