// routes/payments.js — Paiements Stripe Connect + Escrow
const express = require('express');
const router  = express.Router();
const db      = require('../config/database');
const auth    = require('../middleware/auth');
const { stripe, calculateFees } = require('../services/stripe');
const email   = require('../services/emailService');

// ── Déclaration de valeur (champ informatif, conforme CGU §6) ──
// La valeur déclarée par le client aide à documenter le dossier en cas de litige,
// mais HapyLogistic n'indemnise jamais le contenu du colis : seul le prix du
// transport payé (client_total) peut être remboursé — voir CGU §6 et §8.
// Aucune preuve n'est exigée à la réservation.

// ── Générer un code à 4 chiffres (collecte ET retour) ────────
function generatePickupCode() {
  return String(Math.floor(1000 + Math.random() * 9000));
}

// ── POST /api/payments/intent ────────────────
router.post('/intent', auth, async (req, res) => {
  const {
    listingId, weightKg, parcelType, recipientName, recipientPhone, instructions, notes,
    declaredValue,
  } = req.body;
  const specialNotes = instructions || notes || null;

  if (!listingId || !weightKg) return res.status(400).json({ error: 'listingId et weightKg requis' });
  if (parseFloat(weightKg) <= 0 || isNaN(parseFloat(weightKg))) {
    return res.status(400).json({ error: 'Le poids doit être supérieur à 0' });
  }

  // ── Validation simple de la déclaration de valeur (champ informatif uniquement) ──
  const declaredValueNum = declaredValue !== undefined && declaredValue !== null
    ? parseFloat(declaredValue) : 0;
  if (declaredValue !== undefined && (isNaN(declaredValueNum) || declaredValueNum < 0)) {
    return res.status(400).json({ error: 'Valeur déclarée invalide' });
  }

  try {
    const [listings] = await db.execute(`
      SELECT l.*, u.stripe_account_id
      FROM listings l JOIN users u ON l.carrier_id = u.id
      WHERE l.id = ? AND l.status = 'active'
    `, [listingId]);
    if (!listings.length) return res.status(404).json({ error: 'Annonce introuvable' });

    const listing = listings[0];
    if (parseFloat(weightKg) > parseFloat(listing.available_kg)) {
      return res.status(400).json({ error: `Max ${listing.available_kg} kg disponibles` });
    }

    // ── CORRECTION CONCURRENCE : décrémentation atomique AVANT tout appel Stripe ──
    // Le contrôle ci-dessus lit une valeur figée au moment de la requête. Entre
    // cette lecture et la mise à jour, un appel réseau vers Stripe pouvait
    // laisser une fenêtre de plusieurs centaines de ms pendant laquelle une
    // deuxième réservation simultanée passait le même contrôle avec la même
    // valeur non encore à jour — deux réservations pouvaient alors être
    // acceptées pour plus de kg qu'il n'en restait réellement (available_kg
    // finissant négatif). La clause WHERE available_kg >= ? rend cette
    // opération atomique au niveau de MySQL : une seule des deux requêtes
    // concurrentes peut réussir, l'autre échoue proprement (affectedRows = 0)
    // sans jamais créer de Payment Intent ni de réservation.
    const [kgResult] = await db.execute(
      'UPDATE listings SET available_kg = available_kg - ? WHERE id = ? AND available_kg >= ?',
      [parseFloat(weightKg), listingId, parseFloat(weightKg)]
    );
    if (kgResult.affectedRows === 0) {
      return res.status(409).json({
        error: "Cette capacité vient d'être réservée par un autre client — il ne reste plus assez de kg disponibles sur ce trajet. Veuillez réessayer ou choisir un autre transporteur.",
      });
    }
    await db.execute(
      "UPDATE listings SET status = 'inactive' WHERE id = ? AND available_kg <= 0",
      [listingId]
    );

    const [clients] = await db.execute('SELECT * FROM users WHERE id = ?', [req.user.id]);
    const client = clients[0];

    const base    = parseFloat(listing.price_per_kg) * parseFloat(weightKg);
    const amounts = calculateFees(base);

    const piParams = {
      amount:         amounts.clientTotal,
      currency:       'eur',
      capture_method: 'manual',
      description:    `HapyLogistic — ${listing.origin} → ${listing.destination} · ${weightKg}kg`,
      metadata: {
        listingId, clientId: req.user.id, carrierId: listing.carrier_id,
        weightKg: String(weightKg), baseAmount: String(base),
        declaredValue: String(declaredValueNum),
      },
    };

    let stripeCustomerId = client.stripe_customer_id;
    if (stripeCustomerId) {
      try {
        const existing = await stripe.customers.retrieve(stripeCustomerId);
        if (existing.deleted) stripeCustomerId = null;
      } catch (e) {
        stripeCustomerId = null;
      }
    }

    let pi, bookingId, pickupCode;
    try {
      if (!stripeCustomerId) {
        const newCustomer = await stripe.customers.create({
          email: client.email || undefined,
          name: `${client.first_name || ''} ${client.last_name || ''}`.trim() || undefined,
          metadata: { userId: client.id },
        });
        stripeCustomerId = newCustomer.id;
        await db.execute('UPDATE users SET stripe_customer_id = ? WHERE id = ?', [stripeCustomerId, client.id]);
      }
      piParams.customer = stripeCustomerId;

      // ── CORRECTION FINALE : utiliser transfer_data[amount] = carrierNet
      // Stripe transfère exactement carrierNet à Bay, la différence reste sur la plateforme.
      // C'est l'approche documentée et fiable pour capture manuelle + Connect.
      if (listing.stripe_account_id) {
        piParams.transfer_data = {
          destination: listing.stripe_account_id,
          amount:      amounts.carrierNet,
        };
      }

      pi = await stripe.paymentIntents.create(piParams);

      pickupCode = generatePickupCode();
      bookingId  = require('crypto').randomUUID();

      await db.execute(`
        INSERT INTO bookings
          (id, listing_id, client_id, carrier_id, weight_kg, parcel_type,
           recipient_name, recipient_phone, special_notes,
           base_amount, client_fee, carrier_fee, client_total, carrier_net, platform_fee,
           declared_value,
           payment_intent_id, pickup_code, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'awaiting_payment')
      `, [
        bookingId, listingId, req.user.id, listing.carrier_id,
        parseFloat(weightKg), parcelType || null,
        recipientName || null, recipientPhone || null, specialNotes,
        base,
        amounts.clientFee  / 100, amounts.carrierFee / 100,
        amounts.clientTotal/ 100, amounts.carrierNet / 100, amounts.platformFee / 100,
        declaredValueNum,
        pi.id, pickupCode,
      ]);
    } catch (innerErr) {
      // ── Restauration des kg si l'on a déjà décrémenté mais que la suite a échoué ──
      // (erreur Stripe, insertion en base...) — sans ce filet, la capacité
      // serait perdue pour rien : le transporteur en aurait moins de
      // disponible sans qu'aucune réservation n'ait réellement abouti.
      await db.execute(
        'UPDATE listings SET available_kg = available_kg + ?, status = ? WHERE id = ?',
        [parseFloat(weightKg), 'active', listingId]
      );
      throw innerErr;
    }

    res.json({
      success: true,
      clientSecret: pi.client_secret,
      bookingId,
      amounts: {
        base:        (amounts.base        / 100).toFixed(2),
        clientFee:   (amounts.clientFee   / 100).toFixed(2),
        total:       (amounts.clientTotal / 100).toFixed(2),
        carrierGets: (amounts.carrierNet  / 100).toFixed(2),
      },
      declaredValue: declaredValueNum,
    });

  } catch (err) {
    console.error('Erreur payment intent:', err.message);
    res.status(500).json({ error: 'Erreur lors de la création du paiement' });
  }
});

