// services/stripe.js
require('dotenv').config();
const Stripe = require('stripe');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || 'sk_test_demo', {
  apiVersion: '2024-06-20',
  appInfo: { name: 'HapyLogistic', version: '1.0.0' }
});

function calculateFees(baseAmount) {
  const clientFee    = Math.round(baseAmount * 0.08 * 100) / 100;
  const carrierFee   = Math.round(baseAmount * 0.07 * 100) / 100;
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
