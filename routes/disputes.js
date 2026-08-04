// routes/disputes.js — Litiges HapyLogistic
const express = require('express');
const router  = express.Router();
const db      = require('../config/database');
const auth    = require('../middleware/auth');
const { stripe } = require('../services/stripe');

// ── Helper : appliquer l'issue convenue d'un litige à la réservation ──
// CORRECTION : cette fonction ne validait pas que pi.status était bien dans
// l'un des deux états attendus avant de continuer — si Stripe renvoyait un
// statut imprévu, aucune opération de paiement n'était effectuée, mais la
// réservation était quand même marquée "refunded"/"completed" en base,
// comme si tout s'était bien passé. On lève désormais une erreur explicite
// dans ce cas, pour que l'appelant sache que l'opération n'a PAS réellement
// abouti et n'inscrive rien de trompeur.
async function applyDisputeOutcome(booking, outcome) {
  const pi = await stripe.paymentIntents.retrieve(booking.payment_intent_id);
  if (outcome === 'refunded') {
    if (pi.status === 'requires_capture') {
      await stripe.paymentIntents.cancel(booking.payment_intent_id);
    } else if (pi.status === 'succeeded') {
      await stripe.refunds.create({ payment_intent: booking.payment_intent_id, reason: 'requested_by_customer' });
    } else {
      throw new Error(`Statut de paiement Stripe inattendu pour un remboursement : ${pi.status}`);
    }
    await db.execute('UPDATE bookings SET status = ? WHERE id = ?', ['refunded', booking.id]);
    await db.execute(
      "UPDATE listings SET available_kg = available_kg + ?, status = IF(status = 'inactive', 'active', status) WHERE id = ?",
      [parseFloat(booking.weight_kg), booking.listing_id]
    );
  } else {
    // 'completed' — livraison confirmée, le transporteur est payé
    if (pi.status === 'requires_capture') {
      await stripe.paymentIntents.capture(booking.payment_intent_id);
    } else if (pi.status !== 'succeeded') {
      // 'succeeded' est acceptable tel quel (déjà capturé via un autre
      // chemin) ; tout autre statut (canceled, etc.) est anormal ici.
      throw new Error(`Statut de paiement Stripe inattendu pour une confirmation de livraison : ${pi.status}`);
    }
    await db.execute(
      'UPDATE bookings SET status = ?, receipt_confirmed_at = NOW() WHERE id = ?',
      ['completed', booking.id]
    );
  }
}

