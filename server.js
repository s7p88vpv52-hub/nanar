const express = require('express');
const path = require('path');
const bcrypt = require('bcryptjs');
const session = require('express-session');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
require('dotenv').config();

const { createClient } = require('@supabase/supabase-js');
const nodemailer = require('nodemailer');
const Stripe = require('stripe');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
const PORT = process.env.SITE_PORT || 3000;

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY
);

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
});

// ================== WEBHOOK STRIPE (avant express.json) ==================
app.post('/webhook/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const sess = event.data.object;
    const { client_email, type, imeis } = sess.metadata;

    try {
      await supabase.from('payments').update({ statut: 'paid' }).eq('stripe_session_id', sess.id);

      if (type === 'licence') {
        // Licence : en attente activation admin
        console.log('✅ Paiement licence reçu pour:', client_email);
        await envoyerEmailLicenceEnAttente(client_email, sess.amount_total / 100);
      } else {
        // Déblocage : enregistrer IMEI automatiquement
        const imeiList = JSON.parse(imeis || '[]');
        for (const item of imeiList) {
          await supabase.from('imei_registry').insert([{
            imei: item.imei,
            device_model: item.model,
            client_email: client_email,
            is_active: true,
            created_at: new Date().toISOString()
          }]);
        }
        const { data: client } = await supabase.from('accounts')
          .select('prenom').eq('email', client_email).maybeSingle();
        await envoyerEmailImeiAccepte(client_email, client?.prenom || '', imeiList, sess.amount_total / 100);
        console.log('✅ IMEI enregistrés pour:', client_email);
      }
    } catch (e) {
      console.error('Erreur webhook:', e.message);
    }
  }
  res.json({ received: true });
});

app.use(express.json());
app.use(session({
  secret: 'nova-icloud-secret-2026',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 * 7 }
}));
app.use(express.static(path.join(__dirname, 'public')));

