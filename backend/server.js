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

// ─────────────────────────────────────────
// DATABASE
// ─────────────────────────────────────────
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => console.error('❌ MongoDB error:', err));

// ─────────────────────────────────────────
// SCHEMAS
// ─────────────────────────────────────────

const emailSchema = new mongoose.Schema({
  senderEmail:    String,
  subject:        String,
  recipients: [{
    email: String,
    name:  String,
    role:  { type: String, enum: ['to', 'cc', 'bcc'], default: 'to' }
  }],
  trackingId:     { type: String, unique: true },
  createdAt:      { type: Date, default: Date.now },
  sentAt:         Date,
  status:         { type: String, enum: ['tracked', 'archived'], default: 'tracked' },
  source:         { type: String, default: 'gmail-extension' },
  // Thread/reply support
  parentEmailId:  { type: mongoose.Schema.Types.ObjectId, ref: 'Email', default: null },
  threadId:       { type: String, default: null },
  isReply:        { type: Boolean, default: false },
  replyDepth:     { type: Number, default: 0 }
});

const openEventSchema = new mongoose.Schema({
  emailId:        { type: mongoose.Schema.Types.ObjectId, ref: 'Email' },
  trackingId:     String,
  recipientEmail: String,
  recipientRole:  { type: String, enum: ['to', 'cc', 'bcc', 'unknown'], default: 'unknown' },
  openedAt:       { type: Date, default: Date.now },
  userAgent:      String,
  ipAddress:      String,
  deviceInfo:     { browser: String, os: String, device: String },
  isFromSender:   { type: Boolean, default: false }
});

const userSchema = new mongoose.Schema({
  email:        String,
  name:         String,
  refreshToken: String,
  accessToken:  String,
  tokenExpiry:  Date,
  senderIPs:    [String],
  createdAt:    { type: Date, default: Date.now }
});

const Email     = mongoose.model('Email',     emailSchema);
const OpenEvent = mongoose.model('OpenEvent', openEventSchema);
const User      = mongoose.model('User',      userSchema);

// ─────────────────────────────────────────
// GOOGLE OAUTH
// ─────────────────────────────────────────

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URL
);

const SCOPES = [
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile'
];

app.get('/auth/google', (req, res) => {
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent'
  });
  res.redirect(url);
});

app.get('/auth/google/callback', async (req, res) => {
  try {
    const { code } = req.query;
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
    const { data: profile } = await oauth2.userinfo.get();

    let user = await User.findOne({ email: profile.email });
    if (!user) {
      user = new User({
        email:     profile.email,
        name:      profile.name,
        senderIPs: (process.env.SENDER_IPS || '').split(',').filter(Boolean)
      });
    }
    user.refreshToken = tokens.refresh_token || user.refreshToken;
    user.accessToken  = tokens.access_token;
    user.tokenExpiry  = new Date(tokens.expiry_date);
    await user.save();

    const jwtToken = jwt.sign(
      { userId: user._id, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );

    res.redirect(`/?token=${jwtToken}`);
  } catch (error) {
    console.error('OAuth error:', error);
    res.status(500).send('Authentication failed');
  }
});

// ─────────────────────────────────────────
// AUTH MIDDLEWARE
// ─────────────────────────────────────────

async function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }
  try {
    const token   = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user    = await User.findById(decoded.userId);
    if (!user) return res.status(401).json({ error: 'User not found' });
    req.user = user;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// ─────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────

function generateId() {
  return crypto.randomBytes(16).toString('hex');
}

function parseUA(ua) {
  const parser = new UAParser(ua);
  const r = parser.getResult();
  return {
    browser: r.browser.name || 'Unknown',
    os:      r.os.name      || 'Unknown',
    device:  r.device.type  || 'Desktop'
  };
}

function getIP(req) {
  return req.headers['x-forwarded-for']?.split(',')[0].trim()
    || req.socket.remoteAddress;
}

function isSender(ip, user) {
  if (!user) return false;
  const senderSet = new Set([
    ...(user.senderIPs || []),
    '127.0.0.1', '::1', '::ffff:127.0.0.1'
  ]);
  return senderSet.has(ip);
}

const PIXEL_GIF = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'
);

// ─────────────────────────────────────────
// PIXEL TRACKING
// ─────────────────────────────────────────

