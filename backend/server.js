require('dotenv').config();
const express  = require('express');
const mongoose = require('mongoose');
const cors     = require('cors');
const jwt      = require('jsonwebtoken');
const { google } = require('googleapis');
const UAParser = require('ua-parser-js');
const path     = require('path');

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve dashboard — handle both root-level and backend/ sub-folder deployments
const FRONTEND_DIR = (() => {
  const fs = require('fs');
  const sibling = path.join(__dirname, 'frontend');
  const parent  = path.join(__dirname, '..', 'frontend');
  if (fs.existsSync(sibling))  return sibling;
  if (fs.existsSync(parent))   return parent;
  return __dirname; // fallback: index.html is in same folder as server.js
})();
app.use(express.static(FRONTEND_DIR));

// DATABASE
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => console.error('❌ MongoDB error:', err));

// SCHEMAS
const emailSchema = new mongoose.Schema({
  senderEmail:   String,
  subject:       String,
  recipients: [{
    email: String,
    role:  { type: String, enum: ['to', 'cc', 'bcc'], default: 'to' }
  }],
  trackingId:    { type: String, unique: true },
  sentAt:        { type: Date, default: Date.now },
  parentEmailId: { type: mongoose.Schema.Types.ObjectId, ref: 'Email', default: null },
  threadId:      { type: String, default: null }
});

const openEventSchema = new mongoose.Schema({
  emailId:      { type: mongoose.Schema.Types.ObjectId, ref: 'Email' },
  trackingId:   String,
  openedAt:     { type: Date, default: Date.now },
  ipAddress:    String,
  deviceInfo:   { browser: String, os: String, device: String },
  isFromSender: { type: Boolean, default: false }
});

const userSchema = new mongoose.Schema({
  email:     String,
  name:      String,
  senderIPs: [String],
});

const Email     = mongoose.model('Email', emailSchema);
const OpenEvent = mongoose.model('OpenEvent', openEventSchema);
const User      = mongoose.model('User', userSchema);

// OAUTH
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URL
);
const SCOPES = [
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile'
];

app.get('/auth/google', (req, res) =>
  res.redirect(oauth2Client.generateAuthUrl({ access_type: 'offline', scope: SCOPES, prompt: 'consent' }))
);

app.get('/auth/google/callback', async (req, res) => {
  try {
    const { tokens } = await oauth2Client.getToken(req.query.code);
    oauth2Client.setCredentials(tokens);
    const { data: profile } = await google.oauth2({ version: 'v2', auth: oauth2Client }).userinfo.get();

    let user = await User.findOne({ email: profile.email });
    if (!user) {
      user = new User({
        email: profile.email, name: profile.name,
        senderIPs: (process.env.SENDER_IPS || '').split(',').filter(Boolean)
      });
      await user.save();
    }
    const token = jwt.sign({ userId: user._id, email: user.email }, process.env.JWT_SECRET, { expiresIn: '30d' });
    res.redirect(`/?token=${token}`);
  } catch (err) { console.error('Auth error:', err); res.status(500).send('Authentication failed'); }
});

// AUTH MIDDLEWARE
async function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return res.status(401).json({ error: 'No token' });
  try {
    const decoded = jwt.verify(header.split(' ')[1], process.env.JWT_SECRET);
    req.user = await User.findById(decoded.userId);
    if (!req.user) throw new Error('User not found');
    next();
  } catch (e) { res.status(401).json({ error: 'Invalid token' }); }
}

function getIP(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || 'unknown';
}
function parseUA(ua) {
  const r = new UAParser(ua || '').getResult();
  return { browser: r.browser?.name || 'Unknown', os: r.os?.name || 'Unknown' };
}

const PIXEL_GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