// ================== EMAILS ==================
function templateBase(titre, contenu) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
  <body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0a0a0f;">
    <div style="max-width:560px;margin:40px auto;background:#111118;border-radius:16px;border:0.5px solid rgba(255,255,255,0.08);overflow:hidden;">
      <div style="padding:28px 28px 16px;display:flex;align-items:center;gap:10px;">
        <div style="width:38px;height:38px;background:linear-gradient(135deg,#6d28d9,#4c1d95);border-radius:9px;text-align:center;line-height:38px;color:white;font-weight:700;font-size:16px;">N</div>
        <div>
          <div style="font-size:14px;font-weight:600;color:white;">Nova iCloud</div>
          <div style="font-size:11px;color:rgba(255,255,255,0.35);">Déblocage iCloud</div>
        </div>
      </div>
      <div style="padding:8px 28px 28px;">
        <h1 style="font-size:20px;font-weight:600;color:white;margin:0 0 16px;">${titre}</h1>
        ${contenu}
      </div>
      <div style="background:rgba(255,255,255,0.03);border-top:0.5px solid rgba(255,255,255,0.06);padding:18px 28px;text-align:center;">
        <div style="font-size:11px;color:rgba(255,255,255,0.25);margin-bottom:4px;">© 2026 Nova iCloud</div>
        <a href="https://t.me/novaicloud" style="font-size:11px;color:#8b5cf6;text-decoration:none;">Support : @novaicloud</a>
      </div>
    </div>
  </body></html>`;
}

async function envoyerEmailBienvenue(email, prenom, nom) {
  const contenu = `
    <p style="color:rgba(255,255,255,0.65);font-size:14px;line-height:1.6;margin:0 0 16px;">Bonjour <strong style="color:white;">${prenom} ${nom}</strong>,</p>
    <p style="color:rgba(255,255,255,0.65);font-size:14px;line-height:1.6;margin:0 0 20px;">Bienvenue sur <strong style="color:white;">Nova iCloud</strong> ! Votre compte a été créé avec succès.</p>
    <div style="background:rgba(109,40,217,0.1);border:0.5px solid rgba(139,92,246,0.2);border-radius:10px;padding:18px;margin:20px 0;">
      <table style="width:100%;border-collapse:collapse;">
        <tr><td style="padding:5px 0;color:rgba(255,255,255,0.35);font-size:13px;">Nom complet</td><td style="padding:5px 0;color:white;font-size:13px;font-weight:500;text-align:right;">${prenom} ${nom}</td></tr>
        <tr><td style="padding:5px 0;color:rgba(255,255,255,0.35);font-size:13px;">Email</td><td style="padding:5px 0;color:white;font-size:13px;font-weight:500;text-align:right;">${email}</td></tr>
      </table>
    </div>`;
  return transporter.sendMail({
    from: `"Nova iCloud" <${process.env.EMAIL_USER}>`,
    to: email,
    subject: 'Bienvenue sur Nova iCloud',
    html: templateBase('Bienvenue !', contenu)
  });
}

async function envoyerEmailImeiAccepte(email, prenom, imeiList, montant) {
  const lignes = imeiList.map(i => `
    <tr>
      <td style="padding:8px 0;color:rgba(255,255,255,0.35);font-size:13px;">${i.model}</td>
      <td style="padding:8px 0;color:white;font-size:13px;font-weight:500;text-align:right;font-family:monospace;">${i.imei}</td>
    </tr>`).join('');
  const contenu = `
    <p style="color:rgba(255,255,255,0.65);font-size:14px;line-height:1.6;margin:0 0 16px;">Bonjour <strong style="color:white;">${prenom || 'client'}</strong>,</p>
    <p style="color:rgba(255,255,255,0.65);font-size:14px;line-height:1.6;margin:0 0 16px;">Votre paiement de <strong style="color:white;">${montant}€</strong> a été confirmé. Vos appareils sont <strong style="color:#34d399;">enregistrés</strong> et prêts à être débloqués.</p>
    <div style="background:rgba(16,185,129,0.08);border:0.5px solid rgba(52,211,153,0.2);border-radius:10px;padding:18px;margin:20px 0;">
      <div style="font-size:11px;color:rgba(255,255,255,0.35);font-weight:500;margin-bottom:12px;">APPAREILS ENREGISTRÉS</div>
      <table style="width:100%;border-collapse:collapse;">${lignes}</table>
    </div>
    <ol style="color:rgba(255,255,255,0.5);font-size:13px;line-height:1.8;padding-left:20px;margin:0 0 20px;">
      <li>Lancez le logiciel Nova iCloud</li>
      <li>Branchez votre iPhone en USB</li>
      <li>Le statut "<strong style="color:#34d399;">Enregistré</strong>" s'affichera</li>
      <li>Cliquez sur "<strong style="color:white;">Débloquer</strong>"</li>
    </ol>`;
  return transporter.sendMail({
    from: `"Nova iCloud" <${process.env.EMAIL_USER}>`,
    to: email,
    subject: '✅ Paiement confirmé — Vos iPhones sont prêts à être débloqués',
    html: templateBase('Paiement confirmé', contenu)
  });
}

async function envoyerEmailLicenceEnAttente(email, montant) {
  const contenu = `
    <p style="color:rgba(255,255,255,0.65);font-size:14px;line-height:1.6;margin:0 0 16px;">Votre paiement de <strong style="color:white;">${montant}€</strong> pour la <strong style="color:white;">Licence Pro à vie</strong> a bien été reçu.</p>
    <div style="background:rgba(251,191,36,0.08);border:0.5px solid rgba(251,191,36,0.2);border-radius:10px;padding:18px;margin:20px 0;">
      <div style="font-size:13px;color:rgba(255,255,255,0.65);">⏳ Votre licence sera activée manuellement dans les prochaines heures. Vous recevrez une confirmation par email.</div>
    </div>
    <p style="color:rgba(255,255,255,0.5);font-size:12px;">Des questions ? Contactez-nous sur Telegram : @novaicloud</p>`;
  return transporter.sendMail({
    from: `"Nova iCloud" <${process.env.EMAIL_USER}>`,
    to: email,
    subject: '⏳ Paiement reçu — Activation de votre licence en cours',
    html: templateBase('Licence Pro — Paiement reçu', contenu)
  });
}

// ================== AUTH ==================
app.post('/api/register', async (req, res) => {
  try {
    const { nom, prenom, email, password } = req.body;
    if (!nom || !prenom || !email || !password) return res.json({ success: false, error: 'Tous les champs sont requis' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.json({ success: false, error: 'Email invalide' });
    if (password.length < 6) return res.json({ success: false, error: 'Mot de passe trop court (min 6)' });
    const { data: existing } = await supabase.from('accounts').select('id').eq('email', email.toLowerCase()).maybeSingle();
    if (existing) return res.json({ success: false, error: 'Cet email est déjà utilisé' });
    const hash = await bcrypt.hash(password, 12);
    const { data, error } = await supabase.from('accounts').insert([{
      nom, prenom, email: email.toLowerCase(), password_hash: hash, subscribed_newsletter: true
    }]).select().single();
    if (error) throw error;
    try { await envoyerEmailBienvenue(email, prenom, nom); } catch (e) { console.error('Email:', e.message); }
    req.session.user = { id: data.id, nom, prenom, email: email.toLowerCase(), licence: false };
    res.json({ success: true, user: req.session.user });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const { data, error } = await supabase.from('accounts').select('*').eq('email', email.toLowerCase()).single();
    if (error || !data) return res.json({ success: false, error: 'Email ou mot de passe incorrect' });
    const valid = await bcrypt.compare(password, data.password_hash);
    if (!valid) return res.json({ success: false, error: 'Email ou mot de passe incorrect' });
    req.session.user = { id: data.id, nom: data.nom, prenom: data.prenom, email: data.email, licence: data.licence_active || false };
    res.json({ success: true, user: req.session.user });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

app.post('/api/logout', (req, res) => { req.session.destroy(); res.json({ success: true }); });
app.get('/api/me', (req, res) => {
  if (req.session?.user) return res.json({ authenticated: true, user: req.session.user });
  res.json({ authenticated: false });
});

// ================== STRIPE ==================
const PACK_PRICES = {
  1: { amount: 5000, label: '1 iPhone — 50€' },
  2: { amount: 7000, label: '2 iPhones — 70€' },
  3: { amount: 12000, label: '3 iPhones — 120€' },
  licence: { amount: 35000, label: 'Licence Pro à vie — 350€' }
};

app.post('/api/create-checkout', async (req, res) => {
  try {
    if (!req.session?.user) return res.json({ success: false, error: 'Connexion requise' });
    const { pack, imeis } = req.body;
    const packInfo = PACK_PRICES[pack];
    if (!packInfo) return res.json({ success: false, error: 'Pack invalide' });

    const sess = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{ price_data: { currency: 'eur', product_data: { name: packInfo.label, description: 'Nova iCloud — Déblocage iCloud iPhone' }, unit_amount: packInfo.amount }, quantity: 1 }],
      mode: 'payment',
      success_url: `${process.env.SITE_URL || 'https://novaicloud.com'}/?success=1&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.SITE_URL || 'https://novaicloud.com'}/`,
      metadata: {
        client_email: req.session.user.email,
        type: pack === 'licence' ? 'licence' : 'deblocage',
        pack: String(pack),
        imeis: JSON.stringify(imeis || [])
      }
    });

    await supabase.from('payments').insert([{
      stripe_session_id: sess.id,
      client_email: req.session.user.email,
      pack: pack === 'licence' ? 0 : parseInt(pack),
      montant: packInfo.amount / 100,
      statut: 'pending',
      imeis: imeis || []
    }]);

    res.json({ success: true, url: sess.url });
  } catch (e) {
    console.error('Stripe:', e.message);
    res.json({ success: false, error: e.message });
  }
});

// ================== AVIS ==================
app.get('/api/avis', async (req, res) => {
  try {
    const { data, error } = await supabase.from('avis').select('prenom_client, note, message, created_at').eq('statut', 'accepte').order('created_at', { ascending: false });
    if (error) throw error;
    res.json({ success: true, data: data || [] });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

app.post('/api/avis', async (req, res) => {
  try {
    if (!req.session?.user) return res.json({ success: false, error: 'Connexion requise' });
    const { note, message } = req.body;
    if (!note || note < 1 || note > 5) return res.json({ success: false, error: 'Note invalide' });
    if (!message || message.trim().length < 3) return res.json({ success: false, error: 'Message trop court' });
    await supabase.from('avis').insert([{ prenom_client: req.session.user.prenom, email_compte: req.session.user.email, note: parseInt(note), message: message.trim(), statut: 'en_attente' }]);
    res.json({ success: true });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// ================== PROMOTIONS ==================
app.get('/api/promo', async (req, res) => {
  try {
    const { data } = await supabase.from('promotions').select('*').eq('active', true).order('created_at', { ascending: false }).limit(1);
    res.json({ success: true, promo: data?.[0] || null });
  } catch (e) { res.json({ success: false, promo: null }); }
});

// ================== MAINTENANCE ==================
app.get('/api/maintenance', async (req, res) => {
  try {
    const { data: mode } = await supabase.from('system_settings').select('value').eq('key', 'maintenance_mode').single();
    const { data: msg } = await supabase.from('system_settings').select('value').eq('key', 'maintenance_message').single();
    res.json({ active: mode?.value === 'true', message: msg?.value || '' });
  } catch (e) { res.json({ active: false, message: '' }); }
});

// ================== CHAT IA ==================
app.post('/api/chat', async (req, res) => {
  try {
    const { message, history } = req.body;
    if (!message) return res.json({ success: false, error: 'Message vide' });
    if (!process.env.ANTHROPIC_API_KEY) {
      return res.json({ success: true, reply: "Je vous redirige vers notre support : @novaicloud", toTelegram: true });
    }

    const systemPrompt = `Tu es l'assistant virtuel de Nova iCloud, service de déblocage iCloud pour iPhone.
