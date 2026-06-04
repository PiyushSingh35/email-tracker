require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const { google } = require('googleapis');
const crypto = require('crypto');
const UAParser = require('ua-parser-js');
const path = require('path');

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '../frontend')));

// DATABASE
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => console.error('❌ MongoDB error:', err));

// SCHEMAS
const emailSchema = new mongoose.Schema({
  senderEmail:    String,
  subject:        String,
  recipients: [{
    email: String,
    role:  { type: String, enum: ['to', 'cc', 'bcc'], default: 'to' }
  }],
  trackingId:     { type: String, unique: true },
  sentAt:         { type: Date, default: Date.now },
  parentEmailId:  { type: mongoose.Schema.Types.ObjectId, ref: 'Email', default: null },
  threadId:       { type: String, default: null }
});

const openEventSchema = new mongoose.Schema({
  emailId:        { type: mongoose.Schema.Types.ObjectId, ref: 'Email' },
  trackingId:     String,
  openedAt:       { type: Date, default: Date.now },
  ipAddress:      String,
  deviceInfo:     { browser: String, os: String, device: String },
  isFromSender:   { type: Boolean, default: false }
});

const userSchema = new mongoose.Schema({
  email:        String,
  name:         String,
  senderIPs:    [String],
});

const Email     = mongoose.model('Email', emailSchema);
const OpenEvent = mongoose.model('OpenEvent', openEventSchema);
const User      = mongoose.model('User', userSchema);

// OAUTH
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, process.env.GOOGLE_REDIRECT_URL
);
const SCOPES = ['https://www.googleapis.com/auth/userinfo.email', 'https://www.googleapis.com/auth/userinfo.profile'];

app.get('/auth/google', (req, res) => res.redirect(oauth2Client.generateAuthUrl({ access_type: 'offline', scope: SCOPES, prompt: 'consent' })));

app.get('/auth/google/callback', async (req, res) => {
  try {
    const { code } = req.query;
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);
    const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
    const { data: profile } = await oauth2.userinfo.get();

    let user = await User.findOne({ email: profile.email });
    if (!user) {
      user = new User({ email: profile.email, name: profile.name, senderIPs: (process.env.SENDER_IPS || '').split(',').filter(Boolean) });
      await user.save();
    }
    const jwtToken = jwt.sign({ userId: user._id, email: user.email }, process.env.JWT_SECRET, { expiresIn: '30d' });
    res.redirect(`/?token=${jwtToken}`);
  } catch (error) { res.status(500).send('Authentication failed'); }
});

async function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) return res.status(401).json({ error: 'No token' });
  try {
    const decoded = jwt.verify(authHeader.split(' ')[1], process.env.JWT_SECRET);
    req.user = await User.findById(decoded.userId);
    if (!req.user) throw new Error();
    next();
  } catch (err) { res.status(401).json({ error: 'Invalid token' }); }
}

function getIP(req) { return (req.headers['x-forwarded-for']?.split(',')[0].trim()) || req.socket?.remoteAddress || 'unknown'; }
function parseUA(ua) { const r = new UAParser(ua || '').getResult(); return { browser: r.browser?.name || 'Unknown', os: r.os?.name || 'Unknown' }; }

const PIXEL_GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

// ─────────────────────────────────────────
// PIXEL TRACKING - Aggregate Only (NO IP BLOCK)
// ─────────────────────────────────────────
app.get('/track/pixel/:trackingId', async (req, res) => {
  try {
    const email = await Email.findOne({ trackingId: req.params.trackingId });
    if (email) {
      
      // 🚨 THE FIX: IP Blocker completely removed. It will now track EVERY open, even from your own computer.
      await OpenEvent.create({
        emailId: email._id,
        trackingId: req.params.trackingId,
        ipAddress: getIP(req),
        deviceInfo: parseUA(req.headers['user-agent']),
        isFromSender: false // Forced to false so the dashboard never filters it out
      });

    }
  } catch (e) { console.error('Pixel error:', e.message); }
  res.set({ 'Content-Type': 'image/gif', 'Cache-Control': 'no-store, no-cache, must-revalidate', 'Pragma': 'no-cache', 'Expires': '0' });
  res.send(PIXEL_GIF);
});

// REGISTRATION
app.post('/api/track/register', authMiddleware, async (req, res) => {
  try {
    const { subject, recipients, trackingId, parentEmailId, threadId } = req.body;
    let resolvedParentId = null, resolvedThreadId = threadId || trackingId;

    if (parentEmailId) {
      const parent = await Email.findById(parentEmailId);
      if (parent) { resolvedParentId = parent._id; resolvedThreadId = parent.threadId || resolvedThreadId; }
    }

    const email = await Email.create({
      senderEmail: req.user.email, subject, recipients, trackingId, 
      parentEmailId: resolvedParentId, threadId: resolvedThreadId, sentAt: new Date()
    });
    res.json({ success: true });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/api/me', authMiddleware, (req, res) => res.json({ email: req.user.email }));

// FETCH ALL EMAILS
app.get('/api/emails', authMiddleware, async (req, res) => {
  try {
    const emails = await Email.find({ senderEmail: req.user.email, parentEmailId: null }).sort({ sentAt: -1 });
    const enriched = await Promise.all(emails.map(async (em) => {
      const opens = await OpenEvent.find({ emailId: em._id, isFromSender: false });
      return { ...em.toObject(), openCount: opens.length, unopened: opens.length === 0 };
    }));
    res.json(enriched);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// FETCH THREAD & OPENS TIMESTAMPS
app.get('/api/emails/:id/thread', authMiddleware, async (req, res) => {
  try {
    const root = await Email.findById(req.params.id);
    if (!root) return res.status(404).json({ error: 'Not found' });

    const thread = await Email.find({ threadId: root.threadId, senderEmail: req.user.email }).sort({ sentAt: 1 });
    const enriched = await Promise.all(thread.map(async (em) => {
      const opens = await OpenEvent.find({ emailId: em._id, isFromSender: false }).sort({ openedAt: -1 });
      return { 
        ...em.toObject(), 
        totalOpens: opens.length, 
        opens: opens.map(o => ({ time: o.openedAt, os: o.deviceInfo?.os, browser: o.deviceInfo?.browser })) 
      };
    }));

    function buildTree(emails, parentId = null) {
      return emails.filter(e => String(e.parentEmailId) === String(parentId)).map(e => ({ ...e, replies: buildTree(emails, e._id) }));
    }
    const tree = enriched.filter(e => !e.parentEmailId);
    tree.forEach(r => r.replies = buildTree(enriched, r._id));
    res.json({ thread: tree[0] || enriched[0] });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/api/stats', authMiddleware, async (req, res) => {
  try {
    const emailIds = await Email.find({ senderEmail: req.user.email }).distinct('_id');
    const totalOpens = await OpenEvent.countDocuments({ emailId: { $in: emailIds }, isFromSender: false });
    res.json({ totalEmails: emailIds.length, totalOpens, openRate: 0 }); // Simplified
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.delete('/api/emails/:id', authMiddleware, async (req, res) => {
  await Email.findByIdAndDelete(req.params.id);
  await OpenEvent.deleteMany({ emailId: req.params.id });
  res.json({ success: true });
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, '../frontend/index.html')));
app.listen(process.env.PORT || 5000, () => console.log(`🚀 Server Running`));