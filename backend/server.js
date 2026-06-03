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

// ─────────────── MIDDLEWARE ───────────────
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '../frontend')));

// ─────────────── DATABASE ───────────────
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => console.error('❌ MongoDB error:', err));

// ─────────────── SCHEMAS ───────────────

const emailSchema = new mongoose.Schema({
  senderEmail:    String,
  subject:        String,
  recipients:     [{ email: String, name: String }],
  bodyPlain:      String,   // original body (no pixel injected)
  trackingId:     { type: String, unique: true },
  createdAt:      { type: Date, default: Date.now },
  sentAt:         Date,
  gmailMessageId: String,
  status:         { type: String, enum: ['draft', 'sent'], default: 'draft' }
});

const openEventSchema = new mongoose.Schema({
  emailId:        { type: mongoose.Schema.Types.ObjectId, ref: 'Email' },
  trackingId:     String,
  openedAt:       { type: Date, default: Date.now },
  userAgent:      String,
  ipAddress:      String,
  deviceInfo:     { browser: String, os: String, device: String },
  isFromSender:   { type: Boolean, default: false },
  trackingMethod: { type: String, enum: ['pixel', 'link'] }
});

const linkClickSchema = new mongoose.Schema({
  emailId:        { type: mongoose.Schema.Types.ObjectId, ref: 'Email' },
  linkId:         String,
  originalUrl:    String,
  clickedAt:      { type: Date, default: Date.now },
  userAgent:      String,
  ipAddress:      String,
  deviceInfo:     { browser: String, os: String, device: String }
});

const userSchema = new mongoose.Schema({
  email:        String,
  name:         String,
  refreshToken: String,
  accessToken:  String,
  tokenExpiry:  Date,
  senderIPs:    [String],   // IPs to exclude from tracking
  createdAt:    { type: Date, default: Date.now }
});

const Email     = mongoose.model('Email', emailSchema);
const OpenEvent = mongoose.model('OpenEvent', openEventSchema);
const LinkClick = mongoose.model('LinkClick', linkClickSchema);
const User      = mongoose.model('User', userSchema);

// ─────────────── GOOGLE OAUTH ───────────────

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URL
);

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile'
];

// Step 1: Redirect user to Google consent screen
app.get('/auth/google', (req, res) => {
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent'
  });
  res.redirect(url);
});

// Step 2: Google redirects back with code
app.get('/auth/google/callback', async (req, res) => {
  try {
    const { code } = req.query;
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    // Get user info
    const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
    const { data: profile } = await oauth2.userinfo.get();

    // Save or update user
    let user = await User.findOne({ email: profile.email });
    if (!user) {
      user = new User({
        email: profile.email,
        name: profile.name,
        senderIPs: (process.env.SENDER_IPS || '').split(',').filter(Boolean)
      });
    }
    user.refreshToken = tokens.refresh_token || user.refreshToken;
    user.accessToken  = tokens.access_token;
    user.tokenExpiry  = new Date(tokens.expiry_date);
    await user.save();

    // Issue JWT
    const jwtToken = jwt.sign(
      { userId: user._id, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );

    // Redirect to frontend with token
    res.redirect(`/?token=${jwtToken}`);
  } catch (error) {
    console.error('OAuth error:', error);
    res.status(500).send('Authentication failed');
  }
});

// ─────────────── AUTH MIDDLEWARE ───────────────

async function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }
  try {
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.userId);
    if (!user) return res.status(401).json({ error: 'User not found' });
    req.user = user;

    // Refresh Google token
    oauth2Client.setCredentials({
      refresh_token: user.refreshToken,
      access_token: user.accessToken
    });

    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// ─────────────── HELPERS ───────────────

function generateId() {
  return crypto.randomBytes(16).toString('hex');
}

function parseUA(ua) {
  const parser = new UAParser(ua);
  const r = parser.getResult();
  return {
    browser: r.browser.name || 'Unknown',
    os:      r.os.name     || 'Unknown',
    device:  r.device.type || 'Desktop'
  };
}

function getIP(req) {
  return req.headers['x-forwarded-for']?.split(',')[0].trim()
    || req.socket.remoteAddress;
}

function isSender(ip, user) {
  if (!user) return false;
  const knownIPs = user.senderIPs || [];
  // Also match IPv6 localhost variants
  const senderSet = new Set([...knownIPs, '127.0.0.1', '::1', '::ffff:127.0.0.1']);
  return senderSet.has(ip);
}

// 1×1 transparent GIF (43 bytes)
const PIXEL_GIF = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'
);

