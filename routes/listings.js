// routes/listings.js — Annonces transporteurs
const express = require('express');
const router  = express.Router();
const db      = require('../config/database');
const auth    = require('../middleware/auth');
const { stripe } = require('../services/stripe');

// ── Helper : rembourser toutes les réservations paid d'une annonce ──
async function refundListingBookings(listingId, reason) {
  const [bookings] = await db.execute(
    "SELECT * FROM bookings WHERE listing_id = ? AND status = 'paid'",
    [listingId]
  );
  for (const booking of bookings) {
    try {
      const pi = await stripe.paymentIntents.retrieve(booking.payment_intent_id);
      if (pi.status === 'requires_capture') {
        await stripe.paymentIntents.cancel(booking.payment_intent_id);
      } else if (pi.status === 'succeeded') {
        await stripe.refunds.create({ payment_intent: booking.payment_intent_id, reason: 'requested_by_customer' });
      }
      await db.execute("UPDATE bookings SET status = 'refunded' WHERE id = ?", [booking.id]);
      console.log(`Auto-refund booking ${booking.id} — reason: ${reason}`);
    } catch(e) {
      console.error(`Erreur refund booking ${booking.id}:`, e.message);
    }
  }
  return bookings.length;
}

// ── Helper : normaliser pickupMode / pickupCities ────────────
function normalizePickup(pickupMode, pickupCities, fallbackOrigin) {
  const mode = pickupMode === 'collect' && Array.isArray(pickupCities) && pickupCities.length
    ? 'collect'
    : 'dropoff';
  const cities = mode === 'collect'
    ? pickupCities.map(c => String(c).trim()).filter(Boolean)
    : [fallbackOrigin];
  return { mode, cities };
}