Réponds uniquement aux questions sur :
- Déblocage iCloud (fonctionnement, délais, compatibilité iPhone 7 à iPhone 17)
- Prix : 1 iPhone=50€, 2 iPhones=70€, 3 iPhones=120€, Licence Pro=350€
- Paiements : Carte bancaire (Stripe), Crypto, PCS, Paysafecard, Skrill
- Le logiciel Windows Nova iCloud
Réponds en français par défaut, anglais si le client écrit en anglais.
Sois bref et professionnel. Si tu ne peux pas répondre, dis : "Contactez notre support : @novaicloud"`;

    const messages = [...(history || []).slice(-6), { role: 'user', content: message }];
    const response = await anthropic.messages.create({ model: 'claude-haiku-4-5-20251001', max_tokens: 300, system: systemPrompt, messages });
    const reply = response.content[0].text;
    const toTelegram = reply.toLowerCase().includes('@novaicloud');
    res.json({ success: true, reply, toTelegram });
  } catch (e) {
    console.error('Chat IA error:', e.message);
    res.json({ success: true, reply: "Je ne suis pas disponible. Contactez : @novaicloud", toTelegram: true });
  }
});

// ================== ROUTE PRINCIPALE ==================
app.get('*', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'index.html')); });

app.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('========================================');
  console.log('  NOVA ICLOUD - SITE WEB');
  console.log('========================================');
  console.log(`  Local  : http://localhost:${PORT}`);
  console.log('========================================');
  console.log('');
});