// Wrap links in body HTML for click tracking
function wrapLinks(html, emailId, serverUrl) {
  const linkMap = [];
  const wrapped = html.replace(
    /href="(https?:\/\/[^"]+)"/gi,
    (match, url) => {
      const linkId = generateId();
      linkMap.push({ linkId, originalUrl: url, emailId });
      return `href="${serverUrl}/track/link/${linkId}"`;
    }
  );
  return { wrapped, linkMap };
}

// ─────────────── TRACKING ENDPOINTS (no auth) ───────────────

// PIXEL open tracking
app.get('/track/pixel/:trackingId', async (req, res) => {
  try {
    const { trackingId } = req.params;
    const email = await Email.findOne({ trackingId });

    if (email) {
      const ip = getIP(req);
      const user = await User.findOne({ email: email.senderEmail });
      const fromSender = isSender(ip, user);

      if (!fromSender) {
        await OpenEvent.create({
          emailId:        email._id,
          trackingId,
          userAgent:      req.headers['user-agent'],
          ipAddress:      ip,
          deviceInfo:     parseUA(req.headers['user-agent']),
          isFromSender:   false,
          trackingMethod: 'pixel'
        });
      }
    }
  } catch (e) {
    console.error('Pixel error:', e.message);
  }

  // Always return pixel — never reveal tracking status
  res.set({
    'Content-Type':  'image/gif',
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    'Pragma':        'no-cache',
    'Expires':       '0'
  });
  res.send(PIXEL_GIF);
});

// LINK click tracking
app.get('/track/link/:linkId', async (req, res) => {
  try {
    const { linkId } = req.params;
    const link = await LinkClick.findOne({ linkId });

    if (!link) return res.status(404).send('Link not found');

    const ip = getIP(req);
    const email = await Email.findById(link.emailId);
    const user = email ? await User.findOne({ email: email.senderEmail }) : null;
    const fromSender = isSender(ip, user);

    if (!fromSender) {
      // Log as both a link click update AND an open event
      link.clickedAt  = new Date();
      link.userAgent  = req.headers['user-agent'];
      link.ipAddress  = ip;
      link.deviceInfo = parseUA(req.headers['user-agent']);
      await link.save();

      await OpenEvent.create({
        emailId:        link.emailId,
        trackingId:     email?.trackingId,
        userAgent:      req.headers['user-agent'],
        ipAddress:      ip,
        deviceInfo:     parseUA(req.headers['user-agent']),
        isFromSender:   false,
        trackingMethod: 'link'
      });
    }

    res.redirect(link.originalUrl);
  } catch (e) {
    console.error('Link tracking error:', e.message);
    res.status(500).send('Error');
  }
});

// ─────────────── API ROUTES (auth required) ───────────────

// Get current user info
app.get('/api/me', authMiddleware, (req, res) => {
  res.json({
    email: req.user.email,
    name:  req.user.name,
    senderIPs: req.user.senderIPs
  });
});

// Update sender IPs (to exclude from tracking)
app.put('/api/me/ips', authMiddleware, async (req, res) => {
  const { ips } = req.body; // array of IP strings
  req.user.senderIPs = ips;
  await req.user.save();
  res.json({ success: true, senderIPs: req.user.senderIPs });
});

// Send tracked email
app.post('/api/send', authMiddleware, async (req, res) => {
  try {
    const { subject, body, recipients, trackLinks } = req.body;
    // recipients = [{ email, name }]

    const trackingId = generateId();
    const serverUrl  = process.env.SERVER_URL;
    const pixelUrl   = `${serverUrl}/track/pixel/${trackingId}`;

    // Process body: optionally wrap links
    let finalBody = body;
    let linkDocs  = [];

    if (trackLinks) {
      const { wrapped, linkMap } = wrapLinks(body, null, serverUrl);
      finalBody = wrapped;
      linkDocs  = linkMap;
    }

    // Append invisible tracking pixel
    finalBody += `<img src="${pixelUrl}" width="1" height="1" alt="" style="display:none!important;width:1px!important;height:1px!important;opacity:0!important;" />`;

    // Save email record
    const email = await Email.create({
      senderEmail: req.user.email,
      subject,
      recipients,
      bodyPlain:   body,
      trackingId,
      sentAt:      new Date(),
      status:      'sent'
    });

    // Save link click docs with emailId
    if (linkDocs.length) {
      for (const ld of linkDocs) {
        await LinkClick.create({
          emailId:     email._id,
          linkId:      ld.linkId,
          originalUrl: ld.originalUrl
        });
      }
    }

    // Build MIME message
    const toField = recipients.map(r => r.name ? `${r.name} <${r.email}>` : r.email).join(', ');

    const boundary = `boundary_${generateId()}`;
    const mime = [
      `From: ${req.user.name} <${req.user.email}>`,
      `To: ${toField}`,
      `Subject: ${subject}`,
      `MIME-Version: 1.0`,
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset="UTF-8"',
      '',
      body.replace(/<[^>]+>/g, ''),  // plain text fallback
      '',
      `--${boundary}`,
      'Content-Type: text/html; charset="UTF-8"',
      '',
      finalBody,
      '',
      `--${boundary}--`
    ].join('\r\n');

    const encoded = Buffer.from(mime)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
    const result = await gmail.users.messages.send({
      userId: 'me',
      requestBody: { raw: encoded }
    });

    email.gmailMessageId = result.data.id;
    await email.save();

    res.json({ success: true, emailId: email._id, trackingId });
  } catch (error) {
    console.error('Send error:', error);
    res.status(500).json({ error: error.message });
  }
});

