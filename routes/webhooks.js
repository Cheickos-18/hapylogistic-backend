// routes/webhooks.js — Webhooks Stripe
const express = require('express');
const router  = express.Router();
const { stripe } = require('../services/stripe');
const db = require('../config/database');

router.post('/stripe', async (req, res) => {
  const sig    = req.headers['stripe-signature'];
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, secret);
  } catch (err) {
    console.error('Webhook signature invalide:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  console.log(`📨 Webhook: ${event.type}`);

  switch (event.type) {
    case 'payment_intent.amount_capturable_updated': {
      const pi = event.data.object;
      await db.execute(
        'UPDATE bookings SET status = ? WHERE payment_intent_id = ?',
        ['paid', pi.id]
      );
      break;
    }
    case 'payment_intent.succeeded': {
      const pi = event.data.object;
      await db.execute(
        'UPDATE bookings SET status = ? WHERE payment_intent_id = ?',
        ['completed', pi.id]
      );
      break;
    }
    case 'payment_intent.payment_failed': {
      const pi = event.data.object;
      await db.execute(
        'UPDATE bookings SET status = ? WHERE payment_intent_id = ?',
        ['cancelled', pi.id]
      );
      break;
    }
    case 'account.updated': {
      const account = event.data.object;
      if (account.details_submitted && account.charges_enabled) {
        await db.execute(
          'UPDATE users SET status = ? WHERE stripe_account_id = ?',
          ['active', account.id]
        );
        console.log(`✅ KYC complété pour compte Stripe ${account.id}`);
      }
      break;
    }
    case 'charge.dispute.created': {
      console.log(`⚠️ Chargeback détecté: ${event.data.object.id}`);
      break;
    }
    default:
      break;
  }

  res.json({ received: true });
});

module.exports = router;
