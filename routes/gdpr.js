// routes/gdpr.js — Droits RGPD : effacement, accès, portabilité
// ─────────────────────────────────────────────────────────────────────────────
// Conformité RGPD (Règlement UE 2016/679) :
//
//  POST /api/gdpr/delete-account     — Droit à l'effacement (art. 17)
//  GET  /api/gdpr/export             — Droit d'accès + portabilité (art. 15 & 20)
//
// Principe d'anonymisation (vs suppression) :
//   Les données comptables (montants, IDs Stripe, dates) doivent être conservées
//   7 ans (art. L123-22 Code de commerce). On anonymise les données personnelles
//   identifiantes tout en préservant les données financières obligatoires.
// ─────────────────────────────────────────────────────────────────────────────

const express = require('express');
const router  = express.Router();
const db      = require('../config/database');
const auth    = require('../middleware/auth');
const crypto  = require('crypto');

// ── Helpers ───────────────────────────────────────────────────────────────────

// Génère un identifiant anonyme stable pour traçabilité interne
function anonId(userId) {
  return 'DELETED_' + crypto.createHash('sha256').update(String(userId)).digest('hex').slice(0, 12).toUpperCase();
}

// Vérifie qu'aucun booking actif (non terminé) n'est en cours avant effacement
async function hasActiveBookings(userId) {
  const activeStatuses = ['awaiting_payment', 'paid', 'in_transit', 'delivered', 'disputed'];
  const placeholders = activeStatuses.map(() => '?').join(',');
  const [rows] = await db.execute(
    `SELECT COUNT(*) AS cnt FROM bookings
     WHERE (client_id = ? OR carrier_id = ?) AND status IN (${placeholders})`,
    [userId, userId, ...activeStatuses]
  );
  return rows[0].cnt > 0;
}

// ── POST /api/gdpr/delete-account ─────────────────────────────────────────────
// Droit à l'effacement — art. 17 RGPD
// Anonymise toutes les données personnelles identifiantes de l'utilisateur.
// Conserve les données comptables (montants, IDs Stripe) pendant 7 ans.
// Bloqué si des bookings actifs sont en cours (le paiement escrow doit être
// résolu avant de pouvoir effacer).

router.post('/delete-account', auth, async (req, res) => {
  const userId = req.user.id;

  try {
    // 1. Vérifier l'absence de transactions actives
    if (await hasActiveBookings(userId)) {
      return res.status(400).json({
        error: 'Votre compte ne peut pas être supprimé tant que des réservations sont en cours. Attendez leur résolution ou ouvrez un litige pour chaque réservation active.',
        code: 'ACTIVE_BOOKINGS',
      });
    }

    // 2. Récupérer les infos avant anonymisation (pour log interne)
    const [userRows] = await db.execute('SELECT * FROM users WHERE id = ?', [userId]);
    if (!userRows.length) return res.status(404).json({ error: 'Compte introuvable' });
    const user = userRows[0];
    const anon = anonId(userId);
    const now  = new Date().toISOString().slice(0, 10);

    // 3. Anonymiser la table users
    // Conservé : id, role, created_at, stripe_account_id (obligatoire Stripe Connect),
    //            total_trips (données agrégées non identifiantes)
    // Anonymisé : tout ce qui identifie la personne physique
    await db.execute(`
      UPDATE users SET
        first_name        = 'Utilisateur',
        last_name         = 'Supprimé',
        email             = ?,
        phone             = NULL,
        password_hash     = ?,
        profile_photo     = NULL,
        bio               = NULL,
        stripe_customer_id = NULL,
        deleted_at        = NOW(),
        is_deleted        = 1
      WHERE id = ?
    `, [
      `${anon}@deleted.hapylogistic.com`,
      'GDPR_DELETED_' + crypto.randomBytes(16).toString('hex'),
      userId,
    ]);

    // 4. Anonymiser les messages (contenu supprimé, expéditeur anonymisé)
    await db.execute(`
      UPDATE messages SET
        content    = '[Message supprimé — compte utilisateur effacé]',
        deleted_at = NOW()
      WHERE sender_id = ?
    `, [userId]);

    // 5. Anonymiser les avis laissés par l'utilisateur
    await db.execute(`
      UPDATE reviews SET
        comment    = '[Avis supprimé — compte utilisateur effacé]',
        deleted_at = NOW()
      WHERE client_id = ?
    `, [userId]);

    // 6. Anonymiser les données personnelles dans les bookings
    // Conservé : montants, IDs Stripe, statuts, dates — obligatoires 7 ans
    // Anonymisé : nom/téléphone du destinataire, instructions spéciales
    await db.execute(`
      UPDATE bookings SET
        recipient_name  = 'Destinataire supprimé',
        recipient_phone = NULL,
        special_notes   = NULL
      WHERE client_id = ? OR carrier_id = ?
    `, [userId, userId]);

    // 7. Anonymiser les disputes (description personnelle supprimée)
    await db.execute(`
      UPDATE disputes SET
        description = '[Description supprimée — compte utilisateur effacé]'
      WHERE client_id = ? OR carrier_id = ?
    `, [userId, userId]);

    // 8. Supprimer les notifications (pas de valeur comptable)
    await db.execute('DELETE FROM notifications WHERE user_id = ?', [userId]);

    // 9. Invalider les sessions actives en blacklistant le token
    // (si tu utilises un système de blacklist JWT — sinon le token expire naturellement)
    // await db.execute('INSERT INTO token_blacklist (user_id, blacklisted_at) VALUES (?, NOW())', [userId]);

    // 10. Log interne de la demande d'effacement (traçabilité RGPD obligatoire)
    // Tu peux aussi logger dans un fichier ou un service dédié
    console.log(`[GDPR] DELETE_ACCOUNT — userId: ${userId}, anon: ${anon}, date: ${now}, role: ${user.role}`);

    res.json({
      success: true,
      message: 'Votre compte a été supprimé conformément au RGPD. Vos données personnelles ont été effacées. Les données comptables obligatoires (transactions, montants) sont conservées 7 ans conformément à la loi.',
    });

  } catch (err) {
    console.error('[GDPR] delete-account error:', err.message);
    res.status(500).json({ error: 'Erreur lors de la suppression du compte' });
  }
});