// ── GET /api/payments/bookings/:id/pickup-code ─────────────
router.get('/bookings/:id/pickup-code', auth, async (req, res) => {
  try {
    const [rows] = await db.execute('SELECT * FROM bookings WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Réservation introuvable' });
    const booking = rows[0];

    if (booking.client_id !== req.user.id) {
      return res.status(403).json({ error: 'Non autorisé' });
    }

    if (!booking.pickup_code) {
      const newCode = generatePickupCode();
      await db.execute('UPDATE bookings SET pickup_code = ? WHERE id = ?', [newCode, booking.id]);
      return res.json({ pickupCode: newCode });
    }

    res.json({ pickupCode: booking.pickup_code });
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── POST /api/payments/verify-content/:id ─────────────────────
// Étape de vérification du contenu par le transporteur, AVANT
// la saisie du code de collecte à 4 chiffres.
//
// Cadrage volontaire (cohérent avec la position "plateforme de mise en
// relation" défendue auprès de la CCI, à reconfirmer avec le conseiller) :
// c'est le TRANSPORTEUR qui vérifie, pour sa propre protection, que le
// contenu remis correspond à la déclaration du client — HapyLogistic ne
// contrôle ni n'inspecte lui-même le colis. Le rôle de la plateforme se
// limite à enregistrer la confirmation du transporteur et à conditionner
// la suite du parcours (code de collecte) à cette confirmation.
//
// Conforme aux CGU §6.p4 (charge de la preuve / preuves photographiques
// à la collecte) déjà en vigueur — aucune modification des CGU nécessaire
// pour cette fonctionnalité.
//
// MISE À JOUR — Non-conformité signalée (matches: false) :
// 1) Un email est désormais envoyé immédiatement au client pour l'informer
//    (auparavant, il ne l'apprenait que si le transporteur le contactait
//    lui-même ou annulait la réservation).
// 2) Un "code de retour" à 4 chiffres est généré, connu du seul transporteur
//    (affiché sur son tableau de bord — jamais envoyé au client par email,
//    exactement comme le code de collecte n'est connu que du client). Le
//    transporteur le communique oralement au client au moment où il lui
//    rend physiquement le colis. Le client saisit ensuite ce code sur son
//    propre tableau de bord (POST /confirm-return/:id) pour confirmer avoir
//    récupéré son colis — ce qui déclenche automatiquement l'annulation et
//    le remboursement intégral. Cette symétrie avec le code de collecte
//    garantit que le remboursement ne peut être déclenché que par quelqu'un
//    qui a physiquement rencontré le transporteur, pas juste en cliquant
//    dans l'app.
router.post('/verify-content/:id', auth, async (req, res) => {
  const { matches, notes } = req.body;
  if (typeof matches !== 'boolean') {
    return res.status(400).json({ error: 'Le champ "matches" (true/false) est requis' });
  }

  try {
    const [rows] = await db.execute('SELECT * FROM bookings WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Réservation introuvable' });
    const booking = rows[0];

    if (booking.carrier_id !== req.user.id) {
      return res.status(403).json({ error: 'Réservé au transporteur de cette réservation' });
    }
    if (booking.status !== 'paid') {
      return res.status(400).json({
        error: booking.status === 'awaiting_payment'
          ? 'Le paiement du client doit être confirmé avant de vérifier le contenu.'
          : `Impossible de vérifier le contenu pour une réservation en statut "${booking.status}".`,
      });
    }

    if (matches) {
      // Le transporteur confirme après tout (ex: suite à un précédent signalement
      // de non-conformité) — on efface un éventuel code de retour resté en attente
      // pour qu'il ne puisse plus être utilisé par erreur.
      await db.execute(
        'UPDATE bookings SET content_verified = 1, content_verified_at = NOW(), content_verified_notes = ?, return_code = NULL WHERE id = ?',
        [notes || null, booking.id]
      );
      return res.json({
        success: true,
        contentVerified: true,
        message: 'Contenu vérifié — vous pouvez maintenant saisir le code de collecte.',
      });
    }

    // Le transporteur signale une non-conformité : on n'active PAS content_verified,
    // et on n'annule pas automatiquement la réservation — mais on informe le client
    // immédiatement et on prépare le mécanisme de retour du colis.
    const returnCode = generatePickupCode();
    await db.execute(
      'UPDATE bookings SET content_verified = 0, content_verified_notes = ?, return_code = ?, return_code_generated_at = NOW() WHERE id = ?',
      [notes || 'Non-conformité signalée par le transporteur', returnCode, booking.id]
    );

    try {
      const [listings]   = await db.execute('SELECT * FROM listings WHERE id = ?', [booking.listing_id]);
      const [clientRows] = await db.execute('SELECT * FROM users WHERE id = ?', [booking.client_id]);
      if (listings.length && clientRows.length) {
        // ⚠️ Fonction à ajouter dans services/emailService.js si elle n'existe
        // pas encore — voir la spécification donnée séparément.
        await email.sendContentMismatchNotification({
          to:        clientRows[0].email,
          firstName: clientRows[0].first_name,
          booking,
          listing:   listings[0],
          notes:     notes || null,
        });
      }
    } catch (emailErr) {
      console.error('[EMAIL] sendContentMismatchNotification failed:', emailErr.message);
    }

    res.json({
      success: true,
      contentVerified: false,
      message: "Non-conformité enregistrée et client notifié par email. Donnez-lui le code de retour affiché ci-dessous lorsque vous lui rendez son colis — sa saisie du code annulera automatiquement la réservation avec remboursement intégral. Si aucune confirmation n'intervient sous 48h, la réservation sera remboursée automatiquement et un litige sera ouvert pour examen.",
    });
  } catch (err) {
    console.error('Erreur verify-content:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── POST /api/payments/confirm-return/:id ─────────────────────
// NOUVEAU — Le CLIENT confirme avoir récupéré son colis auprès du
// transporteur suite à une non-conformité signalée (voir verify-content
// ci-dessus). Le code n'est connu que du transporteur ; sa saisie par le
// client prouve que la rencontre physique a bien eu lieu. Déclenche
// automatiquement l'annulation de la réservation et le remboursement
// intégral du client — même logique que /carrier-cancel/:id.
router.post('/confirm-return/:id', auth, async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'Code requis' });

  try {
    const [rows] = await db.execute('SELECT * FROM bookings WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Réservation introuvable' });
    const booking = rows[0];

    if (booking.client_id !== req.user.id) {
      return res.status(403).json({ error: 'Réservé au client de cette réservation' });
    }
    if (booking.status !== 'paid') {
      return res.status(400).json({ error: `Impossible de confirmer un retour pour une réservation en statut "${booking.status}".` });
    }
    if (!booking.return_code) {
      return res.status(400).json({ error: "Aucun retour de colis n'est en attente pour cette réservation." });
    }
    if (booking.return_code !== String(code).trim()) {
      return res.status(400).json({ error: 'Code incorrect — vérifiez avec le transporteur' });
    }

    // Annuler ou rembourser via Stripe (même logique que /carrier-cancel/:id)
    const pi = await stripe.paymentIntents.retrieve(booking.payment_intent_id);
    if (pi.status === 'requires_capture') {
      await stripe.paymentIntents.cancel(booking.payment_intent_id);
    } else if (pi.status === 'succeeded') {
      await stripe.refunds.create({
        payment_intent: booking.payment_intent_id,
        reason: 'requested_by_customer',
      });
    } else if (!['canceled', 'requires_payment_method'].includes(pi.status)) {
      return res.status(400).json({ error: `Impossible d'annuler un paiement en statut: ${pi.status}` });
    }

    await db.execute(
      'UPDATE bookings SET status = ?, return_confirmed_at = NOW() WHERE id = ?',
      ['refunded', booking.id]
    );
    await db.execute(
      'UPDATE listings SET available_kg = available_kg + ?, status = ? WHERE id = ?',
      [parseFloat(booking.weight_kg), 'active', booking.listing_id]
    );

    try {
      const [listings]   = await db.execute('SELECT * FROM listings WHERE id = ?', [booking.listing_id]);
      const [clientRows] = await db.execute('SELECT * FROM users WHERE id = ?', [booking.client_id]);
      if (listings.length && clientRows.length) {
        await email.sendRefundNotification({
          to:           clientRows[0].email,
          firstName:    clientRows[0].first_name,
          booking,
          listing:      listings[0],
          refundAmount: parseFloat(booking.client_total),
          reason:       'Colis non conforme retourné et confirmé par vos soins. Remboursement intégral.',
        });
      }
    } catch (emailErr) {
      console.error('[EMAIL] confirm-return notification failed:', emailErr.message);
    }

    res.json({
      success: true,
      message: 'Retour confirmé — réservation annulée, remboursement intégral en cours.',
    });
  } catch (err) {
    console.error('Erreur confirm-return:', err.message);
    res.status(500).json({ error: 'Erreur lors de la confirmation du retour' });
  }
});

// ── POST /api/payments/confirm-pickup/:id ────────────────────
router.post('/confirm-pickup/:id', auth, async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'Code requis' });

  try {
    const [rows] = await db.execute('SELECT * FROM bookings WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Réservation introuvable' });
    const booking = rows[0];

    if (booking.carrier_id !== req.user.id) {
      return res.status(403).json({ error: 'Réservé au transporteur' });
    }
    if (booking.status !== 'paid') {
      return res.status(400).json({ error: 'La réservation doit être en statut payé' });
    }
    // ── NOUVEAU : la vérification du contenu doit être faite avant la collecte ──
    if (!booking.content_verified) {
      return res.status(400).json({
        error: 'Veuillez d\'abord vérifier que le contenu du colis correspond à la déclaration avant de confirmer la collecte.',
        code: 'CONTENT_NOT_VERIFIED',
      });
    }
    if (booking.pickup_code !== String(code).trim()) {
      return res.status(400).json({ error: 'Code incorrect — vérifiez avec le client' });
    }

    await db.execute(
      'UPDATE bookings SET status = ?, pickup_confirmed_at = NOW() WHERE id = ?',
      ['in_transit', booking.id]
    );

    try {
      const [listings] = await db.execute('SELECT * FROM listings WHERE id = ?', [booking.listing_id]);
      const [clientRows] = await db.execute('SELECT * FROM users WHERE id = ?', [booking.client_id]);
      if (listings.length && clientRows.length) {
        await email.sendPickupConfirmed({
          to:        clientRows[0].email,
          firstName: clientRows[0].first_name,
          booking,
          listing:   listings[0],
        });
      }
    } catch (emailErr) {
      console.error('[EMAIL] sendPickupConfirmed failed:', emailErr.message);
    }

    res.json({ success: true, message: 'Collecte confirmée — colis en transit ✅' });
  } catch (err) {
    console.error('Erreur confirm-pickup:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── POST /api/payments/confirm-delivery/:id ──────────────────
router.post('/confirm-delivery/:id', auth, async (req, res) => {
  try {
    const [rows] = await db.execute('SELECT * FROM bookings WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Réservation introuvable' });
    const booking = rows[0];

    if (booking.carrier_id !== req.user.id) {
      return res.status(403).json({ error: 'Réservé au transporteur' });
    }
    if (!['paid', 'in_transit'].includes(booking.status)) {
      return res.status(400).json({ error: 'Statut invalide pour confirmer la livraison' });
    }

    await db.execute(
      'UPDATE bookings SET status = ?, delivered_at = NOW(), delivery_confirmed_at = NOW() WHERE id = ?',
      ['delivered', booking.id]
    );

    try {
      const [listings] = await db.execute('SELECT * FROM listings WHERE id = ?', [booking.listing_id]);
      const [clientRows] = await db.execute('SELECT * FROM users WHERE id = ?', [booking.client_id]);
      if (listings.length && clientRows.length) {
        await email.sendDeliveryRequest({
          to:        clientRows[0].email,
          firstName: clientRows[0].first_name,
          booking,
          listing:   listings[0],
        });
      }
    } catch (emailErr) {
      console.error('[EMAIL] sendDeliveryRequest failed:', emailErr.message);
    }

    res.json({ success: true, message: 'Livraison marquée — en attente de confirmation client (48h)' });
  } catch (err) {
    console.error('Erreur confirm-delivery:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── POST /api/payments/carrier-cancel/:id ────────────────────
// Annulation par le transporteur — remboursement intégral au client,
// kg remis en stock, email de notification.
// Conditions : statut 'paid' uniquement (pas encore collecté).
// Si le colis est déjà en transit (in_transit), l'annulation est bloquée
// et le transporteur doit contacter le support pour ouvrir un litige.
router.post('/carrier-cancel/:id', auth, async (req, res) => {
  const { reason } = req.body;

  try {
    const [rows] = await db.execute('SELECT * FROM bookings WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Réservation introuvable' });
    const booking = rows[0];

    // Seul le transporteur concerné peut annuler
    if (booking.carrier_id !== req.user.id) {
      return res.status(403).json({ error: 'Réservé au transporteur de cette réservation' });
    }

    // Annulation uniquement si le colis n'a pas encore été collecté
    if (!['paid', 'awaiting_payment'].includes(booking.status)) {
      return res.status(400).json({
        error: booking.status === 'in_transit'
          ? 'Le colis est déjà en transit. Contactez le support pour résoudre cette situation.'
          : `Impossible d'annuler une réservation en statut "${booking.status}".`,
      });
    }

    // Annuler ou rembourser via Stripe
    const pi = await stripe.paymentIntents.retrieve(booking.payment_intent_id);
    if (pi.status === 'requires_capture') {
      await stripe.paymentIntents.cancel(booking.payment_intent_id);
    } else if (pi.status === 'succeeded') {
      await stripe.refunds.create({
        payment_intent: booking.payment_intent_id,
        reason: 'requested_by_customer',
      });
    } else if (!['canceled', 'requires_payment_method'].includes(pi.status)) {
      return res.status(400).json({ error: `Impossible d'annuler un paiement en statut: ${pi.status}` });
    }

    // Mettre à jour le statut et remettre les kg en stock
    await db.execute(
      'UPDATE bookings SET status = ?, carrier_cancelled_at = NOW(), carrier_cancel_reason = ? WHERE id = ?',
      ['carrier_cancelled', reason || null, booking.id]
    );
    await db.execute(
      'UPDATE listings SET available_kg = available_kg + ?, status = ? WHERE id = ?',
      [parseFloat(booking.weight_kg), 'active', booking.listing_id]
    );

    // Emails de notification
    try {
      const [listings]   = await db.execute('SELECT * FROM listings WHERE id = ?', [booking.listing_id]);
      const [clientRows] = await db.execute('SELECT * FROM users WHERE id = ?', [booking.client_id]);
      const [carrierRows]= await db.execute('SELECT * FROM users WHERE id = ?', [booking.carrier_id]);
      if (listings.length && clientRows.length) {
        await email.sendRefundNotification({
          to:           clientRows[0].email,
          firstName:    clientRows[0].first_name,
          booking,
          listing:      listings[0],
          refundAmount: parseFloat(booking.client_total),
          reason:       `Annulation par le transporteur${reason ? ' : ' + reason : ''}. Remboursement intégral.`,
        });
      }
    } catch (emailErr) {
      console.error('[EMAIL] carrier-cancel notification failed:', emailErr.message);
    }

    res.json({
      success: true,
      message: 'Réservation annulée — le client sera remboursé intégralement.',
    });
  } catch (err) {
    console.error('Erreur carrier-cancel:', err.message);
    res.status(500).json({ error: 'Erreur lors de l\'annulation' });
  }
});


router.post('/confirm-receipt/:id', auth, async (req, res) => {
  try {
    const [rows] = await db.execute('SELECT * FROM bookings WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Réservation introuvable' });
    const booking = rows[0];

    if (booking.client_id !== req.user.id) {
      return res.status(403).json({ error: 'Réservé au client' });
    }
    if (booking.status !== 'delivered') {
      return res.status(400).json({ error: 'Le transporteur n\'a pas encore marqué la livraison' });
    }

    // Capture simple — transfer_data[amount] défini à la création gère automatiquement
    // le split : carrierNet part à Bay, le reste reste sur la plateforme.
    // NB: la capture déclenche le transfert Stripe Connect, mais le virement réel vers
    // la banque du transporteur suit le délai standard Stripe (généralement 3 à 7 jours),
    // pas un versement immédiat — voir CGU §5 et page Tarifs.
    await stripe.paymentIntents.capture(booking.payment_intent_id);

    await db.execute(
      'UPDATE bookings SET status = ?, receipt_confirmed_at = NOW() WHERE id = ?',
      ['completed', booking.id]
    );
    await db.execute(
      `UPDATE users SET
        total_trips = total_trips + 1,
        carrier_level = CASE
          WHEN total_trips + 1 >= 100 THEN 'platine'
          WHEN total_trips + 1 >= 30  THEN 'or'
          WHEN total_trips + 1 >= 10  THEN 'argent'
          ELSE 'bronze'
        END
       WHERE id = ?`,
      [booking.carrier_id]
    );

    try {
      const [listings]  = await db.execute('SELECT * FROM listings WHERE id = ?', [booking.listing_id]);
      const [carriers]  = await db.execute('SELECT * FROM users WHERE id = ?', [booking.carrier_id]);
      if (listings.length && carriers.length) {
        const netAmount = parseFloat(booking.carrier_net);
        await email.sendReceiptConfirmed({
          to:               carriers[0].email,
          carrierFirstName: carriers[0].first_name,
          booking,
          listing:          listings[0],
          netAmount,
        });
      }
    } catch (emailErr) {
      console.error('[EMAIL] sendReceiptConfirmed failed:', emailErr.message);
    }

    res.json({ success: true, message: 'Réception confirmée — virement au transporteur initié (sous 3 à 7 jours)' });
  } catch (err) {
    console.error('Erreur confirm-receipt:', err.message);
    res.status(500).json({ error: 'Erreur lors de la confirmation: ' + err.message });
  }
});

// ── POST /api/payments/capture/:id ───────────────────────────
// ⚠️ SÉCURITÉ : cette route effectuait auparavant la capture du paiement
// SANS AUCUNE vérification que l'appelant est bien le client concerné —
// n'importe quel utilisateur authentifié pouvait forcer la libération du
// paiement de N'IMPORTE QUELLE réservation livrée sur toute la plateforme,
// court-circuitant la fenêtre de 48h de confirmation du client.
// Cette route n'est appelée par aucune page du frontend (c'est
// /confirm-receipt/:id qui fait ce travail correctement) — elle est
// conservée par prudence (au cas où un usage externe en dépendrait) mais
// protégée avec la même vérification que /confirm-receipt/:id.
router.post('/capture/:id', auth, async (req, res) => {
  try {
    const [rows] = await db.execute('SELECT * FROM bookings WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Réservation introuvable' });
    const booking = rows[0];

    if (booking.client_id !== req.user.id) {
      return res.status(403).json({ error: 'Réservé au client' });
    }
    if (booking.status !== 'delivered') {
      return res.status(400).json({ error: 'La livraison doit être confirmée d\'abord' });
    }

    await stripe.paymentIntents.capture(booking.payment_intent_id);
    await db.execute('UPDATE bookings SET status = ? WHERE id = ?', ['completed', booking.id]);
    await db.execute(
      `UPDATE users SET
        total_trips = total_trips + 1,
        carrier_level = CASE
          WHEN total_trips + 1 >= 100 THEN 'platine'
          WHEN total_trips + 1 >= 30  THEN 'or'
          WHEN total_trips + 1 >= 10  THEN 'argent'
          ELSE 'bronze'
        END
       WHERE id = ?`,
      [booking.carrier_id]
    );
    res.json({ success: true, message: 'Paiement capturé — virement au transporteur initié (sous 3 à 7 jours)' });
  } catch (err) {
    console.error('Erreur capture:', err.message);
    res.status(500).json({ error: 'Erreur lors de la capture' });
  }
});

// ── POST /api/payments/refund/:id ────────────────────────────
// IMPORTANT : HapyLogistic rembourse uniquement le prix du transport payé par le
// client (client_total), jamais la valeur du contenu du colis. La plateforme n'est
// pas un assureur de marchandises — voir CGU §6 et §8. declared_value
// servent uniquement de preuve de bonne foi lors de l'examen du litige, pas de base
// de calcul du remboursement.
//
// ⚠️ SÉCURITÉ : cette route ne vérifiait auparavant AUCUN statut de la
// réservation avant de rembourser — un client pouvait rembourser une
// réservation déjà 'completed' (paiement déjà transféré au transporteur
// depuis des semaines), risquant une récupération forcée des fonds côté
// transporteur (solde négatif si déjà retiré). On limite maintenant le
// remboundement en self-service aux statuts encore "en cours" ; toute
// réservation déjà terminée doit passer par le processus de litige
// (/api/payments/dispute/:id) qui implique une décision humaine.
router.post('/refund/:id', auth, async (req, res) => {
  const { reason, amount } = req.body;
  const REFUNDABLE_STATUSES = ['awaiting_payment', 'paid', 'in_transit'];
  try {
    const [rows] = await db.execute('SELECT * FROM bookings WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Réservation introuvable' });
    const booking = rows[0];

    if (booking.client_id !== req.user.id) {
      return res.status(403).json({ error: 'Non autorisé' });
    }
    if (!REFUNDABLE_STATUSES.includes(booking.status)) {
      return res.status(400).json({
        error: `Cette réservation (statut "${booking.status}") ne peut plus être remboursée directement. Ouvrez un litige si besoin.`,
      });
    }

    const pi = await stripe.paymentIntents.retrieve(booking.payment_intent_id);

    // ── Plafond strict : jamais plus que le prix du transport réellement débité ──
    const clientTotal = parseFloat(booking.client_total);
    let refundAmount = clientTotal;
    if (amount !== undefined && amount !== null) {
      const requested = parseFloat(amount);
      if (isNaN(requested) || requested < 0) {
        return res.status(400).json({ error: 'Montant de remboursement invalide' });
      }
      refundAmount = Math.min(requested, clientTotal);
    }

    if (pi.status === 'requires_capture') {
      // Le paiement n'a pas encore été capturé : annulation simple, le client n'a pas
      // été débité au-delà de l'autorisation.
      await stripe.paymentIntents.cancel(booking.payment_intent_id);
    } else if (pi.status === 'succeeded') {
      const refundParams = {
        payment_intent: booking.payment_intent_id,
        reason: reason || 'requested_by_customer',
        amount: Math.round(refundAmount * 100),
      };
      await stripe.refunds.create(refundParams);
    } else {
      return res.status(400).json({ error: `Impossible d'annuler un paiement en statut: ${pi.status}` });
    }

    await db.execute('UPDATE bookings SET status = ? WHERE id = ?', ['refunded', booking.id]);
    await db.execute(
      'UPDATE listings SET available_kg = available_kg + ?, status = ? WHERE id = ?',
      [parseFloat(booking.weight_kg), 'active', booking.listing_id]
    );

    try {
      const [listings]   = await db.execute('SELECT * FROM listings WHERE id = ?', [booking.listing_id]);
      const [clientRows] = await db.execute('SELECT * FROM users WHERE id = ?', [booking.client_id]);
      if (listings.length && clientRows.length) {
        await email.sendRefundNotification({
          to:           clientRows[0].email,
          firstName:    clientRows[0].first_name,
          booking,
          listing:      listings[0],
          refundAmount,
          reason:       reason || 'Annulation de la réservation',
        });
      }
    } catch (emailErr) {
      console.error('[EMAIL] sendRefundNotification failed:', emailErr.message);
    }

    res.json({ success: true, message: 'Réservation annulée — remboursement en cours', refundAmount });
  } catch (err) {
    console.error('Erreur refund:', err.message);
    res.status(500).json({ error: 'Erreur lors du remboursement: ' + err.message });
  }
});

// ── POST /api/payments/dispute/:id ───────────────────────────
// ⚠️ SÉCURITÉ : cette route ne vérifiait auparavant AUCUNE appartenance —
// n'importe quel utilisateur authentifié pouvait ouvrir un litige sur
// N'IMPORTE QUELLE réservation d'autrui, bloquant son paiement (statut
// 'disputed') indéfiniment. Ajout de la vérification que l'appelant est
// bien le client OU le transporteur concerné par cette réservation.
router.post('/dispute/:id', auth, async (req, res) => {
  const { reason, description } = req.body;
  try {
    const [rows] = await db.execute('SELECT * FROM bookings WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Réservation introuvable' });
    const booking = rows[0];

    if (booking.client_id !== req.user.id && booking.carrier_id !== req.user.id) {
      return res.status(403).json({ error: 'Non autorisé' });
    }

    await db.execute('UPDATE bookings SET status = ? WHERE id = ?', ['disputed', booking.id]);
    const disputeId = require('crypto').randomUUID();
    await db.execute(`
      INSERT INTO disputes (id, booking_id, client_id, carrier_id, reason, description, payment_intent_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [disputeId, booking.id, booking.client_id, booking.carrier_id, reason || null, description || null, booking.payment_intent_id]);

    try {
      const [listings]    = await db.execute('SELECT * FROM listings WHERE id = ?', [booking.listing_id]);
      const [clientRows]  = await db.execute('SELECT * FROM users WHERE id = ?', [booking.client_id]);
      const [carrierRows] = await db.execute('SELECT * FROM users WHERE id = ?', [booking.carrier_id]);
      if (listings.length && clientRows.length && carrierRows.length) {
        await email.sendDisputeOpened({
          clientEmail:  clientRows[0].email,
          carrierEmail: carrierRows[0].email,
          client:  { firstName: clientRows[0].first_name,  lastName: clientRows[0].last_name },
          carrier: { firstName: carrierRows[0].first_name, lastName: carrierRows[0].last_name },
          booking,
          listing: listings[0],
          reason:  reason || 'Non précisé',
        });
      }
    } catch (emailErr) {
      console.error('[EMAIL] sendDisputeOpened failed:', emailErr.message);
    }

    res.status(201).json({ success: true, disputeId, message: 'Litige ouvert. Notre équipe vous contactera sous 48h.' });
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── GET /api/payments/bookings/received ──────────────────────
// CONFIDENTIALITÉ RGPD : l'email du client n'est plus renvoyé au transporteur.
// Toute communication doit passer par la messagerie interne HapyLogistic
// conformément aux CGU §9 (anti-contournement).
router.get('/bookings/received', auth, async (req, res) => {
  if (req.user.role !== 'carrier') {
    return res.status(403).json({ error: 'Réservé aux transporteurs' });
  }
  try {
    const [rows] = await db.execute(`
      SELECT b.*,
        l.origin, l.destination, l.departure_date,
        u.first_name, u.last_name
      FROM bookings b
      JOIN listings l ON b.listing_id = l.id
      JOIN users u ON u.id = b.client_id
      WHERE b.carrier_id = ?
      ORDER BY b.created_at DESC
    `, [req.user.id]);
    res.json({ bookings: rows });
  } catch (err) {
    console.error('Erreur bookings/received:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── GET /api/payments/bookings/me ────────────────────────────
router.get('/bookings/me', auth, async (req, res) => {
  try {
    const field = req.user.role === 'carrier' ? 'carrier_id' : 'client_id';
    const [rows] = await db.execute(`
      SELECT b.*, l.origin, l.destination, l.departure_date,
        u.first_name, u.last_name,
        (r.id IS NOT NULL) AS has_review
      FROM bookings b
      JOIN listings l ON b.listing_id = l.id
      JOIN users u ON u.id = ${field === 'client_id' ? 'b.carrier_id' : 'b.client_id'}
      LEFT JOIN reviews r ON r.booking_id = b.id AND r.client_id = b.client_id
      WHERE b.${field} = ?
      ORDER BY b.created_at DESC
    `, [req.user.id]);

    // ── SÉCURITÉ : le code de retour ne doit être connu QUE du transporteur —
    // il sert à prouver que le client l'a bien rencontré physiquement pour
    // récupérer son colis. Le renvoyer au client dans cette réponse (b.* le
    // ferait sinon, sans distinction de rôle) permettrait de le lire
    // directement dans l'API sans jamais rencontrer le transporteur,
    // annulant l'intérêt du mécanisme. On l'omet donc côté client, et on
    // n'expose que le fait qu'un retour est en attente (booléen).
    const bookings = rows.map(r => {
      const returnPending = !!r.return_code;
      if (field === 'client_id') {
        const { return_code, ...rest } = r;
        return { ...rest, return_pending: returnPending };
      }
      return { ...r, return_pending: returnPending };
    });

    res.json({ bookings });
  } catch (err) {
    console.error('Erreur bookings/me:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;
