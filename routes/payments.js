// routes/payments.js — Paiements Stripe Connect + Escrow
const express = require('express');
const router  = express.Router();
const db      = require('../config/database');
const auth    = require('../middleware/auth');
const { stripe, calculateFees } = require('../services/stripe');
const email   = require('../services/emailService');

// ── Conformité CGU §6 : seuil de preuve obligatoire et plafond forfaitaire ──
// Au-delà de ce montant déclaré, une preuve de valeur est exigée à la réservation.
const VALUE_PROOF_THRESHOLD_EUR = 50;
// En l'absence de preuve valide, l'indemnisation est plafonnée à ce montant par kg.
const DEFAULT_COMPENSATION_PER_KG_EUR = 20;
// Taille max acceptée pour le fichier de preuve encodé en base64 (5 Mo).
const MAX_VALUE_PROOF_BYTES = 5 * 1024 * 1024;

// ── Générer un code de collecte à 4 chiffres ─────────────────
function generatePickupCode() {
  return String(Math.floor(1000 + Math.random() * 9000));
}

// ── Calcule le plafond d'indemnisation par défaut pour une réservation ──
// (utilisé quand aucune preuve de valeur valide n'a été fournie à la réservation)
function defaultCompensationCap(weightKg) {
  return Math.round(parseFloat(weightKg) * DEFAULT_COMPENSATION_PER_KG_EUR * 100) / 100;
}

// ── POST /api/payments/intent ────────────────
router.post('/intent', auth, async (req, res) => {
  const {
    listingId, weightKg, parcelType, recipientName, recipientPhone, instructions, notes,
    declaredValue, valueProof,
  } = req.body;
  const specialNotes = instructions || notes || null;

  if (!listingId || !weightKg) return res.status(400).json({ error: 'listingId et weightKg requis' });

  // ── Validation de la déclaration de valeur (conforme CGU §6) ──
  const declaredValueNum = declaredValue !== undefined && declaredValue !== null
    ? parseFloat(declaredValue) : 0;
  if (declaredValue !== undefined && (isNaN(declaredValueNum) || declaredValueNum < 0)) {
    return res.status(400).json({ error: 'Valeur déclarée invalide' });
  }

  let valueProofUrl = null;
  if (declaredValueNum > VALUE_PROOF_THRESHOLD_EUR) {
    if (!valueProof) {
      return res.status(400).json({
        error: `Une preuve de valeur (facture, photo datée ou expertise) est requise pour une valeur déclarée supérieure à ${VALUE_PROOF_THRESHOLD_EUR} €.`,
      });
    }
    // Vérification grossière de la taille du base64 reçu (≈ 4/3 de la taille réelle du fichier)
    const approxBytes = Math.ceil((valueProof.length * 3) / 4);
    if (approxBytes > MAX_VALUE_PROOF_BYTES) {
      return res.status(400).json({ error: 'Fichier de preuve trop volumineux (5 Mo max).' });
    }
    // TODO: migrer ce stockage vers un service de fichiers (S3, Hostinger object storage, etc.)
    // plutôt que de conserver le base64 brut en base de données — voir note de déploiement.
    valueProofUrl = valueProof;
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
        hasValueProof: String(!!valueProofUrl),
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

    const pi = await stripe.paymentIntents.create(piParams);

    const pickupCode = generatePickupCode();
    const bookingId  = require('crypto').randomUUID();

    // Valeur indicative conservée pour l'examen des litiges (preuve de bonne foi),
    // mais NE détermine PAS le montant remboursable : HapyLogistic rembourse
    // uniquement le prix du transport payé (client_total), jamais le contenu du
    // colis — voir CGU §6 et §8. Ce champ aide simplement à distinguer une
    // réclamation crédible (valeur déclarée + preuve) d'une réclamation suspecte.
    const compensationCap = valueProofUrl ? declaredValueNum : defaultCompensationCap(weightKg);

    await db.execute(`
      INSERT INTO bookings
        (id, listing_id, client_id, carrier_id, weight_kg, parcel_type,
         recipient_name, recipient_phone, special_notes,
         base_amount, client_fee, carrier_fee, client_total, carrier_net, platform_fee,
         declared_value, value_proof_url, compensation_cap,
         payment_intent_id, pickup_code, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'awaiting_payment')
    `, [
      bookingId, listingId, req.user.id, listing.carrier_id,
      parseFloat(weightKg), parcelType || null,
      recipientName || null, recipientPhone || null, specialNotes,
      base,
      amounts.clientFee  / 100, amounts.carrierFee / 100,
      amounts.clientTotal/ 100, amounts.carrierNet / 100, amounts.platformFee / 100,
      declaredValueNum, valueProofUrl, compensationCap,
      pi.id, pickupCode,
    ]);

    await db.execute(
      'UPDATE listings SET available_kg = available_kg - ? WHERE id = ?',
      [parseFloat(weightKg), listingId]
    );
    await db.execute(
      "UPDATE listings SET status = 'inactive' WHERE id = ? AND available_kg <= 0",
      [listingId]
    );

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
      declaredValue:   declaredValueNum,
      compensationCap,
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

// ── POST /api/payments/confirm-receipt/:id ───────────────────
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
      'UPDATE users SET total_trips = total_trips + 1 WHERE id = ?',
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
router.post('/capture/:id', auth, async (req, res) => {
  try {
    const [rows] = await db.execute('SELECT * FROM bookings WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Réservation introuvable' });
    const booking = rows[0];

    if (booking.status !== 'delivered') {
      return res.status(400).json({ error: 'La livraison doit être confirmée d\'abord' });
    }

    await stripe.paymentIntents.capture(booking.payment_intent_id);
    await db.execute('UPDATE bookings SET status = ? WHERE id = ?', ['completed', booking.id]);
    await db.execute(
      'UPDATE users SET total_trips = total_trips + 1 WHERE id = ?',
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
// pas un assureur de marchandises — voir CGU §6 et §8. declared_value / compensation_cap
// servent uniquement de preuve de bonne foi lors de l'examen du litige, pas de base
// de calcul du remboursement.
router.post('/refund/:id', auth, async (req, res) => {
  const { reason, amount } = req.body;
  try {
    const [rows] = await db.execute('SELECT * FROM bookings WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Réservation introuvable' });
    const booking = rows[0];

    if (booking.client_id !== req.user.id) {
      return res.status(403).json({ error: 'Non autorisé' });
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
router.post('/dispute/:id', auth, async (req, res) => {
  const { reason, description } = req.body;
  try {
    const [rows] = await db.execute('SELECT * FROM bookings WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Réservation introuvable' });
    const booking = rows[0];

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
router.get('/bookings/received', auth, async (req, res) => {
  if (req.user.role !== 'carrier') {
    return res.status(403).json({ error: 'Réservé aux transporteurs' });
  }
  try {
    const [rows] = await db.execute(`
      SELECT b.*,
        l.origin, l.destination, l.departure_date,
        u.first_name, u.last_name, u.email AS client_email
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
    res.json({ bookings: rows });
  } catch (err) {
    console.error('Erreur bookings/me:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;