// ── GET /api/gdpr/export ──────────────────────────────────────────────────────
// Droit d'accès + portabilité — art. 15 & 20 RGPD
// Retourne toutes les données personnelles de l'utilisateur en JSON.
// Le frontend peut proposer un téléchargement du fichier.

router.get('/export', auth, async (req, res) => {
  const userId = req.user.id;

  try {
    // Données personnelles du compte
    const [userRows] = await db.execute(
      'SELECT id, first_name, last_name, email, phone, role, created_at, total_trips FROM users WHERE id = ?',
      [userId]
    );
    if (!userRows.length) return res.status(404).json({ error: 'Compte introuvable' });

    // Réservations (sans données bancaires sensibles)
    const [bookings] = await db.execute(`
      SELECT id, listing_id, weight_kg, parcel_type, recipient_name, recipient_phone,
             base_amount, client_fee, client_total, carrier_net, status,
             pickup_code, declared_value, created_at, pickup_confirmed_at,
             delivered_at, receipt_confirmed_at
      FROM bookings
      WHERE client_id = ? OR carrier_id = ?
      ORDER BY created_at DESC
    `, [userId, userId]);

    // Messages
    const [messages] = await db.execute(
      'SELECT id, booking_id, content, created_at FROM messages WHERE sender_id = ? ORDER BY created_at DESC',
      [userId]
    );

    // Avis laissés
    const [reviews] = await db.execute(
      'SELECT id, booking_id, rating, comment, created_at FROM reviews WHERE client_id = ? ORDER BY created_at DESC',
      [userId]
    );

    // Litiges impliquant l'utilisateur
    const [disputes] = await db.execute(
      'SELECT id, booking_id, reason, description, status, created_at FROM disputes WHERE client_id = ? OR carrier_id = ? ORDER BY created_at DESC',
      [userId, userId]
    );

    const exportData = {
      export_date:    new Date().toISOString(),
      export_version: '1.0',
      gdpr_basis:     'Article 15 & 20 RGPD (UE 2016/679)',
      account:        userRows[0],
      bookings,
      messages,
      reviews,
      disputes,
    };

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="hapylogistic-data-${userId}-${new Date().toISOString().slice(0,10)}.json"`);
    res.json(exportData);

  } catch (err) {
    console.error('[GDPR] export error:', err.message);
    res.status(500).json({ error: "Erreur lors de l'export des données" });
  }
});

module.exports = router;
