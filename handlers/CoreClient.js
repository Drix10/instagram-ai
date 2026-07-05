const User = require('../Models/User');
const ReelNote = require('../Models/ReelNote');

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

      // Start background reminder & blocker check alert loop
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

  // Periodic MongoDB query check to trigger due reminders and completed exam blocker notifications.
  // Uses recursive setTimeout instead of setInterval to avoid overlapping queries.
  startReminderAlertLoop() {
    console.log('[REMINDERS] Starting background scheduler loop checks...');
    
    const checkScheduler = async () => {
      try {
        const now = new Date();

        // Part 1: Process Due Reminders
        const usersWithReminders = await User.find({
          'reminders.time': { $lte: now },
          'reminders.active': true
        });

        for (const user of usersWithReminders) {
          let updated = false;
          for (const reminder of user.reminders) {
            if (reminder.active && reminder.time <= now) {
              console.log(`[REMINDERS] Triggering reminder alert for user ${user.instagramId}: "${reminder.activity}"`);
              
              // Send alert message in DMs
              await this.sendMessage(
                user.instagramId,
                `⏰ 【REMINDER ALERT】 ⏰\n\nHey! Time for your scheduled activity:\n📚 *${reminder.activity}*\n\nLet's get it done! ⚡️`
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

        // Part 2: Process Finished Blockers / Exams
        // Find users who have at least one blocker that has ended and hasn't been notified
        const usersWithExams = await User.find({
          'blockers.endDate': { $lte: now },
          'blockers.notified': false
        });

        for (const user of usersWithExams) {
          const completedBlockerNames = [];
          let updated = false;

          for (const blocker of user.blockers) {
            if (!blocker.notified && blocker.endDate <= now) {
              console.log(`[BLOCKER] Blocker "${blocker.name}" completed for user ${user.instagramId}. Staging notification.`);
              blocker.notified = true;
              completedBlockerNames.push(blocker.name);
              updated = true;
            }
          }

          if (updated) {
            await user.save();

            // Find up to 3 saved learning resources/notes this user wanted to refer to
            const savedNotes = await ReelNote.find({ 
              instagramId: user.instagramId, 
              saved: true 
            }).sort({ savedAt: -1 }).limit(3);

            let endMsg = `🎓 【DEADLINE / EXAM NOTIFICATION】 🎓\n\n` +
              `Woohoo! You are done with:\n` +
              completedBlockerNames.map(name => `• *${name}*`).join('\n') +
              `\n\nYou can finally start learning something new! 🚀🎉\n\n`;

            if (savedNotes.length > 0) {
              endMsg += `Here are the learning resources you saved to refer to:\n\n`;
              savedNotes.forEach((note, index) => {
                endMsg += `${index + 1}. *${note.title}* (${note.category || 'resource'})\n` +
                  `   💡 Summary: ${note.summary.length > 120 ? note.summary.substring(0, 117) + '...' : note.summary}\n\n`;
              });
              endMsg += `💡 Type "!notes" to view full references.`;
            } else {
              endMsg += `Share educational Reels here to transcribe and save resources to your study board! 📲📚`;
            }

            await this.sendMessage(user.instagramId, endMsg).catch(err => {
              console.error(`[BLOCKER] Failed to send blocker completion DM to ${user.instagramId}:`, err.message);
            });
          }
        }

      } catch (error) {
        console.error('[REMINDERS] Error in scheduler checks loop:', error);
      } finally {
        // Schedule the next check in 60 seconds, ensuring no overlapping queries
        setTimeout(checkScheduler, 60 * 1000);
      }
    };

    // Run the first check after 60 seconds
    setTimeout(checkScheduler, 60 * 1000);
  }
}

module.exports = CoreClient;