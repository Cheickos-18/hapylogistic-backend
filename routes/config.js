// ─────────────────────────────────────────────────────────────────────────────
//  routes/config.js — Endpoint GET /api/config
//  Expose la clé publique Stripe (et autres config publiques) au frontend
//  sans jamais exposer les clés secrètes.
//
//  Dans server.js : app.use('/api', require('./routes/config'));
// ─────────────────────────────────────────────────────────────────────────────
const express = require('express');
const router = express.Router();

router.get('/config', (req, res) => {
  res.json({
    stripePk: process.env.STRIPE_PUBLIC_KEY, // pk_live_... en production
    version: '1.0.0',
  });
});

module.exports = router;


// ─────────────────────────────────────────────────────────────────────────────
//  INTÉGRATION EMAILS — Snippets à ajouter dans vos routes existantes
//
//  Ajoutez en haut de chaque fichier de route concerné :
//  const email = require('../services/emailService');
// ─────────────────────────────────────────────────────────────────────────────

/*
// ── Dans routes/payments.js ── après création réussie du booking ─────────────

// Après : const booking = await Booking.create({...})
// Ajouter :

try {
  const listing = await Listing.findByPk(booking.listingId);
  const client  = await User.findByPk(booking.clientId);
  const carrier = await User.findByPk(listing.carrierId);

  // Email de confirmation au client (avec code de collecte)
  await email.sendBookingConfirmation({
    to:          client.email,
    firstName:   client.firstName,
    booking,
    listing,
    pickupCode:  booking.pickupCode,  // généré à la création du booking
  });

  // Notification au transporteur
  await email.sendNewBookingToCarrier({
    to:              carrier.email,
    carrierFirstName: carrier.firstName,
    booking,
    listing,
    client: { firstName: client.firstName, lastName: client.lastName, email: client.email },
  });
} catch (emailErr) {
  console.error('[EMAIL] sendBookingConfirmation failed:', emailErr.message);
  // Ne pas bloquer la réponse si l'email échoue
}


// ── Dans routes/bookings.js ── PATCH /bookings/:id/pickup ────────────────────
// Quand le transporteur confirme la collecte (status → in_transit)

try {
  const listing = await Listing.findByPk(booking.listingId);
  const client  = await User.findByPk(booking.clientId);

  await email.sendPickupConfirmed({
    to:        client.email,
    firstName: client.firstName,
    booking,
    listing,
  });
} catch (emailErr) {
  console.error('[EMAIL] sendPickupConfirmed failed:', emailErr.message);
}


// ── Dans routes/bookings.js ── PATCH /bookings/:id/delivered ─────────────────
// Quand le transporteur marque la livraison → demande confirmation au client

try {
  const listing = await Listing.findByPk(booking.listingId);
  const client  = await User.findByPk(booking.clientId);

  await email.sendDeliveryRequest({
    to:        client.email,
    firstName: client.firstName,
    booking,
    listing,
  });
} catch (emailErr) {
  console.error('[EMAIL] sendDeliveryRequest failed:', emailErr.message);
}


// ── Dans routes/bookings.js ── PATCH /bookings/:id/confirm-receipt ────────────
// Quand le client confirme la réception → paiement libéré au transporteur

try {
  const listing   = await Listing.findByPk(booking.listingId);
  const carrier   = await User.findByPk(listing.carrierId);
  const netAmount = listing.pricePerKg * booking.weight * 0.93; // moins 7% commission

  await email.sendReceiptConfirmed({
    to:               carrier.email,
    carrierFirstName: carrier.firstName,
    booking,
    listing,
    netAmount,
  });
} catch (emailErr) {
  console.error('[EMAIL] sendReceiptConfirmed failed:', emailErr.message);
}


// ── Dans routes/bookings.js ── PATCH /bookings/:id/cancel ────────────────────
// Quand une réservation est annulée et remboursée

try {
  const listing = await Listing.findByPk(booking.listingId);
  const client  = await User.findByPk(booking.clientId);

  await email.sendRefundNotification({
    to:           client.email,
    firstName:    client.firstName,
    booking,
    listing,
    refundAmount: booking.totalPaid, // montant total payé par le client
    reason:       'Annulation de la réservation',
  });
} catch (emailErr) {
  console.error('[EMAIL] sendRefundNotification failed:', emailErr.message);
}


// ── Dans routes/disputes.js ── POST /disputes ────────────────────────────────
// Quand un litige est ouvert

try {
  const listing = await Listing.findByPk(booking.listingId);
  const client  = await User.findByPk(booking.clientId);
  const carrier = await User.findByPk(listing.carrierId);

  await email.sendDisputeOpened({
    clientEmail:  client.email,
    carrierEmail: carrier.email,
    client:  { firstName: client.firstName,  lastName: client.lastName },
    carrier: { firstName: carrier.firstName, lastName: carrier.lastName },
    booking,
    listing,
    reason: req.body.reason,
  });
} catch (emailErr) {
  console.error('[EMAIL] sendDisputeOpened failed:', emailErr.message);
}

*/
