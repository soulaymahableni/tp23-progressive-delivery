// TP23 - Partie 5 : Feature Flags avec OpenFeature + flagd
const express = require('express');
const { OpenFeature } = require('@openfeature/server-sdk');
const { FlagdProvider } = require('@openfeature/flagd-provider');

// TODO 1 (fait) : provider flagd - l'application interroge flagd (gRPC, port 8013)
OpenFeature.setProvider(new FlagdProvider({
  host: process.env.FLAGD_HOST || 'flagd',
  port: Number(process.env.FLAGD_PORT || 8013),
}));
const client = OpenFeature.getClient('feature-app');

const app = express();

app.get('/', async (req, res) => {
  const user = String(req.query.user || 'anonyme');
  // TODO 2 (fait) : évaluer le flag new-checkout pour CET utilisateur (targetingKey)
  const details = await client.getBooleanDetails('new-checkout', false, { targetingKey: user });
  res.json({
    user,
    newCheckout: details.value,
    checkout: details.value ? 'NOUVEAU tunnel de paiement (1 page)' : 'ancien tunnel de paiement (3 pages)',
    variant: details.variant,
    reason: details.reason,
  });
});

app.listen(3001, () => console.log('feature-app sur le port 3001'));
