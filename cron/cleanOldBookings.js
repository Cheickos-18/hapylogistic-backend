// cron/cleanOldBookings.js
// Supprime les réservations terminées/annulées/remboursées après 48h
// Supprime les annonces avec 0 kg disponible après 24h
// Appelé tous les jours à 4h dans server.js

const db = require('../config/database');

async function cleanOldBookings() {
  console.log('[Cron] cleanOldBookings — démarrage', new Date().toISOString());

  try {
    // 1. Supprimer les réservations dans ces statuts finaux après 48h
    const [result1] = await db.execute(`
      DELETE FROM bookings
      WHERE status IN ('cancelled', 'completed', 'refunded')
        AND updated_at < NOW() - INTERVAL 48 HOUR
    `);
    console.log(`[Cron] cleanOldBookings — ${result1.affectedRows} réservation(s) supprimée(s)`);

    // 2. Supprimer les annonces avec 0 kg disponible depuis plus de 24h
    const [result2] = await db.execute(`
      DELETE FROM listings
      WHERE available_kg <= 0
        AND updated_at < NOW() - INTERVAL 24 HOUR
    `);
    console.log(`[Cron] cleanOldBookings — ${result2.affectedRows} annonce(s) vide(s) supprimée(s)`);

  } catch (err) {
    console.error('[Cron] cleanOldBookings — erreur:', err.message);
  }
}

module.exports = cleanOldBookings;