// List all sent tracked emails
app.get('/api/emails', authMiddleware, async (req, res) => {
  try {
    const emails = await Email.find({ senderEmail: req.user.email })
      .sort({ sentAt: -1 });

    // Attach open counts
    const enriched = await Promise.all(emails.map(async (em) => {
      const openCount = await OpenEvent.countDocuments({
        emailId: em._id,
        isFromSender: false
      });
      const lastOpen = await OpenEvent.findOne({
        emailId: em._id,
        isFromSender: false
      }).sort({ openedAt: -1 });

      return {
        ...em.toObject(),
        openCount,
        lastOpenedAt: lastOpen?.openedAt || null
      };
    }));

    res.json(enriched);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Detailed analytics for one email
app.get('/api/emails/:id/analytics', authMiddleware, async (req, res) => {
  try {
    const email = await Email.findById(req.params.id);
    if (!email) return res.status(404).json({ error: 'Email not found' });

    const opens = await OpenEvent.find({
      emailId: email._id,
      isFromSender: false
    }).sort({ openedAt: 1 });

    const clicks = await LinkClick.find({ emailId: email._id });

    // Group opens by date for chart
    const opensByDate = {};
    opens.forEach(o => {
      const day = o.openedAt.toISOString().slice(0, 10);
      opensByDate[day] = (opensByDate[day] || 0) + 1;
    });

    // Device breakdown
    const devices = {};
    opens.forEach(o => {
      const key = `${o.deviceInfo.browser} / ${o.deviceInfo.os}`;
      devices[key] = (devices[key] || 0) + 1;
    });

    res.json({
      email: email.toObject(),
      totalOpens:  opens.length,
      uniqueIPs:   new Set(opens.map(o => o.ipAddress)).size,
      firstOpen:   opens[0]?.openedAt || null,
      lastOpen:    opens[opens.length - 1]?.openedAt || null,
      opens:       opens.map(o => ({
        openedAt:   o.openedAt,
        device:     o.deviceInfo,
        method:     o.trackingMethod,
        ip:         o.ipAddress
      })),
      opensByDate,
      devices,
      linkClicks: clicks.map(c => ({
        url:       c.originalUrl,
        clickedAt: c.clickedAt
      }))
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete an email and its tracking data
app.delete('/api/emails/:id', authMiddleware, async (req, res) => {
  try {
    await Email.findByIdAndDelete(req.params.id);
    await OpenEvent.deleteMany({ emailId: req.params.id });
    await LinkClick.deleteMany({ emailId: req.params.id });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Dashboard stats
app.get('/api/stats', authMiddleware, async (req, res) => {
  try {
    const totalEmails = await Email.countDocuments({ senderEmail: req.user.email });
    const totalOpens  = await OpenEvent.countDocuments({ isFromSender: false });
    const totalClicks = await LinkClick.countDocuments();

    // Emails with at least one open
    const emailIds = await Email.find({ senderEmail: req.user.email }).distinct('_id');
    const openedEmailIds = await OpenEvent.find({
      emailId: { $in: emailIds },
      isFromSender: false
    }).distinct('emailId');

    res.json({
      totalEmails,
      totalOpens,
      totalClicks,
      openRate: totalEmails ? Math.round((openedEmailIds.length / totalEmails) * 100) : 0
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─────────────── SERVE FRONTEND ───────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

// ─────────────── START ───────────────
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`\n🚀 Email Tracker running at http://localhost:${PORT}`);
  console.log(`📧 Login at http://localhost:${PORT}/auth/google\n`);
});
