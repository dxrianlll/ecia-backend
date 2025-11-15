// ECIA Backend - OAuth Shopify + Auto-configuration
// À déployer sur Vercel

const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Configuration
const SHOPIFY_API_KEY = process.env.SHOPIFY_API_KEY;
const SHOPIFY_API_SECRET = process.env.SHOPIFY_API_SECRET;
const APP_URL = process.env.APP_URL || 'https://your-app.vercel.app';
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const N8N_WEBHOOK_BASE = process.env.N8N_WEBHOOK_BASE || 'https://trackix.app.n8n.cloud/webhook';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ============================================
// 1. INSTALLATION SHOPIFY (OAuth Start)
// ============================================
app.get('/api/shopify/install', (req, res) => {
  const { shop } = req.query;

  if (!shop) {
    return res.status(400).send('Missing shop parameter');
  }

  const shopName = shop.replace('.myshopify.com', '');
  const shopDomain = `${shopName}.myshopify.com`;

  const scopes = 'read_orders,write_orders,read_customers,read_checkouts';
  const redirectUri = `${APP_URL}/api/shopify/callback`;
  const nonce = crypto.randomBytes(16).toString('hex');

  // Stocker le nonce en session (ou en DB)
  // Pour simplifier, on le met dans l'URL (pas recommandé en prod)

  const installUrl = `https://${shopDomain}/admin/oauth/authorize?client_id=${SHOPIFY_API_KEY}&scope=${scopes}&redirect_uri=${redirectUri}&state=${nonce}`;

  res.redirect(installUrl);
});

// ============================================
// 2. CALLBACK SHOPIFY (OAuth Complete)
// ============================================
app.get('/api/shopify/callback', async (req, res) => {
  const { shop, code, state } = req.query;

  if (!shop || !code) {
    return res.status(400).send('Missing parameters');
  }

  // TODO: Vérifier le state (nonce) en production

  // Échanger le code contre un access token
  try {
    const tokenResponse = await axios.post(
      `https://${shop}/admin/oauth/access_token`,
      {
        client_id: SHOPIFY_API_KEY,
        client_secret: SHOPIFY_API_SECRET,
        code: code
      }
    );

    const accessToken = tokenResponse.data.access_token;

    // Sauvegarder dans Supabase
    const { data, error } = await supabase
      .from('shopify_stores')
      .upsert({
        shop_domain: shop,
        access_token: accessToken,
        installed_at: new Date().toISOString()
      }, {
        onConflict: 'shop_domain'
      });

    if (error) {
      console.error('Supabase error:', error);
      return res.status(500).send('Database error');
    }

    // Créer les webhooks automatiquement
    await createShopifyWebhooks(shop, accessToken);

    // Rediriger vers la page de configuration branding
    res.redirect(`${APP_URL}/onboarding/branding?shop=${shop}&success=true`);

  } catch (error) {
    console.error('OAuth error:', error.response?.data || error.message);
    res.status(500).send('Authentication failed');
  }
});

// ============================================
// 3. CRÉATION AUTOMATIQUE DES WEBHOOKS
// ============================================
async function createShopifyWebhooks(shop, accessToken) {
  const webhooks = [
    {
      topic: 'checkouts/create',
      address: `${N8N_WEBHOOK_BASE}/shopify-cart-abandoned`,
      format: 'json'
    },
    {
      topic: 'orders/create',
      address: `${N8N_WEBHOOK_BASE}/shopify-order-created`,
      format: 'json'
    }
  ];

  for (const webhook of webhooks) {
    try {
      await axios.post(
        `https://${shop}/admin/api/2024-01/webhooks.json`,
        { webhook },
        {
          headers: {
            'X-Shopify-Access-Token': accessToken,
            'Content-Type': 'application/json'
          }
        }
      );
      console.log(`✅ Webhook created: ${webhook.topic}`);
    } catch (error) {
      console.error(`❌ Webhook error: ${webhook.topic}`, error.response?.data);
    }
  }
}

// ============================================
// 4. SAUVEGARDER CONFIG BRANDING
// ============================================
app.post('/api/save-branding', async (req, res) => {
  const { shop, sender_name, sender_email, primary_color, secondary_color, logo_url } = req.body;

  if (!shop) {
    return res.status(400).json({ error: 'Missing shop parameter' });
  }

  try {
    const { data, error } = await supabase
      .from('client_configs')
      .upsert({
        shop_domain: shop,
        sender_name,
        sender_email,
        primary_color,
        secondary_color,
        logo_url,
        updated_at: new Date().toISOString()
      }, {
        onConflict: 'shop_domain'
      });

    if (error) throw error;

    res.json({ success: true, message: 'Configuration saved' });
  } catch (error) {
    console.error('Save branding error:', error);
    res.status(500).json({ error: 'Failed to save configuration' });
  }
});

// ============================================
// 5. VÉRIFIER STATUT D'INSTALLATION
// ============================================
app.get('/api/shopify/status', async (req, res) => {
  const { shop } = req.query;

  if (!shop) {
    return res.status(400).json({ error: 'Missing shop parameter' });
  }

  try {
    const { data, error } = await supabase
      .from('shopify_stores')
      .select('*')
      .eq('shop_domain', shop)
      .single();

    if (error || !data) {
      return res.json({ installed: false });
    }

    res.json({ 
      installed: true, 
      shop_domain: data.shop_domain,
      installed_at: data.installed_at
    });
  } catch (error) {
    res.status(500).json({ error: 'Database error' });
  }
});

// ============================================
// 6. WEBHOOK GDPR (Obligatoire Shopify)
// ============================================
app.post('/api/webhooks/gdpr/customers-data-request', (req, res) => {
  // Log la requête GDPR
  console.log('GDPR Data Request:', req.body);
  res.status(200).send('OK');
});

app.post('/api/webhooks/gdpr/customers-redact', async (req, res) => {
  const { shop_domain, customer } = req.body;
  
  // Supprimer les données client de Supabase
  await supabase
    .from('abandoned_carts')
    .delete()
    .eq('shop_domain', shop_domain)
    .eq('email', customer.email);

  console.log('GDPR Customer Redacted:', customer.email);
  res.status(200).send('OK');
});

app.post('/api/webhooks/gdpr/shop-redact', async (req, res) => {
  const { shop_domain } = req.body;
  
  // Supprimer toutes les données de la boutique
  await supabase
    .from('shopify_stores')
    .delete()
    .eq('shop_domain', shop_domain);

  await supabase
    .from('client_configs')
    .delete()
    .eq('shop_domain', shop_domain);

  console.log('GDPR Shop Redacted:', shop_domain);
  res.status(200).send('OK');
});

// ============================================
// 7. HEALTH CHECK
// ============================================
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    env: {
      hasShopifyKey: !!SHOPIFY_API_KEY,
      hasSupabase: !!SUPABASE_URL
    }
  });
});

// Route par défaut
app.get('/', (req, res) => {
  res.send('ECIA Backend - Shopify Integration');
});

// Export pour Vercel
module.exports = app;

// Pour développement local
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
  });
}
