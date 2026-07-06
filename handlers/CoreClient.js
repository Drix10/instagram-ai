const User = require('../Models/User');
const ReelNote = require('../Models/ReelNote');

const PROFILE_CACHE_MAX = 500; 
const PROFILE_CACHE_TTL = 3600000; 
const ACTIVE_PROCESSING_TTL = 5 * 60 * 1000; 

class CoreClient {
  constructor() {
    this.prefix = process.env.PREFIX || '!';
    this.commands = new Map();
    this.profileCache = new Map();
    this.activeProcessing = new Map(); 
    this.initialized = false;
  }

  async init() {
    if (this.initialized) {
      return;
    }
    this.initialized = true;

    try {
      console.log('[INSTAGRAM] Instagram client initializing...');

      const CommandHandler = require('./CommandHandler');
      this.commandHandler = new CommandHandler(this);
      await this.commandHandler.loadCommands();

      const RateLimiter = require('../utils/rate-limiter.js');
      this.rateLimiter = new RateLimiter(10);

      const MessageHandler = require('./MessageHandler');
      this.messageHandler = new MessageHandler(this);

      const ApiHandler = require('./ApiHandler');
      this.apiHandler = new ApiHandler(this);

      const AIHandler = require('./AIHandler');
      this.aiHandler = new AIHandler(this);
      this.geminiHandler = this.aiHandler; // Backward compatibility

      const isValid = await this.apiHandler.verifyToken();
      if (!isValid) {
        console.error('[INSTAGRAM] Token validation failed. Some functionality may not work properly.');
      } else {
        console.log('[INSTAGRAM] Token validation successful. Ready to process messages.');
      }

      this.startReminderAlertLoop();
    } catch (error) {
      console.error('[INSTAGRAM] Error during initialization:', error);
    }
  }

  isProcessing(url) {
    if (!this.activeProcessing.has(url)) return false;
    const startedAt = this.activeProcessing.get(url);
    if (Date.now() - startedAt > ACTIVE_PROCESSING_TTL) {
      
      console.warn(`[CORE] Evicting stale activeProcessing entry for URL (${Math.round((Date.now() - startedAt) / 1000)}s old)`);
      this.activeProcessing.delete(url);
      return false;
    }
    return true;
  }

  markProcessing(url) {
    this.activeProcessing.set(url, Date.now());
  }

  clearProcessing(url) {
    this.activeProcessing.delete(url);
  }

  getCachedProfile(userId) {
    if (!this.profileCache.has(userId)) return null;
    const entry = this.profileCache.get(userId);
    if (Date.now() - entry.timestamp > PROFILE_CACHE_TTL) {
      this.profileCache.delete(userId);
      return null;
    }
    return entry.data;
  }

  setCachedProfile(userId, data) {
    
    if (this.profileCache.size >= PROFILE_CACHE_MAX && !this.profileCache.has(userId)) {
      const oldestKey = this.profileCache.keys().next().value;
      this.profileCache.delete(oldestKey);
    }
    this.profileCache.set(userId, { data, timestamp: Date.now() });
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

  startReminderAlertLoop() {
    console.log('[REMINDERS] Starting background scheduler loop checks...');
    
    const checkScheduler = async () => {
      try {
        const now = new Date();

        const usersWithReminders = await User.find({
          'reminders.time': { $lte: now },
          'reminders.active': true
        });

        for (const user of usersWithReminders) {
          let updated = false;
          for (const reminder of user.reminders) {
            if (reminder.active && reminder.time <= now) {
              console.log(`[REMINDERS] Triggering reminder alert for user ${user.instagramId}: "${reminder.activity}"`);
              
              await this.sendMessage(
                user.instagramId,
                `⏰ 【REMINDER ALERT】 ⏰\n\nHey! Time for your scheduled activity:\n📚 *${reminder.activity}*\n\nLet's get it done! ⚡️`
              ).catch(err => {
                console.error(`[REMINDERS] Failed to send reminder DM to ${user.instagramId}:`, err.message);
              });

              if (reminder.repeat === 'daily') {
                let nextTime = new Date(reminder.time.getTime() + 24 * 60 * 60 * 1000);
                while (nextTime <= now) {
                  nextTime = new Date(nextTime.getTime() + 24 * 60 * 60 * 1000);
                }
                reminder.time = nextTime;
              } else if (reminder.repeat === 'weekly') {
                let nextTime = new Date(reminder.time.getTime() + 7 * 24 * 60 * 60 * 1000);
                while (nextTime <= now) {
                  nextTime = new Date(nextTime.getTime() + 7 * 24 * 60 * 60 * 1000);
                }
                reminder.time = nextTime;
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

        const usersWithDeadlines = await User.find({
          'blockers.endDate': { $lte: now },
          'blockers.notified': false
        });

        for (const user of usersWithDeadlines) {
          const completedDeadlineNames = [];
          let updated = false;

          for (const blocker of user.blockers) {
            if (!blocker.notified && blocker.endDate <= now) {
              console.log(`[DEADLINE] Deadline "${blocker.name}" reached for user ${user.instagramId}. Staging notification.`);
              blocker.notified = true;
              completedDeadlineNames.push(blocker.name);
              updated = true;
            }
          }

          if (updated) {
            await user.save();

            const savedNotes = await ReelNote.find({ 
              instagramId: user.instagramId, 
              saved: true 
            }).sort({ savedAt: -1 }).limit(3);

            let endMsg = `📅 【DEADLINE COMPLETED】 📅\n\n` +
              `You have reached the following deadline milestones:\n` +
              completedDeadlineNames.map(name => `• *${name}*`).join('\n') +
              `\n\nAwesome job keeping up with your tasks! 🚀🎉\n\n`;

            if (savedNotes.length > 0) {
              endMsg += `Here are your saved learning resources to refer to:\n\n`;
              savedNotes.forEach((note, index) => {
                endMsg += `${index + 1}. *${note.title}* (${note.category || 'resource'})\n` +
                  `   💡 Summary: ${note.summary.length > 120 ? note.summary.substring(0, 117) + '...' : note.summary}\n\n`;
              });
              endMsg += `💡 Type "!notes" to view full references.`;
            } else {
              endMsg += `Send messages or share educational Reels here to keep mapping your learning routine! 📲📚`;
            }

            await this.sendMessage(user.instagramId, endMsg).catch(err => {
              console.error(`[DEADLINE] Failed to send deadline completion DM to ${user.instagramId}:`, err.message);
            });
          }
        }

      } catch (error) {
        console.error('[REMINDERS] Error in scheduler checks loop:', error);
      } finally {
        setTimeout(checkScheduler, 60 * 1000);
      }
    };

    checkScheduler();
  }
}

module.exports = CoreClient;