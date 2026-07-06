require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const { verifyWebhook, processWebhook, instagramClient } = require('./webhook-handler');

const app = express();
const trustProxyEnv = process.env.TRUST_PROXY;
const trustProxyValue = (trustProxyEnv !== undefined && !isNaN(parseInt(trustProxyEnv, 10))) ? parseInt(trustProxyEnv, 10) : 1;
app.set('trust proxy', trustProxyValue);
const PORT = process.env.PORT || 3000;

app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf.toString();
  }
}));

app.get('/webhook', verifyWebhook);
app.post('/webhook', processWebhook);

app.get('/', (req, res) => {
  res.send('Instagram Reel Timetable Bot is running 🚀');
});

const crypto = require('crypto');

function checkChallengeAuth(req, res, next) {
  const token = process.env.IG_CHALLENGE_TOKEN;
  if (!token || token.trim() === '') {
    return res.status(500).json({ error: 'Server configuration error: IG_CHALLENGE_TOKEN is not configured.' });
  }

  const authToken = req.query.token || req.headers['x-challenge-token'];
  if (!authToken || typeof authToken !== 'string') {
    return res.status(401).json({ error: 'Unauthorized: Missing token.' });
  }

  const tokenBuf = Buffer.from(token);
  const authBuf = Buffer.from(authToken);
  if (tokenBuf.length !== authBuf.length || !crypto.timingSafeEqual(tokenBuf, authBuf)) {
    return res.status(401).json({ error: 'Unauthorized: Invalid token.' });
  }
  next();
}

app.all('/ig/session/import', checkChallengeAuth, async (req, res) => {
  const cookies = req.query.cookies || (req.body && req.body.cookies);
  if (!cookies) {
    return res.status(400).json({ error: 'Cookies query parameter or body value is required.' });
  }
  try {
    const igDownloader = require('./utils/instagram-downloader');
    const result = await igDownloader.importCookies(cookies);
    res.json(result);
  } catch (error) {
    console.error('[SERVER] Importing Instagram cookies failed:', error);
    res.status(500).json({ error: error.message });
  }
});

async function startServer() {
  try {
    const mongoUri = process.env.MONGO_URI || 'mongodb://localhost:27017/timetable-bot';
    console.log('[SERVER] Connecting to MongoDB...');
    await mongoose.connect(mongoUri);
    console.log('[SERVER] Connected to MongoDB successfully');

    console.log('[SERVER] Initializing Instagram client...');
    await instagramClient.init();

    console.log('[SERVER] Enabling page subscriptions...');
    const { enablePageSubscriptions } = require('./webhook-handler');
    await enablePageSubscriptions();

    app.listen(PORT, () => {
      console.log(`[SERVER] Express server listening on port ${PORT}`);
    });
  } catch (error) {
    console.error('[SERVER] Critical error starting server:', error);
    process.exit(1);
  }
}

process.on('unhandledRejection', (reason, promise) => {
  console.error('[SERVER] Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('[SERVER] Uncaught Exception:', error);
});

startServer();
