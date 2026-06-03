# MailPulse — Setup Guide

## Prerequisites

- **Node.js** (v18 or above)
- **MongoDB** running locally OR a MongoDB Atlas (free tier) connection string
- A **Google account** (Gmail)

---

## Step 1: Google Cloud Console Setup

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project → name it **"MailPulse"**
3. Enable these APIs:
   - **Gmail API** (search in the API Library)
   - **Google People API** (for profile info)
4. Go to **Credentials** → **Create Credentials** → **OAuth 2.0 Client ID**
   - Application type: **Web application**
   - Authorized redirect URIs: `http://localhost:5000/auth/google/callback`
5. Copy the **Client ID** and **Client Secret**
6. Go to **OAuth consent screen**:
   - User type: **External**
   - Add your Gmail to **Test users** (while in testing mode)
   - Add scopes: `gmail.send`, `gmail.readonly`, `userinfo.email`, `userinfo.profile`

---

## Step 2: Install & Configure

```bash
cd email-tracker/backend

# Install dependencies
npm install

# Create your .env file
cp .env.example .env
```

Edit `.env` with your values:

```env
MONGODB_URI=mongodb://localhost:27017/email-tracker
PORT=5000
SERVER_URL=http://localhost:5000

GOOGLE_CLIENT_ID=paste-your-client-id
GOOGLE_CLIENT_SECRET=paste-your-client-secret
GOOGLE_REDIRECT_URL=http://localhost:5000/auth/google/callback

JWT_SECRET=any-long-random-string-here
SENDER_IPS=127.0.0.1
SENDER_EMAIL=your-email@gmail.com
```

---

## Step 3: Run

```bash
# Make sure MongoDB is running, then:
npm run dev
```

Open **http://localhost:5000** in your browser.

- Click **"Sign in with Google"**
- Grant Gmail permissions
- You'll be redirected back to the dashboard

---

## Step 4: Add Your IP to Exclusion List

1. Go to **Settings** in the sidebar
2. Your current public IP is auto-detected
3. Click **"Add This IP"** to exclude it from tracking
4. Any email you open yourself won't be counted

---

## How Tracking Works

### Pixel Tracking (automatic)
Every email gets an invisible 1×1 pixel appended:
```html
<img src="https://yourserver.com/track/pixel/abc123..."
     width="1" height="1"
     style="display:none!important;" />
```
When the recipient's mail client loads images, it pings your server.

### Link Tracking (toggle in compose)
Links in the body get wrapped:
```
Original: https://example.com/report.pdf
Tracked:  https://yourserver.com/track/link/def456...
```
When clicked → server logs the click → redirects to original URL.

### Sender Exclusion
Your own IPs are checked on every pixel/link hit:
- Match → silently ignored, not recorded
- No match → recorded as a genuine open

---

## For Production Deployment

### You'll Need:
1. **A domain with HTTPS** (tracking pixels MUST be served over HTTPS)
   - Use Railway, Render, or Heroku for free hosting
   - Or any VPS with Let's Encrypt SSL

2. **Update these values:**
   - `.env` → `SERVER_URL=https://yourdomain.com`
   - Google Console → Add `https://yourdomain.com/auth/google/callback` to redirect URIs

3. **MongoDB Atlas** (free tier):
   - Create cluster at [mongodb.com/atlas](https://www.mongodb.com/atlas)
   - Update `MONGODB_URI` in `.env`

### Deployment on Render (free):
```bash
# Push to GitHub, then on Render:
# 1. New Web Service → connect repo
# 2. Build command: cd backend && npm install
# 3. Start command: cd backend && node server.js
# 4. Add all .env variables in Render dashboard
```

### Deployment on Railway:
```bash
# Push to GitHub, then on Railway:
# 1. New Project → Deploy from GitHub
# 2. Add .env variables
# 3. Railway provides automatic HTTPS domain
```

---

## Important Notes

1. **Gmail "Less Secure Apps"** is NOT needed — we use OAuth 2.0
2. **Image blocking**: Some email clients (Outlook, Apple Mail) may block images by default.
   If images are blocked, pixel tracking won't fire until the user clicks "Load images".
   Link tracking still works regardless.
3. **Google consent screen in Testing mode**: Only your test users can log in.
   To go public, submit for verification (or keep it personal).
4. **Privacy**: This is for personal use. Always be aware of local privacy laws
   when tracking emails (GDPR, CAN-SPAM, etc.).

---

## Folder Structure

```
email-tracker/
├── backend/
│   ├── server.js          # Express server with all routes
│   ├── package.json       # Dependencies
│   ├── .env.example       # Environment template
│   └── .env               # Your actual config (git-ignored)
│
└── frontend/
    └── index.html         # Complete dashboard (HTML/CSS/JS)
```
