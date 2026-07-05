require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const { verifyWebhook, processWebhook, instagramClient } = require('./webhook-handler');

const app = express();
const PORT = process.env.PORT || 3000;

// Enable raw body parser for signature validation
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf.toString();
  }
}));

// Webhook Routes
app.get('/webhook', verifyWebhook);
app.post('/webhook', processWebhook);

// Basic health check route
app.get('/', (req, res) => {
  res.send('Instagram Reel Timetable Bot is running 🚀');
});

// Database and Server Initialization
async function startServer() {
  try {
    const mongoUri = process.env.MONGO_URI || 'mongodb://localhost:27017/timetable-bot';
    console.log('[SERVER] Connecting to MongoDB...');
    await mongoose.connect(mongoUri);
    console.log('[SERVER] Connected to MongoDB successfully');

    // Initialize Instagram Client
    console.log('[SERVER] Initializing Instagram client...');
    await instagramClient.init();

    app.listen(PORT, () => {
      console.log(`[SERVER] Express server listening on port ${PORT}`);
    });
  } catch (error) {
    console.error('[SERVER] Critical error starting server:', error);
    process.exit(1);
  }
}

// Global error handlers
process.on('unhandledRejection', (reason, promise) => {
  console.error('[SERVER] Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('[SERVER] Uncaught Exception:', error);
});

startServer();
