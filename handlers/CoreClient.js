const User = require('../Models/User');

class CoreClient {
  constructor() {
    this.prefix = process.env.PREFIX || '!';
    this.commands = new Map();
    this.profileCache = new Map();
    this.activeProcessing = new Set(); // Prevent concurrent webhook retry processing
    this.initialized = false;
  }

  async init() {
    // Initialization guard to prevent double execution (e.g., from index.js and webhook-handler.js IIFE)
    if (this.initialized) {
      return;
    }
    this.initialized = true;

    try {
      console.log('[INSTAGRAM] Instagram client initializing...');

      // Load command handler
      const CommandHandler = require('./CommandHandler');
      this.commandHandler = new CommandHandler(this);
      await this.commandHandler.loadCommands();

      // Load rate limiter
      const RateLimiter = require('../utils/rate-limiter.js');
      this.rateLimiter = new RateLimiter(10); // 10% buffer

      // Load message handler
      const MessageHandler = require('./MessageHandler');
      this.messageHandler = new MessageHandler(this);

      // Load API handler
      const ApiHandler = require('./ApiHandler');
      this.apiHandler = new ApiHandler(this);

      // Load Gemini AI handler
      const GeminiHandler = require('./GeminiHandler');
      this.geminiHandler = new GeminiHandler(this);

      const isValid = await this.apiHandler.verifyToken();
      if (!isValid) {
        console.error('[INSTAGRAM] Token validation failed. Some functionality may not work properly.');
      } else {
        console.log('[INSTAGRAM] Token validation successful. Ready to process messages.');
      }

      // Start background reminder alert loop
      this.startReminderAlertLoop();
    } catch (error) {
      console.error('[INSTAGRAM] Error during initialization:', error);
    }
  }

  async processMessage(message) {
    return await this.messageHandler.processMessage(message);
  }

  async getProfileInfo(userId) {
    return await this.apiHandler.getProfileInfo(userId);
  }

  async replyToComment(mediaId, commentId, text) {
    return await this.apiHandler.replyToComment(mediaId, commentId, text);
  }

  async sendMessage(recipientId, text) {
    return await this.apiHandler.sendMessage(recipientId, text);
  }

  async sendImage(recipientId, imageUrl, caption = '') {
    return await this.apiHandler.sendImage(recipientId, imageUrl, caption);
  }

  async sendButtonTemplate(recipientId, title, options = {}) {
    return await this.apiHandler.sendButtonTemplate(recipientId, title, options);
  }

  async sendCarouselTemplate(recipientId, elements = []) {
    return await this.apiHandler.sendCarouselTemplate(recipientId, elements);
  }

  // Periodic MongoDB query check to trigger due reminders.
  // Uses recursive setTimeout instead of setInterval to avoid overlapping queries.
  startReminderAlertLoop() {
    console.log('[REMINDERS] Starting background reminder alerts check...');
    
    const checkReminders = async () => {
      try {
        const now = new Date();
        // Find users with active reminders that are due
        const users = await User.find({
          'reminders.time': { $lte: now },
          'reminders.active': true
        });

        for (const user of users) {
          let updated = false;
          for (const reminder of user.reminders) {
            if (reminder.active && reminder.time <= now) {
              console.log(`[REMINDERS] Triggering reminder alert for user ${user.instagramId}: "${reminder.activity}"`);
              
              // Send alert message in DMs
              await this.sendMessage(
                user.instagramId,
                `⏰ 【REMINDER ALERT】 ⏰\n\nHey! Time to do your scheduled activity:\n💪 *${reminder.activity}*\n\nLet's get it done! ⚡️`
              ).catch(err => {
                console.error(`[REMINDERS] Failed to send reminder DM to ${user.instagramId}:`, err.message);
              });

              // Adjust reminder if repeating or mark inactive
              if (reminder.repeat === 'daily') {
                reminder.time = new Date(reminder.time.getTime() + 24 * 60 * 60 * 1000);
              } else if (reminder.repeat === 'weekly') {
                reminder.time = new Date(reminder.time.getTime() + 7 * 24 * 60 * 60 * 1000);
              } else {
                reminder.active = false;
              }
              updated = true;
            }
          }
          if (updated) {
            await user.save();
          }
        }
      } catch (error) {
        console.error('[REMINDERS] Error checking active reminders loop:', error);
      } finally {
        // Schedule the next check in 60 seconds, ensuring no overlapping queries
        setTimeout(checkReminders, 60 * 1000);
      }
    };

    // Run the first check after 60 seconds
    setTimeout(checkReminders, 60 * 1000);
  }
}

module.exports = CoreClient;