app.get('/track/pixel/:trackingId', async (req, res) => {
  try {
    const { trackingId } = req.params;
    const recipientEmail = req.query.r    || 'unknown';
    const recipientRole  = req.query.role || 'unknown';

    const email = await Email.findOne({ trackingId });

    if (email) {
      const ip         = getIP(req);
      const user       = await User.findOne({ email: email.senderEmail });
      const fromSender = isSender(ip, user);

      if (!fromSender) {
        await OpenEvent.create({
          emailId:        email._id,
          trackingId,
          recipientEmail,
          recipientRole,
          userAgent:      req.headers['user-agent'],
          ipAddress:      ip,
          deviceInfo:     parseUA(req.headers['user-agent']),
          isFromSender:   false
        });
      }
    }
  } catch (e) {
    console.error('Pixel error:', e.message);
  }

  res.set({
    'Content-Type':  'image/gif',
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    'Pragma':        'no-cache',
    'Expires':       '0'
  });
  res.send(PIXEL_GIF);
});

// ─────────────────────────────────────────
// REGISTER EMAIL (compose or reply)
// ─────────────────────────────────────────

app.post('/api/track/register', authMiddleware, async (req, res) => {
  try {
    const {
      subject, recipients, source,
      parentEmailId, threadId, isReply, replyDepth
    } = req.body;

    const trackingId = generateId();

    // If this is a reply, find parent to link thread
    let resolvedParentId = null;
    let resolvedThreadId = threadId || generateId();
    let resolvedDepth    = replyDepth || 0;

    if (parentEmailId) {
      const parent = await Email.findById(parentEmailId);
      if (parent) {
        resolvedParentId = parent._id;
        resolvedThreadId = parent.threadId || resolvedThreadId;
        resolvedDepth    = (parent.replyDepth || 0) + 1;
      }
    }

    const email = await Email.create({
      senderEmail:   req.user.email,
      subject,
      recipients,
      trackingId,
      sentAt:        new Date(),
      status:        'tracked',
      source:        source || 'gmail-extension',
      parentEmailId: resolvedParentId,
      threadId:      resolvedThreadId,
      isReply:       isReply || false,
      replyDepth:    resolvedDepth
    });

    res.json({
      success:    true,
      emailId:    email._id,
      trackingId,
      pixelUrl:   `${process.env.SERVER_URL}/track/pixel/${trackingId}`
    });
  } catch (error) {
    console.error('Register error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─────────────────────────────────────────
// GET USER INFO
// ─────────────────────────────────────────

app.get('/api/me', authMiddleware, (req, res) => {
  res.json({
    email:     req.user.email,
    name:      req.user.name,
    senderIPs: req.user.senderIPs
  });
});

app.put('/api/me/ips', authMiddleware, async (req, res) => {
  req.user.senderIPs = req.body.ips;
  await req.user.save();
  res.json({ success: true, senderIPs: req.user.senderIPs });
});

// ─────────────────────────────────────────
// GET ALL TOP-LEVEL EMAILS (not replies)
// ─────────────────────────────────────────

app.get('/api/emails', authMiddleware, async (req, res) => {
  try {
    // Only get top-level emails (not replies)
    const emails = await Email.find({
      senderEmail:   req.user.email,
      parentEmailId: null
    }).sort({ sentAt: -1 });

    const enriched = await Promise.all(emails.map(async (em) => {
      const openCount  = await OpenEvent.countDocuments({ emailId: em._id, isFromSender: false });
      const lastOpen   = await OpenEvent.findOne({ emailId: em._id, isFromSender: false }).sort({ openedAt: -1 });
      const replyCount = await Email.countDocuments({ threadId: em.threadId, parentEmailId: { $ne: null } });

      return {
        ...em.toObject(),
        openCount,
        lastOpenedAt: lastOpen?.openedAt || null,
        unopened:     openCount === 0,
        replyCount
      };
    }));

    res.json(enriched);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─────────────────────────────────────────
// GET EMAIL THREAD (original + all replies)
// ─────────────────────────────────────────

app.get('/api/emails/:id/thread', authMiddleware, async (req, res) => {
  try {
    const rootEmail = await Email.findById(req.params.id);
    if (!rootEmail) return res.status(404).json({ error: 'Email not found' });

    // Get all emails in this thread
    const allInThread = await Email.find({
      threadId:    rootEmail.threadId,
      senderEmail: req.user.email
    }).sort({ sentAt: 1 });

    // Enrich each with open data
    const enriched = await Promise.all(allInThread.map(async (em) => {
      const opens = await OpenEvent.find({ emailId: em._id, isFromSender: false }).sort({ openedAt: 1 });

      const recipientMap = {};
      em.recipients.forEach(r => {
        recipientMap[r.email] = {
          email:     r.email,
          role:      r.role || 'to',
          openCount: 0,
          firstOpen: null,
          lastOpen:  null,
          status:    'unopened'
        };
      });

      opens.forEach(o => {
        if (recipientMap[o.recipientEmail]) {
          recipientMap[o.recipientEmail].openCount++;
          recipientMap[o.recipientEmail].status   = 'opened';
          recipientMap[o.recipientEmail].lastOpen = o.openedAt;
          if (!recipientMap[o.recipientEmail].firstOpen) {
            recipientMap[o.recipientEmail].firstOpen = o.openedAt;
          }
        }
      });

      return {
        ...em.toObject(),
        totalOpens: opens.length,
        unopened:   opens.length === 0,
        byRole: {
          to:  Object.values(recipientMap).filter(r => r.role === 'to'),
          cc:  Object.values(recipientMap).filter(r => r.role === 'cc'),
          bcc: Object.values(recipientMap).filter(r => r.role === 'bcc')
        }
      };
    }));

    // Build tree structure
    function buildTree(emails, parentId = null) {
      return emails
        .filter(e => String(e.parentEmailId) === String(parentId))
        .map(e => ({
          ...e,
          replies: buildTree(emails, e._id)
        }));
    }

    const tree = enriched.filter(e => !e.parentEmailId);
    tree.forEach(root => {
      root.replies = buildTree(enriched, root._id);
    });

    res.json({ thread: tree[0] || enriched[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─────────────────────────────────────────
// EMAIL ANALYTICS
// ─────────────────────────────────────────

app.get('/api/emails/:id/analytics', authMiddleware, async (req, res) => {
  try {
    const email = await Email.findById(req.params.id);
    if (!email) return res.status(404).json({ error: 'Email not found' });

    const opens = await OpenEvent.find({ emailId: email._id, isFromSender: false }).sort({ openedAt: 1 });

    const recipientMap = {};
    email.recipients.forEach(r => {
      recipientMap[r.email] = {
        email:     r.email,
        name:      r.name || '',
        role:      r.role || 'to',
        opens:     [],
        openCount: 0,
        firstOpen: null,
        lastOpen:  null,
        status:    'unopened'
      };
    });

    opens.forEach(o => {
      const key = o.recipientEmail;
      if (recipientMap[key]) {
        recipientMap[key].opens.push({ openedAt: o.openedAt, device: o.deviceInfo });
        recipientMap[key].openCount++;
        recipientMap[key].lastOpen = o.openedAt;
        recipientMap[key].status   = 'opened';
        if (!recipientMap[key].firstOpen) recipientMap[key].firstOpen = o.openedAt;
      }
    });

    const byRole = {
      to:  Object.values(recipientMap).filter(r => r.role === 'to'),
      cc:  Object.values(recipientMap).filter(r => r.role === 'cc'),
      bcc: Object.values(recipientMap).filter(r => r.role === 'bcc')
    };

    res.json({
      email:      email.toObject(),
      totalOpens: opens.length,
      firstOpen:  opens[0]?.openedAt || null,
      lastOpen:   opens[opens.length - 1]?.openedAt || null,
      byRole
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─────────────────────────────────────────
// STATS
// ─────────────────────────────────────────

app.get('/api/stats', authMiddleware, async (req, res) => {
  try {
    const emailIds    = await Email.find({ senderEmail: req.user.email }).distinct('_id');
    const totalEmails = emailIds.length;
    const totalOpens  = await OpenEvent.countDocuments({ emailId: { $in: emailIds }, isFromSender: false });
    const openedIds   = await OpenEvent.find({ emailId: { $in: emailIds }, isFromSender: false }).distinct('emailId');

    res.json({
      totalEmails,
      totalOpens,
      totalClicks: 0,
      openRate: totalEmails ? Math.round((openedIds.length / totalEmails) * 100) : 0
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─────────────────────────────────────────
// DELETE EMAIL
// ─────────────────────────────────────────

app.delete('/api/emails/:id', authMiddleware, async (req, res) => {
  try {
    await Email.findByIdAndDelete(req.params.id);
    await OpenEvent.deleteMany({ emailId: req.params.id });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─────────────────────────────────────────
// SERVE FRONTEND
// ─────────────────────────────────────────

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`\n🚀 MailPulse running at http://localhost:${PORT}`);
  console.log(`📧 Login at http://localhost:${PORT}/auth/google\n`);
});