// ─── PIXEL ENDPOINT ───────────────────────────────────────────────────────────
app.get('/track/pixel/:trackingId', async (req, res) => {
  // Always return the pixel immediately — never block on DB
  res.set({
    'Content-Type':  'image/gif',
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    'Pragma':        'no-cache',
    'Expires':       '0'
  });
  res.send(PIXEL_GIF);

  // Record open asynchronously AFTER response is sent
  try {
    const email = await Email.findOne({ trackingId: req.params.trackingId });
    if (!email) {
      // FIX: log so we can see if pixel fires before registration
      console.log('MailPulse pixel: no email found for trackingId', req.params.trackingId, '(may be compose-preview or late open)');
      return;
    }
    await OpenEvent.create({
      emailId:      email._id,
      trackingId:   req.params.trackingId,
      ipAddress:    getIP(req),
      deviceInfo:   parseUA(req.headers['user-agent']),
      isFromSender: false
    });
    console.log('MailPulse pixel: open recorded for', req.params.trackingId, 'from', getIP(req));
  } catch (e) {
    console.error('MailPulse pixel error:', e.message);
  }
});

// ─── REGISTER EMAIL ───────────────────────────────────────────────────────────
app.post('/api/track/register', authMiddleware, async (req, res) => {
  try {
    const { subject, recipients, trackingId, parentEmailId, threadId } = req.body;
    let resolvedParentId = null;
    let resolvedThreadId = threadId || trackingId;

    if (parentEmailId) {
      const parent = await Email.findById(parentEmailId);
      if (parent) {
        resolvedParentId = parent._id;
        resolvedThreadId = parent.threadId || resolvedThreadId;
      }
    }

    await Email.create({
      senderEmail:   req.user.email,
      subject,
      recipients,
      trackingId,
      parentEmailId: resolvedParentId,
      threadId:      resolvedThreadId,
      sentAt:        new Date()
    });

    console.log('MailPulse: Email registered —', trackingId, '| Subject:', subject, '| Recipients:', recipients?.length);
    res.json({ success: true });
  } catch (err) {
    console.error('MailPulse register error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── API ROUTES ───────────────────────────────────────────────────────────────
app.get('/api/me', authMiddleware, (req, res) => res.json({ email: req.user.email, name: req.user.name }));

app.get('/api/emails', authMiddleware, async (req, res) => {
  try {
    const emails = await Email.find({ senderEmail: req.user.email, parentEmailId: null }).sort({ sentAt: -1 });
    const enriched = await Promise.all(emails.map(async (em) => {
      const opens = await OpenEvent.find({ emailId: em._id, isFromSender: false });
      return { ...em.toObject(), openCount: opens.length, unopened: opens.length === 0 };
    }));
    res.json(enriched);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

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

    const tree = enriched.filter(e => !e.parentEmailId);
    function buildTree(emails, parentId = null) {
      return emails
        .filter(e => String(e.parentEmailId) === String(parentId))
        .map(e => ({ ...e, replies: buildTree(emails, e._id) }));
    }
    tree.forEach(r => r.replies = buildTree(enriched, r._id));
    res.json({ thread: tree[0] || enriched[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/stats', authMiddleware, async (req, res) => {
  try {
    const emails    = await Email.find({ senderEmail: req.user.email });
    const emailIds  = emails.map(e => e._id);
    const totalOpens = await OpenEvent.countDocuments({ emailId: { $in: emailIds }, isFromSender: false });
    const openRate  = emails.length > 0 ? Math.round((emails.filter(async e => {
      const c = await OpenEvent.countDocuments({ emailId: e._id }); return c > 0;
    }).length / emails.length) * 100) : 0;
    res.json({ totalEmails: emails.length, totalOpens, openRate: 0 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/emails/:id', authMiddleware, async (req, res) => {
  try {
    await Email.findByIdAndDelete(req.params.id);
    await OpenEvent.deleteMany({ emailId: req.params.id });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── SERVE DASHBOARD ─────────────────────────────────────────────────────────
// Health check endpoint — use with UptimeRobot to keep server warm
app.get('/health', (req, res) => res.json({ status: 'ok', ts: Date.now() }));
app.get('/ping',   (req, res) => res.json({ status: 'ok', ts: Date.now() })); // UptimeRobot keep-alive

app.get('/', (req, res) => res.sendFile(path.join(FRONTEND_DIR, 'index.html')));

app.listen(process.env.PORT || 5000, () => console.log('🚀 MailPulse server running'));