const User = require('../Models/User');
const ReelNote = require('../Models/ReelNote');
const axios = require('axios');

class MessageHandler {
  constructor(client) {
    this.client = client;
    this.userQueues = new Map();
  }

  async processMessage(message) {
    const userId = message.sender.id;

    if (this.client.rateLimiter && !this.client.rateLimiter.canProcess(userId)) {
      console.warn(`[MESSAGE_ROUTER] User ${userId} exceeded rate limit. Dropping message.`);
      this.client.sendMessage(
        userId,
        "⚠️ You are sending messages too quickly. Please wait a moment! ⏳"
      ).catch(() => {});
      return false;
    }

    if (!this.userQueues.has(userId)) {
      this.userQueues.set(userId, [message]);
      setImmediate(() => this.processUserQueue(userId));
    } else {
      const queue = this.userQueues.get(userId);
      if (queue.length < 50) {
        queue.push(message);
      } else {
        console.warn(`[MESSAGE_ROUTER] Per-user queue full for ${userId}. Dropping message.`);
        this.client.sendMessage(
          userId,
          "Please slow down. You are sending messages too quickly! ⏳"
        ).catch(() => {});
      }
    }
    return true;
  }

  async processUserQueue(userId) {
    const queue = this.userQueues.get(userId);
    if (!queue || queue.length === 0) {
      this.userQueues.delete(userId);
      return;
    }

    const message = queue[0];

    try {
      await this._processMessage(message);
    } catch (error) {
      console.error(`[MESSAGE_ROUTER] Error processing message for user ${userId}:`, error);
      try {
        await this.client.sendMessage(userId, 'An error occurred while processing your message.');
      } catch (e) {}
    } finally {
      queue.shift();
      
      if (queue.length > 0) {
        setImmediate(() => this.processUserQueue(userId));
      } else {
        this.userQueues.delete(userId);
      }
    }
  }

  async _processMessage(message) {
    if (message.is_echo === true) {
      return;
    }

    const isPostback = message.isPostback === true;
    const instagramId = message.sender.id;

    let user = await User.findOne({ instagramId });
    if (!user) {
      user = new User({
        instagramId,
        username: message.sender.username || 'user'
      });
      await user.save();
    }

    if (message.reelUrl) {
      if (this.client.isProcessing(message.reelUrl)) {
        console.log(`[MESSAGE_ROUTER] Reel URL is already being processed: ${message.reelUrl}`);
        await this.client.sendMessage(
          instagramId,
          "⏳ This Reel is already being analyzed. Please wait for the results!"
        ).catch(() => {});
        return;
      }
      this.client.markProcessing(message.reelUrl);

      try {
        await this.client.sendMessage(
          instagramId,
          "📥 Reel received! Analyzing contents using Gemini AI... 🤖🎥"
        );

        let reelCaptionText = message.reelCaption;
        if (!reelCaptionText && message.reelUrl) {
          try {
            console.log(`[MESSAGE_ROUTER] Webhook caption missing. Fetching caption from oEmbed for: ${message.reelUrl}`);
            const oembedRes = await axios.get(
              `https://www.instagram.com/api/v1/oembed/?url=${encodeURIComponent(message.reelUrl)}`,
              { timeout: 8000 }
            );
            if (oembedRes.data && oembedRes.data.title) {
              reelCaptionText = oembedRes.data.title;
              console.log(`[MESSAGE_ROUTER] Extracted caption via oEmbed successfully`);
            }
          } catch (oembedErr) {
            console.warn(`[MESSAGE_ROUTER] Failed to fetch oEmbed caption: ${oembedErr.message}`);
          }
        }

        const parsed = await this.client.geminiHandler.transcribeReel(instagramId, message.reelUrl, reelCaptionText);
        
        const note = new ReelNote({
          instagramId,
          reelUrl: message.reelUrl,
          title: parsed.title,
          summary: parsed.summary,
          category: parsed.category || 'resource',
          resourceDetails: parsed.resourceDetails,
          timetableSuggestions: parsed.timetableSuggestions
        });
        await note.save();

        let details = `📝 【REEL NOTES】 📝\n\n` +
          `📌 Topic: ${parsed.title}\n` +
          `📂 Category: ${parsed.category?.toUpperCase() || 'RESOURCE'}\n\n` +
          `💡 Summary:\n${parsed.summary}\n`;

        if (parsed.resourceDetails?.resources?.length > 0) {
          details += `\n📦 Resources & Steps Extracted:\n`;
          parsed.resourceDetails.resources.forEach(res => {
            const typeStr = res.type ? ` [${res.type}]` : '';
            const descStr = res.description ? `: ${res.description}` : '';
            details += `• *${res.name}*${typeStr}${descStr}\n`;
          });
        }

        await this.client.sendMessage(instagramId, details);

        await this.client.sendButtonTemplate(
          instagramId,
          `Would you like to save this to your timetable?`,
          {
            buttons: [
              {
                type: 'postback',
                title: '📂 Save to Notes',
                payload: `${this.client.prefix}save_note:${note._id}`
              },
              {
                type: 'postback',
                title: '📅 Add to Timetable',
                payload: `${this.client.prefix}add_timetable:${note._id}`
              },
              {
                type: 'postback',
                title: '🔔 Set Reminder',
                payload: `${this.client.prefix}set_reminder:${note._id}`
              }
            ]
          }
        );
      } catch (error) {
        console.error('[MESSAGE_ROUTER] Error processing shared Reel:', error);
        await this.client.sendMessage(
          instagramId,
          `❌ Failed to analyze Reel: ${error.message || 'Unknown processing error'}. Please try again.`
        );
      } finally {
        this.client.clearProcessing(message.reelUrl);
      }
      return;
    }

    const text = message.text.trim();

    if (text.startsWith(this.client.prefix) || isPostback) {
      let commandName;
      let args = [];

      let cleanText = text;
      if (cleanText.startsWith(this.client.prefix)) {
        cleanText = cleanText.substring(this.client.prefix.length);
      }

      if (cleanText.includes(':')) {
        const parts = cleanText.split(':');
        commandName = parts[0].toLowerCase();
        args = parts.slice(1);
      } else {
        args = cleanText.split(/ +/);
        commandName = args.shift().toLowerCase();
      }

      const command = this.client.commands.get(commandName);
      if (command) {
        await command.execute(this.client, message, args);
        return;
      }
    }

    if (text.length > 0) {
      try {
        const response = await this.client.geminiHandler.generateChatResponse(
          user.timetable,
          [], 
          text,
          user.blockers
        );
        await this.client.sendMessage(instagramId, response);
      } catch (chatErr) {
        console.error('[MESSAGE_ROUTER] Gemini Chatbot failed:', chatErr);
      }
    }
  }
}

module.exports = MessageHandler;