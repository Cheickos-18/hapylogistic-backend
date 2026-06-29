// routes/auth.js — Inscription & Connexion
const express  = require('express');
const router   = express.Router();
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const db       = require('../config/database');
const { stripe } = require('../services/stripe');
const { Resend } = require('resend');
const resend = new Resend(process.env.RESEND_API_KEY);

// ── Normalisation téléphone → format E.164 (requis par Stripe) ──
function normalizePhone(phone) {
  if (!phone) return phone;
  let p = String(phone).trim().replace(/[\s\-\.\(\)]/g, '');
  // 0XXXXXXXXX → +33XXXXXXXXX (France)
  if (/^0[1-9]\d{8}$/.test(p)) return '+33' + p.slice(1);
  // 33XXXXXXXXX → +33XXXXXXXXX
  if (/^33[1-9]\d{8}$/.test(p)) return '+' + p;
  // Déjà au format +XX... → ok
  if (p.startsWith('+')) return p;
  return p;
}

// ── Templates email ──────────────────────────────────────────
function emailWelcomeClient(firstName) {
  return {
    subject: '🎉 Bienvenue sur HapyLogistic !',
    html: `<!DOCTYPE html>
<html lang="fr">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f6f9;font-family:'Segoe UI',Arial,sans-serif">
  <div style="max-width:600px;margin:32px auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08)">
    <!-- Header -->
    <div style="background:linear-gradient(135deg,#1a1aff,#4f46e5);padding:40px 32px;text-align:center">
      <div style="font-size:32px;font-weight:900;color:#fff;letter-spacing:-1px">Hapy<span style="color:#ffd700">Logistic</span></div>
      <div style="color:rgba(255,255,255,.8);margin-top:8px;font-size:14px">Envoyez partout. Livrez le monde.</div>
    </div>
    <!-- Body -->
    <div style="padding:40px 32px">
      <h1 style="margin:0 0 12px;font-size:24px;color:#1a1a2e">Bonjour ${firstName} 👋</h1>
      <p style="color:#555;line-height:1.7;margin:0 0 24px">Bienvenue sur HapyLogistic ! Votre compte client est maintenant actif. Vous pouvez dès maintenant envoyer vos colis partout dans le monde via nos transporteurs communautaires vérifiés.</p>
      <!-- Comment ça marche -->
      <div style="background:#f8f9ff;border-radius:12px;padding:24px;margin-bottom:24px">
        <div style="font-weight:700;color:#1a1a2e;margin-bottom:16px;font-size:16px">📦 Comment envoyer un colis ?</div>
        <div style="display:flex;flex-direction:column;gap:12px">
          <div style="display:flex;gap:12px;align-items:flex-start">
            <div style="background:#4f46e5;color:#fff;border-radius:50%;width:28px;height:28px;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:13px;flex-shrink:0">1</div>
            <div><strong style="color:#1a1a2e">Trouvez un transporteur</strong><br><span style="color:#666;font-size:14px">Parcourez les transporteurs qui se rendent à votre destination et choisissez celui qui correspond à vos besoins.</span></div>
          </div>
          <div style="display:flex;gap:12px;align-items:flex-start">
            <div style="background:#4f46e5;color:#fff;border-radius:50%;width:28px;height:28px;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:13px;flex-shrink:0">2</div>
            <div><strong style="color:#1a1a2e">Payez en toute sécurité</strong><br><span style="color:#666;font-size:14px">Votre paiement est sécurisé par <strong>Stripe Escrow</strong> — l'argent est bloqué et ne sera versé au transporteur qu'après confirmation de livraison.</span></div>
          </div>
          <div style="display:flex;gap:12px;align-items:flex-start">
            <div style="background:#4f46e5;color:#fff;border-radius:50%;width:28px;height:28px;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:13px;flex-shrink:0">3</div>
            <div><strong style="color:#1a1a2e">Confirmez la livraison</strong><br><span style="color:#666;font-size:14px">Quand vous recevez votre colis, confirmez la livraison dans l'application. Le transporteur reçoit son paiement.</span></div>
          </div>
        </div>
      </div>
      <!-- Paiements & Remboursements -->
      <div style="border:2px solid #e8f4fd;border-radius:12px;padding:24px;margin-bottom:24px">
        <div style="font-weight:700;color:#1a1a2e;margin-bottom:16px;font-size:16px">💳 Paiements & Remboursements</div>
        <table style="width:100%;border-collapse:collapse">
          <tr>
            <td style="padding:8px 0;border-bottom:1px solid #f0f0f0;width:50%">
              <span style="color:#4f46e5;font-weight:600">✅ Livraison confirmée</span><br>
              <span style="color:#666;font-size:13px">Le transporteur reçoit son paiement sous 24-48h.</span>
            </td>
          </tr>
          <tr>
            <td style="padding:8px 0;border-bottom:1px solid #f0f0f0">
              <span style="color:#e53e3e;font-weight:600">❌ Colis non reçu</span><br>
              <span style="color:#666;font-size:13px">Ouvrez un litige — remboursement intégral garanti après vérification.</span>
            </td>
          </tr>
          <tr>
            <td style="padding:8px 0;border-bottom:1px solid #f0f0f0">
              <span style="color:#d97706;font-weight:600">⚠️ Colis endommagé</span><br>
              <span style="color:#666;font-size:13px">Litige avec photos à l'appui — remboursement partiel ou total selon le cas.</span>
            </td>
          </tr>
          <tr>
            <td style="padding:8px 0">
              <span style="color:#7c3aed;font-weight:600">🚫 Annulation avant collecte</span><br>
              <span style="color:#666;font-size:13px">Remboursement intégral dans les 24h.</span>
            </td>
          </tr>
        </table>
      </div>
      <!-- CTA -->
      <div style="text-align:center;margin-top:32px">
        <a href="${process.env.FRONTEND_URL}/pages/listings.html" style="display:inline-block;background:linear-gradient(135deg,#1a1aff,#4f46e5);color:#fff;text-decoration:none;padding:14px 36px;border-radius:50px;font-weight:700;font-size:16px">
          Trouver un transporteur →
        </a>
      </div>
    </div>
    <!-- Footer -->
    <div style="background:#f8f9ff;padding:24px 32px;text-align:center;border-top:1px solid #e8e8f0">
      <p style="margin:0;color:#888;font-size:13px">Une question ? Répondez à cet email ou contactez <a href="mailto:contact@hapylogistic.com" style="color:#4f46e5">contact@hapylogistic.com</a></p>
      <p style="margin:8px 0 0;color:#aaa;font-size:12px">© 2026 HapyLogistic — Envoyez partout, livrez le monde</p>
    </div>
  </div>
</body>
</html>`
  };
}
function emailWelcomeCarrier(firstName) {
  return {
    subject: '✈️ Bienvenue transporteur HapyLogistic !',
    html: `<!DOCTYPE html>
<html lang="fr">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f6f9;font-family:'Segoe UI',Arial,sans-serif">
  <div style="max-width:600px;margin:32px auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08)">
    <!-- Header -->
    <div style="background:linear-gradient(135deg,#1a1aff,#4f46e5);padding:40px 32px;text-align:center">
      <div style="font-size:32px;font-weight:900;color:#fff;letter-spacing:-1px">Hapy<span style="color:#ffd700">Logistic</span></div>
      <div style="color:rgba(255,255,255,.8);margin-top:8px;font-size:14px">Gagnez de l'argent à chaque trajet</div>
    </div>
    <!-- Body -->
    <div style="padding:40px 32px">
      <h1 style="margin:0 0 12px;font-size:24px;color:#1a1a2e">Bienvenue ${firstName} ✈️</h1>
      <p style="color:#555;line-height:1.7;margin:0 0 24px">Félicitations, votre compte transporteur est créé ! Vous pouvez maintenant rentabiliser vos voyages en transportant des colis pour d'autres membres de la communauté.</p>
      <!-- Étapes pour commencer -->
      <div style="background:#f8f9ff;border-radius:12px;padding:24px;margin-bottom:24px">
        <div style="font-weight:700;color:#1a1a2e;margin-bottom:16px;font-size:16px">🚀 Pour commencer à gagner</div>
        <div style="display:flex;flex-direction:column;gap:12px">
          <div style="display:flex;gap:12px;align-items:flex-start">
            <div style="background:#059669;color:#fff;border-radius:50%;width:28px;height:28px;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:13px;flex-shrink:0">1</div>
            <div><strong style="color:#1a1a2e">Complétez votre KYC</strong><br><span style="color:#666;font-size:14px">Vérifiez votre identité via Stripe Identity (pièce d'identité + selfie). Obligatoire pour publier des annonces.</span></div>
          </div>
          <div style="display:flex;gap:12px;align-items:flex-start">
            <div style="background:#059669;color:#fff;border-radius:50%;width:28px;height:28px;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:13px;flex-shrink:0">2</div>
            <div><strong style="color:#1a1a2e">Publiez une annonce</strong><br><span style="color:#666;font-size:14px">Indiquez votre trajet, les dates, la capacité disponible (kg) et votre prix au kilo.</span></div>
          </div>
          <div style="display:flex;gap:12px;align-items:flex-start">
            <div style="background:#059669;color:#fff;border-radius:50%;width:28px;height:28px;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:13px;flex-shrink:0">3</div>
            <div><strong style="color:#1a1a2e">Recevez des réservations</strong><br><span style="color:#666;font-size:14px">Les clients réservent et paient à l'avance. Vous êtes notifié immédiatement.</span></div>
          </div>
          <div style="display:flex;gap:12px;align-items:flex-start">
            <div style="background:#059669;color:#fff;border-radius:50%;width:28px;height:28px;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:13px;flex-shrink:0">4</div>
            <div><strong style="color:#1a1a2e">Livrez & soyez payé</strong><br><span style="color:#666;font-size:14px">Après confirmation de livraison, votre paiement est versé automatiquement sous 24-48h.</span></div>
          </div>
        </div>
      </div>
      <!-- Commission & Paiements -->
      <div style="border:2px solid #d1fae5;border-radius:12px;padding:24px;margin-bottom:24px">
        <div style="font-weight:700;color:#1a1a2e;margin-bottom:16px;font-size:16px">💰 Commission & Paiements</div>
        <table style="width:100%;border-collapse:collapse">
          <tr>
            <td style="padding:8px 0;border-bottom:1px solid #f0f0f0">
              <span style="color:#059669;font-weight:600">✅ Commission fixe : 9%</span><br>
              <span style="color:#666;font-size:13px">Prélevée automatiquement sur chaque transaction. Pas d'abonnement, pas de frais cachés.</span>
            </td>
          </tr>
          <tr>
            <td style="padding:8px 0;border-bottom:1px solid #f0f0f0">
              <span style="color:#4f46e5;font-weight:600">⏱️ Délai de paiement</span><br>
              <span style="color:#666;font-size:13px">Votre argent est versé 24-48h après confirmation de livraison par le client.</span>
            </td>
          </tr>
          <tr>
            <td style="padding:8px 0;border-bottom:1px solid #f0f0f0">
              <span style="color:#d97706;font-weight:600">❌ Annulation avant collecte</span><br>
              <span style="color:#666;font-size:13px">Le client est remboursé intégralement. Pas de pénalité pour vous si annulation dans les délais.</span>
            </td>
          </tr>
          <tr>
            <td style="padding:8px 0">
              <span style="color:#e53e3e;font-weight:600">⚖️ En cas de litige</span><br>
              <span style="color:#666;font-size:13px">L'équipe HapyLogistic examine chaque litige. Répondez rapidement dans l'application pour accélérer la résolution.</span>
            </td>
          </tr>
        </table>
      </div>
      <!-- Niveaux -->
      <div style="background:#fffbeb;border:2px solid #fcd34d;border-radius:12px;padding:20px;margin-bottom:24px">
        <div style="font-weight:700;color:#1a1a2e;margin-bottom:12px">🏆 Système de niveaux</div>
        <div style="font-size:13px;color:#666;line-height:1.8">
          🥉 <strong>Bronze</strong> — Débutant (0-4 trajets)<br>
          🥈 <strong>Argent</strong> — Confirmé (5-19 trajets, note ≥ 4.0)<br>
          🥇 <strong>Or</strong> — Expert (20+ trajets, note ≥ 4.5)<br>
          <span style="color:#888;font-size:12px;margin-top:4px;display:block">Les niveaux supérieurs augmentent votre visibilité dans les recherches.</span>
        </div>
      </div>
      <!-- CTA -->
      <div style="text-align:center;margin-top:32px">
        <a href="${process.env.FRONTEND_URL}/pages/dashboard-carrier.html" style="display:inline-block;background:linear-gradient(135deg,#059669,#10b981);color:#fff;text-decoration:none;padding:14px 36px;border-radius:50px;font-weight:700;font-size:16px">
          Accéder à mon tableau de bord →
        </a>
      </div>
    </div>
    <!-- Footer -->
    <div style="background:#f8f9ff;padding:24px 32px;text-align:center;border-top:1px solid #e8e8f0">
      <p style="margin:0;color:#888;font-size:13px">Une question ? Répondez à cet email ou contactez <a href="mailto:contact@hapylogistic.com" style="color:#4f46e5">contact@hapylogistic.com</a></p>
      <p style="margin:8px 0 0;color:#aaa;font-size:12px">© 2026 HapyLogistic — Gagnez de l'argent à chaque trajet</p>
    </div>
  </div>
</body>
</html>`
  };
}

function generateToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );
}

// ── POST /api/auth/register ──────────────────
router.post('/register', async (req, res) => {
  const { firstName, lastName, email, password, role, country, carrierType, destination, carrierAccountType, companyName } = req.body;
  // Normaliser le téléphone en E.164 dès la réception
  const phone = normalizePhone(req.body.phone);

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
        const accountType = ['individual', 'company'].includes(carrierAccountType)
          ? carrierAccountType
          : 'individual';
        const stripeAccountParams = {
          type: 'express', country: 'FR', email,
          capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
          business_type: accountType,
          metadata: { role, carrierType: carrierType || 'air', accountType }
        };
        if (accountType === 'individual') {
          stripeAccountParams.individual = { first_name: firstName, last_name: lastName, email, phone };
        } else {
          stripeAccountParams.company    = { name: companyName || `${firstName} ${lastName}` };
          stripeAccountParams.individual = { first_name: firstName, last_name: lastName, email, phone };
        }
        const account = await stripe.accounts.create(stripeAccountParams);
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
      if (role === 'carrier') {
        console.error('Stripe account creation failed for carrier:', stripeErr.message);
        // Retourner un message lisible selon le type d'erreur Stripe
        let userMessage = 'Impossible de créer votre compte de paiement Stripe. Vérifiez votre connexion et réessayez.';
        if (stripeErr.message && stripeErr.message.includes('not a valid phone number')) {
          userMessage = 'Numéro de téléphone invalide. Utilisez le format international (+33 7 XX XX XX XX).';
        } else if (stripeErr.message && stripeErr.message.includes('email')) {
          userMessage = 'Adresse email invalide ou déjà utilisée sur Stripe.';
        }
        return res.status(502).json({ error: userMessage, stripeError: true });
      }
      console.warn('Stripe customer creation failed (non-blocking):', stripeErr.message);
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
    // Envoi email de bienvenue
    try {
      const template = role === 'client'
        ? emailWelcomeClient(firstName)
        : emailWelcomeCarrier(firstName);
      await resend.emails.send({
        from: 'HapyLogistic <contact@hapylogistic.com>',
        to:   email,
        subject: template.subject,
        html: template.html,
      });
    } catch (emailErr) {
      console.warn('Email bienvenue non envoyé:', emailErr.message);
    }
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
      'SELECT id, first_name, last_name, email, phone, role, country, status, carrier_level, carrier_type, total_trips, average_rating, stripe_account_id FROM users WHERE id = ?',
      [req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Utilisateur introuvable' });
    let u = rows[0];

    // ── Auto-sync KYC : si pending_kyc mais Stripe dit charges_enabled → activer ──
    // Couvre le cas où Stripe active le compte sans envoyer le webhook account.updated
    if (u.role === 'carrier' && u.status === 'pending_kyc' && u.stripe_account_id) {
      try {
        const stripeAccount = await stripe.accounts.retrieve(u.stripe_account_id);
        if (stripeAccount.details_submitted && stripeAccount.charges_enabled) {
          await db.execute(
            "UPDATE users SET status = 'active' WHERE id = ?",
            [u.id]
          );
          u.status = 'active';
          console.log(`✅ [AutoSync] KYC activé automatiquement pour ${u.id} (${u.stripe_account_id})`);
        }
      } catch (stripeErr) {
        // Non bloquant — on retourne quand même les infos utilisateur
        console.warn('[AutoSync] Impossible de vérifier le statut Stripe:', stripeErr.message);
      }
    }

    // Récupérer details_submitted depuis Stripe si pending_kyc (après auto-sync)
    let stripeDetailsSubmitted = false;
    if (u.role === 'carrier' && u.status === 'pending_kyc' && u.stripe_account_id) {
      try {
        const acct = await stripe.accounts.retrieve(u.stripe_account_id);
        stripeDetailsSubmitted = !!acct.details_submitted;
      } catch(e) { /* non bloquant */ }
    }

    res.json({
      id: u.id, firstName: u.first_name, lastName: u.last_name,
      email: u.email, phone: u.phone, role: u.role, country: u.country,
      status: u.status, level: u.carrier_level, carrierType: u.carrier_type,
      totalTrips: u.total_trips, rating: parseFloat(u.average_rating) || 0,
      hasStripeAccount: !!u.stripe_account_id,
      stripeDetailsSubmitted,
    });
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── POST /api/auth/onboarding-link ───────────
router.post('/onboarding-link', require('../middleware/auth'), async (req, res) => {
  try {
    const [rows] = await db.execute(
      'SELECT role, status, stripe_account_id FROM users WHERE id = ?',
      [req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Utilisateur introuvable' });
    const u = rows[0];
    if (u.role !== 'carrier') {
      return res.status(403).json({ error: 'Réservé aux transporteurs' });
    }
    if (!u.stripe_account_id) {
      return res.status(400).json({ error: 'Aucun compte Stripe associé à ce profil' });
    }
    const accountLink = await stripe.accountLinks.create({
      account: u.stripe_account_id,
      refresh_url: `${process.env.FRONTEND_URL}/pages/dashboard-carrier.html`,
      return_url:  `${process.env.FRONTEND_URL}/pages/dashboard-carrier.html`,
      type: 'account_onboarding'
    });
    res.json({ url: accountLink.url });
  } catch (err) {
    console.error('Erreur onboarding-link:', err.message);
    res.status(500).json({ error: 'Impossible de générer le lien de vérification' });
  }
});

// ── POST /api/auth/create-stripe-account ─────
router.post('/create-stripe-account', require('../middleware/auth'), async (req, res) => {
  try {
    const [rows] = await db.execute(
      'SELECT role, status, stripe_account_id, first_name, last_name, email, phone FROM users WHERE id = ?',
      [req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Utilisateur introuvable' });
    const u = rows[0];
    if (u.role !== 'carrier') {
      return res.status(403).json({ error: 'Réservé aux transporteurs' });
    }
    // Si le compte Stripe existe déjà, générer juste un nouveau lien KYC
    if (u.stripe_account_id) {
      const accountLink = await stripe.accountLinks.create({
        account: u.stripe_account_id,
        refresh_url: `${process.env.FRONTEND_URL}/pages/dashboard-carrier.html`,
        return_url:  `${process.env.FRONTEND_URL}/pages/dashboard-carrier.html`,
        type: 'account_onboarding'
      });
      return res.json({ url: accountLink.url });
    }
    // Normaliser le téléphone stocké en base
    const phone = normalizePhone(u.phone);
    const account = await stripe.accounts.create({
      type: 'express',
      country: 'FR',
      email: u.email,
      capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
      business_type: 'individual',
      individual: {
        first_name: u.first_name,
        last_name:  u.last_name,
        email:      u.email,
        phone:      phone,
      },
      metadata: { userId: req.user.id, role: 'carrier' }
    });
    await db.execute(
      'UPDATE users SET stripe_account_id = ? WHERE id = ?',
      [account.id, req.user.id]
    );
    const accountLink = await stripe.accountLinks.create({
      account: account.id,
      refresh_url: `${process.env.FRONTEND_URL}/pages/dashboard-carrier.html`,
      return_url:  `${process.env.FRONTEND_URL}/pages/dashboard-carrier.html`,
      type: 'account_onboarding'
    });
    res.json({ url: accountLink.url });
  } catch (err) {
    console.error('Erreur create-stripe-account:', err.message);
    let userMessage = 'Une erreur est survenue. Réessayez dans quelques instants.';
    if (err.message && err.message.includes('signed up for Connect')) {
      userMessage = 'La plateforme de paiement n\'est pas encore configurée. Contactez le support : contact@hapylogistic.com';
    } else if (err.message && err.message.includes('not a valid phone number')) {
      userMessage = 'Numéro de téléphone invalide. Mettez-le à jour dans votre profil au format international (+33 7 XX XX XX XX).';
    } else if (err.message && err.message.includes('email')) {
      userMessage = 'Votre adresse email est invalide ou déjà utilisée sur Stripe.';
    } else if (err.type === 'StripeConnectionError') {
      userMessage = 'Impossible de contacter Stripe. Vérifiez votre connexion et réessayez.';
    } else if (err.type === 'StripeAuthenticationError') {
      userMessage = 'Erreur de configuration Stripe. Contactez le support : contact@hapylogistic.com';
    }
    res.status(500).json({ error: userMessage });
  }
});

module.exports = router;
