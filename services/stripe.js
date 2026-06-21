// services/stripe.js
require('dotenv').config();
const Stripe = require('stripe');
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || 'sk_test_demo', {
  apiVersion: '2024-06-20',
  appInfo: { name: 'HapyLogistic', version: '1.0.0' }
});

// ── Calcul des frais ──────────────────────────────────────────
// Structure :
//   clientFee  = base × 8% + 0.25€   (frais de service + compensation frais carte Stripe ~1.5%+0.25€)
//   carrierFee = base × 9%            (commission HapyLogistic sur le transporteur)
//   clientTotal = base + clientFee    (payé par le client)
//   carrierNet  = base − carrierFee   (reçu net par le transporteur, jamais affecté par Stripe)
//   platformFee = clientFee + carrierFee (commission HapyLogistic visée, avant frais Stripe)
//
// Net réel HapyLogistic après frais Stripe ≈ 15% de la base, stable sur tous les montants.
// Le montant fixe de 0.25€ protège la marge sur les petites transactions.
function calculateFees(baseAmount) {
  const clientFee    = Math.round((baseAmount * 0.08 + 0.25) * 100) / 100;
  const carrierFee   = Math.round(baseAmount * 0.09 * 100) / 100;
  const clientTotal  = baseAmount + clientFee;
  const carrierNet   = baseAmount - carrierFee;
  const platformFee  = clientFee + carrierFee;
  return {
    base:         Math.round(baseAmount * 100),
    clientFee:    Math.round(clientFee * 100),
    carrierFee:   Math.round(carrierFee * 100),
    clientTotal:  Math.round(clientTotal * 100),
    carrierNet:   Math.round(carrierNet * 100),
    platformFee:  Math.round(platformFee * 100),
  };
}

module.exports = { stripe, calculateFees };