// ── GET /api/disputes/me ─────────────────────────────────────
// Client : ses propres litiges
router.get('/me', auth, async (req, res) => {
  try {
    const [rows] = await db.execute(`
      SELECT
        d.id, d.booking_id, d.reason, d.description,
        d.status, d.resolution, d.created_at, d.updated_at,
        d.resolved_by_client, d.resolved_by_carrier,
        d.resolution_outcome_client, d.resolution_outcome_carrier,
        b.client_total AS amount,
        l.origin, l.destination, l.departure_date,
        u.first_name AS carrier_first_name,
        u.last_name  AS carrier_last_name
      FROM disputes d
      JOIN bookings b ON d.booking_id = b.id
      JOIN listings l ON b.listing_id = l.id
      JOIN users    u ON d.carrier_id = u.id
      WHERE d.client_id = ?
      ORDER BY d.created_at DESC
    `, [req.user.id]);
    res.json({ disputes: rows });
  } catch (err) {
    console.error('Erreur GET /disputes/me:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── GET /api/disputes/carrier ────────────────────────────────
// Transporteur : litiges sur ses trajets
router.get('/carrier', auth, async (req, res) => {
  try {
    const [rows] = await db.execute(`
      SELECT
        d.id, d.booking_id, d.reason, d.description,
        d.status, d.resolution, d.created_at, d.updated_at,
        d.resolved_by_client, d.resolved_by_carrier,
        d.resolution_outcome_client, d.resolution_outcome_carrier,
        b.client_total AS amount,
        l.origin, l.destination, l.departure_date,
        u.first_name AS client_first_name,
        u.last_name  AS client_last_name
      FROM disputes d
      JOIN bookings b ON d.booking_id = b.id
      JOIN listings l ON b.listing_id = l.id
      JOIN users    u ON d.client_id  = u.id
      WHERE d.carrier_id = ?
      ORDER BY d.created_at DESC
    `, [req.user.id]);
    res.json({ disputes: rows });
  } catch (err) {
    console.error('Erreur GET /disputes/carrier:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── GET /api/disputes/:id ────────────────────────────────────
// Détail d'un litige (client ou transporteur concerné)
router.get('/:id', auth, async (req, res) => {
  try {
    const [rows] = await db.execute(`
      SELECT d.*, l.origin, l.destination
      FROM disputes d
      JOIN bookings b ON d.booking_id = b.id
      JOIN listings l ON b.listing_id = l.id
      WHERE d.id = ?
    `, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Litige introuvable' });
    const dispute = rows[0];
    if (dispute.client_id !== req.user.id && dispute.carrier_id !== req.user.id) {
      return res.status(403).json({ error: 'Non autorisé' });
    }
    res.json({ dispute });
  } catch (err) {
    console.error('Erreur GET /disputes/:id:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── POST /api/disputes/:id/respond ───────────────────────────
// Transporteur ou client : ajouter un message au fil du litige
//
// SÉCURITÉ : le rôle affiché (client/transporteur) dans le fil de discussion
// est TOUJOURS déduit de l'identité authentifiée (req.user.id comparé à
// dispute.client_id / dispute.carrier_id) — jamais du corps de la requête.
// Un ancien code acceptait un champ `role` envoyé par l'appelant, ce qui
// permettait à un utilisateur de faire passer ses propres messages pour
// ceux de l'autre partie (usurpation) dans un litige portant sur un
// remboursement réel. Ce champ est désormais entièrement ignoré.
router.post('/:id/respond', auth, async (req, res) => {
  const { message } = req.body;
  if (!message || !message.trim()) {
    return res.status(400).json({ error: 'Message requis' });
  }
  try {
    const [rows] = await db.execute(
      'SELECT * FROM disputes WHERE id = ?', [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Litige introuvable' });
    const dispute = rows[0];

    if (dispute.carrier_id !== req.user.id && dispute.client_id !== req.user.id) {
      return res.status(403).json({ error: 'Non autorisé' });
    }

    // Rôle déduit UNIQUEMENT de l'identité authentifiée — non falsifiable.
    const senderRole = dispute.carrier_id === req.user.id ? 'carrier' : 'client';

    // Parser l'historique existant (rétrocompatible avec l'ancien format texte)
    let history = [];
    if (dispute.resolution) {
      try {
        const parsed = JSON.parse(dispute.resolution);
        if (Array.isArray(parsed)) {
          history = parsed;
        } else {
          // Ancien format JSON non-array : on l'ignore et repart de zéro
          history = [];
        }
      } catch (e) {
        // Ancien format texte brut "[Transporteur] message" → convertir en JSON
        const clean = dispute.resolution
          .replace(/^\[Transporteur\]\s*|\[Carrier\]\s*/i, '').trim();
        if (clean) {
          history = [{
            role: 'carrier',
            text: clean,
            ts: dispute.updated_at
              ? new Date(dispute.updated_at).toISOString()
              : new Date().toISOString()
          }];
        }
      }
    }

    // Ajouter le nouveau message
    history.push({
      role: senderRole,
      text: message.trim(),
      ts: new Date().toISOString()
    });

    await db.execute(
      'UPDATE disputes SET resolution = ?, updated_at = NOW() WHERE id = ?',
      [JSON.stringify(history), dispute.id]
    );

    res.json({ success: true, message: 'Réponse enregistrée', history });
  } catch (err) {
    console.error('Erreur POST /disputes/:id/respond:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── POST /api/disputes/:id/resolve ───────────────────────────
// Le client OU le transporteur propose une issue ('completed' = sans
// remboursement / livraison confirmée, 'refunded' = avec remboursement).
// Quand les DEUX parties proposent la MÊME issue, le litige passe en
// status='resolved' et la réservation est mise à jour en conséquence
// (capture du paiement ou remboursement Stripe).
// Si les deux issues diffèrent, les propositions sont réinitialisées
// pour permettre une nouvelle tentative après discussion.
router.post('/:id/resolve', auth, async (req, res) => {
  const { outcome } = req.body;
  if (!['completed', 'refunded'].includes(outcome)) {
    return res.status(400).json({ error: "Issue invalide (attendu : 'completed' ou 'refunded')" });
  }
  try {
    const [rows] = await db.execute(
      'SELECT * FROM disputes WHERE id = ?', [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Litige introuvable' });
    const dispute = rows[0];

    if (dispute.carrier_id !== req.user.id && dispute.client_id !== req.user.id) {
      return res.status(403).json({ error: 'Non autorisé' });
    }
    if (['resolved', 'closed'].includes(dispute.status)) {
      return res.status(400).json({ error: 'Ce litige est déjà résolu' });
    }

    const isClient = dispute.client_id === req.user.id;

    if (isClient && dispute.resolution_outcome_client) {
      return res.status(400).json({ error: 'Vous avez déjà proposé une issue pour ce litige' });
    }
    if (!isClient && dispute.resolution_outcome_carrier) {
      return res.status(400).json({ error: 'Vous avez déjà proposé une issue pour ce litige' });
    }

    let outcomeClient  = isClient ? outcome : dispute.resolution_outcome_client;
    let outcomeCarrier = !isClient ? outcome : dispute.resolution_outcome_carrier;
    let resolvedByClient  = isClient ? 1 : dispute.resolved_by_client;
    let resolvedByCarrier = !isClient ? 1 : dispute.resolved_by_carrier;
    const bothProposed = !!(outcomeClient && outcomeCarrier);

    const outcomeLabel = o => o === 'refunded'
      ? 'avec remboursement du client'
      : 'sans remboursement (livraison confirmée)';

    // Fil de discussion
    let history = [];
    if (dispute.resolution) {
      try {
        const parsed = JSON.parse(dispute.resolution);
        if (Array.isArray(parsed)) history = parsed;
      } catch (e) { history = []; }
    }
    history.push({
      role: 'system',
      text: (isClient ? 'Le client' : 'Le transporteur') + ' propose une résolution ' + outcomeLabel(outcome) + '.',
      ts: new Date().toISOString(),
    });

    let newStatus  = dispute.status;
    let conflict   = false;
    let bothAgreed = false;

    if (bothProposed) {
      if (outcomeClient === outcomeCarrier) {
        // ── CORRECTION : ne plus déclarer le litige résolu par avance ──
        // Avant, `newStatus` passait à 'resolved' et le message "✅ Litige
        // résolu" était ajouté à l'historique AVANT même de savoir si
        // l'opération Stripe avait réussi. Si applyDisputeOutcome échouait
        // (panne réseau, statut de paiement imprévu...), l'erreur était
        // seulement journalisée côté serveur — le litige apparaissait
        // quand même "résolu" aux deux parties, avec un message de succès
        // trompeur, alors qu'aucun remboursement ni paiement n'avait
        // réellement eu lieu. Le statut et le message ne sont désormais
        // écrits qu'après confirmation que l'opération a bien abouti.
        const [bRows] = await db.execute('SELECT * FROM bookings WHERE id = ?', [dispute.booking_id]);
        let outcomeApplied = false;
        if (bRows.length) {
          try {
            await applyDisputeOutcome(bRows[0], outcomeClient);
            outcomeApplied = true;
          } catch (e) {
            console.error('Erreur applyDisputeOutcome:', e.message);
          }
        }

        if (outcomeApplied) {
          bothAgreed = true;
          newStatus  = 'resolved';
          history.push({
            role: 'system',
            text: '✅ Litige résolu par accord mutuel — ' + outcomeLabel(outcomeClient) + '.',
            ts: new Date().toISOString(),
          });
        } else {
          // L'accord existe mais l'opération de paiement a échoué : on ne
          // ment pas aux utilisateurs, et on prévient l'équipe support en
          // conservant les propositions telles quelles (pas de conflit,
          // juste un souci technique à traiter manuellement).
          history.push({
            role: 'system',
            text: "⚠️ Accord trouvé mais le traitement du paiement a échoué techniquement. Notre équipe va intervenir manuellement — pas besoin de reproposer une résolution.",
            ts: new Date().toISOString(),
          });
          await db.execute(
            `UPDATE disputes
             SET resolved_by_client = ?, resolved_by_carrier = ?,
                 resolution_outcome_client = ?, resolution_outcome_carrier = ?,
                 status = ?, resolution = ?, updated_at = NOW()
             WHERE id = ?`,
            [resolvedByClient, resolvedByCarrier, outcomeClient, outcomeCarrier, newStatus, JSON.stringify(history), dispute.id]
          );
          return res.status(502).json({
            error: "Vos propositions concordent, mais une erreur technique a empêché le traitement du paiement. Notre équipe a été alertée et va intervenir manuellement — vous n'avez rien à refaire.",
            bothAgreed: false,
            conflict: false,
            status: newStatus,
          });
        }
      } else {
        // Désaccord — réinitialiser pour permettre une nouvelle tentative
        conflict = true;
        resolvedByClient  = 0;
        resolvedByCarrier = 0;
        outcomeClient  = null;
        outcomeCarrier = null;
        history.push({
          role: 'system',
          text: '⚠️ Vos propositions de résolution diffèrent. Discutez puis proposez une nouvelle résolution.',
          ts: new Date().toISOString(),
        });
      }
    }

    await db.execute(
      `UPDATE disputes
       SET resolved_by_client = ?, resolved_by_carrier = ?,
           resolution_outcome_client = ?, resolution_outcome_carrier = ?,
           status = ?, resolution = ?, updated_at = NOW()
       WHERE id = ?`,
      [resolvedByClient, resolvedByCarrier, outcomeClient, outcomeCarrier, newStatus, JSON.stringify(history), dispute.id]
    );

    res.json({
      success: true,
      bothAgreed,
      conflict,
      status: newStatus,
      resolvedByClient: !!resolvedByClient,
      resolvedByCarrier: !!resolvedByCarrier,
      outcomeClient,
      outcomeCarrier,
      history,
    });
  } catch (err) {
    console.error('Erreur POST /disputes/:id/resolve:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;