// ── GET /api/listings ────────────────────────
router.get('/', async (req, res) => {
  const { destination, type, zone, minKg, maxPrice, level, sort = 'rating' } = req.query;

  let sql = `
    SELECT l.*,
      u.first_name, u.last_name, u.carrier_level, u.carrier_type,
      u.total_trips, u.average_rating, u.country
    FROM listings l
    JOIN users u ON l.carrier_id = u.id
    WHERE l.status = 'active' AND l.departure_date >= CURDATE()
  `;
  const params = [];

  if (destination) { sql += ' AND l.destination LIKE ?'; params.push(`%${destination}%`); }
  if (type)        { sql += ' AND l.type = ?';           params.push(type); }
  if (zone)        { sql += ' AND l.zone = ?';           params.push(zone); }
  if (minKg)       { sql += ' AND l.available_kg >= ?';  params.push(parseFloat(minKg)); }
  if (maxPrice)    { sql += ' AND l.price_per_kg <= ?';  params.push(parseFloat(maxPrice)); }
  if (level)       { sql += ' AND u.carrier_level = ?';  params.push(level); }

  const orderMap = {
    rating:     'u.average_rating DESC',
    price_asc:  'l.price_per_kg ASC',
    price_desc: 'l.price_per_kg DESC',
    trips:      'u.total_trips DESC',
    date:       'l.departure_date ASC',
  };
  sql += ` ORDER BY ${orderMap[sort] || orderMap.rating} LIMIT 50`;

  try {
    const [rows] = await db.execute(sql, params);
    const listings = rows.map(r => {
      let pickupCities = [];
      try { pickupCities = r.pickup_cities ? JSON.parse(r.pickup_cities) : []; } catch { pickupCities = []; }
      return {
        id:           r.id,
        carrierId:    r.carrier_id,
        carrierName:  `${r.first_name} ${r.last_name[0]}.`,
        carrierLevel: r.carrier_level,
        carrierTrips: r.total_trips,
        carrierRating:parseFloat(r.average_rating) || 0,
        from:         r.origin,
        to:           r.destination,
        countryFrom:  r.country_from,
        countryTo:    r.country_to,
        zone:         r.zone,
        date:         r.departure_date,
        kg:           parseFloat(r.available_kg),
        price:        parseFloat(r.price_per_kg),
        type:         r.type,
        description:  r.description,
        status:       r.status,
        pickupMode:   r.pickup_mode || 'dropoff',
        pickupCities: pickupCities,
      };
    });
    res.json({ count: listings.length, listings });
  } catch (err) {
    console.error('Erreur listings:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── GET /api/listings/carrier/me ─────────────
// IMPORTANT : cette route doit être AVANT /:id sinon Express l'interprète comme un id
router.get('/carrier/me', auth, async (req, res) => {
  if (req.user.role !== 'carrier') return res.status(403).json({ error: 'Non autorisé' });
  try {
    const [rows] = await db.execute(
      'SELECT * FROM listings WHERE carrier_id = ? ORDER BY created_at DESC',
      [req.user.id]
    );
    const listings = rows.map(r => {
      let pickupCities = [];
      try { pickupCities = r.pickup_cities ? JSON.parse(r.pickup_cities) : []; } catch { pickupCities = []; }
      return { ...r, pickup_mode: r.pickup_mode || 'dropoff', pickup_cities: pickupCities };
    });
    res.json({ listings });
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── GET /api/listings/:id ────────────────────
router.get('/:id', async (req, res) => {
  try {
    const [rows] = await db.execute(`
      SELECT l.*, u.first_name, u.last_name, u.carrier_level,
             u.total_trips, u.average_rating, u.country, u.status AS carrier_status
      FROM listings l JOIN users u ON l.carrier_id = u.id
      WHERE l.id = ?
    `, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Annonce introuvable' });
    const r = rows[0];
    let pickupCities = [];
    try { pickupCities = r.pickup_cities ? JSON.parse(r.pickup_cities) : []; } catch { pickupCities = []; }
    res.json({
      id: r.id, carrierId: r.carrier_id,
      carrierName: `${r.first_name} ${r.last_name[0]}.`,
      carrierLevel: r.carrier_level, carrierTrips: r.total_trips,
      carrierRating: parseFloat(r.average_rating) || 0,
      from: r.origin, to: r.destination,
      date: r.departure_date, kg: parseFloat(r.available_kg),
      price: parseFloat(r.price_per_kg), type: r.type,
      description: r.description, status: r.status,
      pickupMode: r.pickup_mode || 'dropoff',
      pickupCities: pickupCities,
    });
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── POST /api/listings — Créer une annonce ───
router.post('/', auth, async (req, res) => {
  if (req.user.role !== 'carrier') {
    return res.status(403).json({ error: 'Réservé aux transporteurs' });
  }

  // ── Vérification KYC ──────────────────────────────────────
  // Le JWT ne contient pas le statut à jour (il peut avoir changé
  // depuis la connexion, via le webhook Stripe account.updated).
  // On bloque la publication tant que la vérification d'identité
  // Stripe Connect n'est pas terminée.
  try {
    const [userRows] = await db.execute('SELECT status FROM users WHERE id = ?', [req.user.id]);
    if (!userRows.length || userRows[0].status === 'pending_kyc') {
      return res.status(403).json({
        error: "Vérification d'identité requise avant de publier une annonce.",
        kycRequired: true
      });
    }
  } catch (err) {
    console.error('Erreur vérification KYC:', err.message);
    return res.status(500).json({ error: 'Erreur serveur' });
  }

  const { origin, destination, countryFrom, countryTo, zone, departureDate, availableKg, pricePerKg, type, description, pickupMode, pickupCities } = req.body;
  if (!origin || !destination || !departureDate || !availableKg || !pricePerKg) {
    return res.status(400).json({ error: 'Champs obligatoires manquants' });
  }
  try {
    const id = require('crypto').randomUUID();
    const { mode, cities } = normalizePickup(pickupMode, pickupCities, origin);
    await db.execute(`
      INSERT INTO listings (id, carrier_id, origin, destination, country_from, country_to, zone, departure_date, available_kg, price_per_kg, type, description, pickup_mode, pickup_cities)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [id, req.user.id, origin, destination, countryFrom||null, countryTo||null, zone||'af', departureDate, parseFloat(availableKg), parseFloat(pricePerKg), type||'air', description||null, mode, JSON.stringify(cities)]);

    const [rows] = await db.execute('SELECT * FROM listings WHERE id = ?', [id]);
    res.status(201).json({ success: true, listing: rows[0] });
  } catch (err) {
    console.error('Erreur create listing:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── PATCH /api/listings/:id ──────────────────
router.patch('/:id', auth, async (req, res) => {
  const { origin, destination, departureDate, type, availableKg, pricePerKg, description, status, pickupMode, pickupCities } = req.body;
  try {
    const [rows] = await db.execute(
      'SELECT * FROM listings WHERE id = ? AND carrier_id = ?',
      [req.params.id, req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Annonce introuvable ou non autorisé' });
    const listing = rows[0];

    let refundedBookings = 0;

    // Si mise en pause → rembourser les réservations paid
    if (status && status === 'inactive' && listing.status === 'active') {
      refundedBookings += await refundListingBookings(req.params.id, 'listing_paused');
    }

    // Si le prix augmente de plus de 20% → rembourser les réservations paid
    if (pricePerKg && parseFloat(pricePerKg) > parseFloat(listing.price_per_kg) * 1.2) {
      refundedBookings += await refundListingBookings(req.params.id, 'price_increase');
    }

    const updates = [];
    const params  = [];

    if (origin        !== undefined) { updates.push('origin = ?');        params.push(origin); }
    if (destination   !== undefined) { updates.push('destination = ?');   params.push(destination); }
    if (departureDate !== undefined) { updates.push('departure_date = ?');params.push(departureDate); }
    if (type          !== undefined) { updates.push('type = ?');          params.push(type); }
    if (availableKg   !== undefined) { updates.push('available_kg = ?');  params.push(parseFloat(availableKg)); }
    if (pricePerKg    !== undefined) { updates.push('price_per_kg = ?');  params.push(parseFloat(pricePerKg)); }
    if (description   !== undefined) { updates.push('description = ?');   params.push(description); }
    if (status        !== undefined) { updates.push('status = ?');        params.push(status); }

    if (pickupMode !== undefined || pickupCities !== undefined) {
      const effectiveOrigin = origin !== undefined ? origin : listing.origin;
      const { mode, cities } = normalizePickup(pickupMode, pickupCities, effectiveOrigin);
      updates.push('pickup_mode = ?');   params.push(mode);
      updates.push('pickup_cities = ?'); params.push(JSON.stringify(cities));
    }

    if (!updates.length) return res.status(400).json({ error: 'Aucune donnée à mettre à jour' });

    params.push(req.params.id);
    await db.execute(`UPDATE listings SET ${updates.join(', ')} WHERE id = ?`, params);
    const [updated] = await db.execute('SELECT * FROM listings WHERE id = ?', [req.params.id]);
    res.json({ success: true, listing: updated[0], refundedBookings });
  } catch (err) {
    console.error('Erreur patch listing:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── DELETE /api/listings/:id ─────────────────
router.delete('/:id', auth, async (req, res) => {
  try {
    const [rows] = await db.execute(
      'SELECT * FROM listings WHERE id = ? AND carrier_id = ?',
      [req.params.id, req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Non autorisé' });

    const refundCount = await refundListingBookings(req.params.id, 'listing_deleted');
    await db.execute("UPDATE listings SET status = 'cancelled' WHERE id = ?", [req.params.id]);
    res.json({ success: true, refundedBookings: refundCount });
  } catch (err) {
    console.error('Erreur delete listing:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;
