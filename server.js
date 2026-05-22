const express = require('express');
const path = require('path');
const bcrypt = require('bcrypt');
const session = require('express-session');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
require('dotenv').config(); // fallback pour Render

const { createClient } = require('@supabase/supabase-js');
const nodemailer = require('nodemailer');

const app = express();
const PORT = process.env.SITE_PORT || 3000;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const EMAIL_USER = process.env.EMAIL_USER;
const EMAIL_PASS = process.env.EMAIL_PASS;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY || SUPABASE_ANON_KEY);

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: EMAIL_USER, pass: EMAIL_PASS }
});

app.use(express.json());
app.use(session({
  secret: 'nanar-site-secret-2026',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 * 7 } // 7 jours
}));
app.use(express.static(path.join(__dirname, 'public')));

// ================== EMAIL BIENVENUE ==================
function templateBase(titre, contenu) {
  return `
  <!DOCTYPE html><html><head><meta charset="UTF-8"></head>
  <body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#FAFAFA;">
    <div style="max-width:560px;margin:40px auto;background:white;border-radius:16px;border:0.5px solid #E5E7EB;overflow:hidden;">
      <div style="padding:32px 32px 16px;">
        <div style="display:inline-block;width:40px;height:40px;background:#7C3AED;border-radius:10px;text-align:center;line-height:40px;color:white;font-weight:500;font-size:18px;vertical-align:middle;">N</div>
        <div style="display:inline-block;vertical-align:middle;margin-left:10px;">
          <div style="font-size:14px;font-weight:500;color:#111827;">Nanar iCloud</div>
          <div style="font-size:11px;color:#6B7280;">Déblocage iCloud</div>
        </div>
      </div>
      <div style="padding:8px 32px 32px;">
        <h1 style="font-size:22px;font-weight:500;color:#111827;margin:0 0 16px;">${titre}</h1>
        ${contenu}
      </div>
      <div style="background:#FAFAFA;border-top:0.5px solid #E5E7EB;padding:20px 32px;text-align:center;">
        <div style="font-size:11px;color:#9CA3AF;margin-bottom:4px;">© 2026 Nanar iCloud</div>
        <a href="https://t.me/nanarofficloud" style="font-size:11px;color:#7C3AED;text-decoration:none;">Support : @nanarofficloud</a>
      </div>
    </div>
  </body></html>`;
}

async function envoyerEmailBienvenue(email, prenom, nom) {
  const contenu = `
    <p style="color:#374151;font-size:14px;line-height:1.6;margin:0 0 16px;">Bonjour <strong>${prenom} ${nom}</strong>,</p>
    <p style="color:#374151;font-size:14px;line-height:1.6;margin:0 0 20px;">Bienvenue sur <strong>Nanar iCloud</strong> ! Votre compte a été créé avec succès.</p>
    <div style="background:#FAFAFA;border-radius:10px;padding:20px;margin:20px 0;">
      <div style="font-size:12px;color:#6B7280;font-weight:500;margin-bottom:12px;letter-spacing:0.3px;">VOS INFORMATIONS</div>
      <table style="width:100%;border-collapse:collapse;">
        <tr><td style="padding:6px 0;color:#6B7280;font-size:13px;">Nom complet</td><td style="padding:6px 0;color:#111827;font-size:13px;font-weight:500;text-align:right;">${prenom} ${nom}</td></tr>
        <tr><td style="padding:6px 0;color:#6B7280;font-size:13px;">Email</td><td style="padding:6px 0;color:#111827;font-size:13px;font-weight:500;text-align:right;">${email}</td></tr>
      </table>
    </div>
    <p style="color:#374151;font-size:14px;line-height:1.6;margin:20px 0 12px;"><strong>Prochaines étapes :</strong></p>
    <ol style="color:#4B5563;font-size:13px;line-height:1.8;padding-left:20px;margin:0 0 24px;">
      <li>Téléchargez le logiciel Nanar iCloud</li>
      <li>Connectez-vous avec votre email et mot de passe</li>
      <li>Branchez votre iPhone et débloquez-le</li>
    </ol>
    <div style="text-align:center;">
      <a href="https://t.me/nanarofficloud" style="display:inline-block;padding:11px 24px;background:#7C3AED;color:white;text-decoration:none;border-radius:8px;font-size:13px;font-weight:500;">Nous contacter</a>
    </div>`;
  return transporter.sendMail({
    from: `"Nanar iCloud" <${EMAIL_USER}>`,
    to: email,
    subject: 'Bienvenue sur Nanar iCloud',
    html: templateBase('Bienvenue !', contenu)
  });
}

// ================== AUTH ==================
app.post('/api/register', async (req, res) => {
  try {
    const { nom, prenom, email, password } = req.body;
    if (!nom || !prenom || !email || !password) return res.json({ success:false, error:'Tous les champs sont requis' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.json({ success:false, error:'Email invalide' });
    if (password.length < 6) return res.json({ success:false, error:'Mot de passe trop court (min 6)' });

    const { data: existing } = await supabase.from('accounts').select('id').eq('email', email.toLowerCase()).maybeSingle();
    if (existing) return res.json({ success:false, error:'Cet email est déjà utilisé' });

    const hash = await bcrypt.hash(password, 12);
    const { data, error } = await supabase.from('accounts').insert([{
      nom, prenom, email: email.toLowerCase(), password_hash: hash, subscribed_newsletter: true
    }]).select().single();
    if (error) throw error;

    try { await envoyerEmailBienvenue(email, prenom, nom); } catch(e){ console.error('Email:', e.message); }

    req.session.user = { id: data.id, nom, prenom, email: email.toLowerCase() };
    res.json({ success:true, user: req.session.user });
  } catch (e) {
    res.json({ success:false, error: e.message });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const { data, error } = await supabase.from('accounts').select('*').eq('email', email.toLowerCase()).single();
    if (error || !data) return res.json({ success:false, error:'Email ou mot de passe incorrect' });
    if (!data.password_hash) return res.json({ success:false, error:'Compte invalide' });

    const valid = await bcrypt.compare(password, data.password_hash);
    if (!valid) return res.json({ success:false, error:'Email ou mot de passe incorrect' });

    req.session.user = { id: data.id, nom: data.nom, prenom: data.prenom, email: data.email };
    res.json({ success:true, user: req.session.user });
  } catch (e) {
    res.json({ success:false, error: e.message });
  }
});

app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ success:true });
});

app.get('/api/me', (req, res) => {
  if (req.session && req.session.user) return res.json({ authenticated:true, user:req.session.user });
  res.json({ authenticated:false });
});

// ================== ROUTE PRINCIPALE (SPA) ==================
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('========================================');
  console.log('  NANAR ICLOUD - SITE WEB');
  console.log('========================================');
  console.log(`  Local    : http://localhost:${PORT}`);
  console.log(`  Réseau   : http://[VOTRE-IP]:${PORT}`);
  console.log('========================================');
  console.log('');
});