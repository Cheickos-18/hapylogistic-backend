// routes/auth.js — Inscription & Connexion
const express  = require('express');
const router   = express.Router();
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const db       = require('../config/database');
const { stripe } = require('../services/stripe');

function generateToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );
}

// ── POST /api/auth/register ──────────────────
router.post('/register', async (req, res) => {
  const { firstName, lastName, email, password, phone, role, country, carrierType, destination } = req.body;

  if (!firstName || !lastName || !email || !password || !role) {
    return res.status(400).json({ error: 'Champs obligatoires manquants' });
  }
  if (!['client', 'carrier'].includes(role)) {
    return res.status(400).json({ error: 'Rôle invalide' });
  }

  try {
    // Vérifier email unique
    const [existing] = await db.execute('SELECT id FROM users WHERE email = ?', [email]);
    if (existing.length > 0) {
      return res.status(409).json({ error: 'Un compte avec cet email existe déjà' });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    // Créer compte Stripe
    let stripeCustomerId = null;
    let stripeAccountId  = null;
    let onboardingUrl    = null;

    try {
      if (role === 'client') {
        const customer = await stripe.customers.create({
          email, name: `${firstName} ${lastName}`, phone,
          metadata: { role, country: country || '' }
        });
        stripeCustomerId = customer.id;
      } else {
        const account = await stripe.accounts.create({
          type: 'express', country: 'FR', email,
          capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
          business_type: 'individual',
          individual: { first_name: firstName, last_name: lastName, email, phone },
          metadata: { role, carrierType: carrierType || 'air' }
        });
        stripeAccountId = account.id;

        const accountLink = await stripe.accountLinks.create({
          account: account.id,
          refresh_url: `${process.env.FRONTEND_URL}/pages/register.html`,
          return_url:  `${process.env.FRONTEND_URL}/pages/dashboard-carrier.html`,
          type: 'account_onboarding'
        });
        onboardingUrl = accountLink.url;
      }
    } catch (stripeErr) {
      console.warn('Stripe warning:', stripeErr.message);
    }

    // Insérer en base
    const userId = require('crypto').randomUUID();
    await db.execute(`
      INSERT INTO users
        (id, first_name, last_name, email, password_hash, phone, role, country,
         carrier_type, stripe_customer_id, stripe_account_id, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      userId, firstName, lastName, email, passwordHash,
      phone || null, role, country || null,
      role === 'carrier' ? (carrierType || 'air') : null,
      stripeCustomerId, stripeAccountId,
      role === 'carrier' ? 'pending_kyc' : 'active'
    ]);

    const [rows] = await db.execute('SELECT * FROM users WHERE id = ?', [userId]);
    const user = rows[0];
    const token = generateToken(user);

    res.status(201).json({
      success: true,
      token,
      user: {
        id: user.id, firstName: user.first_name, lastName: user.last_name,
        email: user.email, role: user.role, status: user.status,
        level: user.carrier_level || null,
      },
      onboardingUrl: onboardingUrl || null,
      message: role === 'client'
        ? 'Compte client créé avec succès'
        : 'Compte transporteur créé. Complétez votre KYC via le lien fourni.'
    });

  } catch (err) {
    console.error('Erreur register:', err.message);
    res.status(500).json({ error: 'Erreur lors de la création du compte' });
  }
});

// ── POST /api/auth/login ─────────────────────
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email et mot de passe requis' });
  }

  try {
    const [rows] = await db.execute('SELECT * FROM users WHERE email = ?', [email]);
    if (!rows.length) {
      return res.status(401).json({ error: 'Email ou mot de passe incorrect' });
    }

    const user = rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Email ou mot de passe incorrect' });
    }

    const token = generateToken(user);
    res.json({
      success: true,
      token,
      user: {
        id: user.id, firstName: user.first_name, lastName: user.last_name,
        email: user.email, role: user.role, status: user.status,
        level: user.carrier_level, totalTrips: user.total_trips,
        rating: parseFloat(user.average_rating) || 0,
        country: user.country,
      }
    });

  } catch (err) {
    console.error('Erreur login:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── GET /api/auth/me ─────────────────────────
router.get('/me', require('../middleware/auth'), async (req, res) => {
  try {
    const [rows] = await db.execute(
      'SELECT id, first_name, last_name, email, phone, role, country, status, carrier_level, carrier_type, total_trips, average_rating FROM users WHERE id = ?',
      [req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Utilisateur introuvable' });
    const u = rows[0];
    res.json({
      id: u.id, firstName: u.first_name, lastName: u.last_name,
      email: u.email, phone: u.phone, role: u.role, country: u.country,
      status: u.status, level: u.carrier_level, carrierType: u.carrier_type,
      totalTrips: u.total_trips, rating: parseFloat(u.average_rating) || 0,
    });
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;
