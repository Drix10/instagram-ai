const User = require('../Models/User');
const ReelNote = require('../Models/ReelNote');

class MessageHandler {
  constructor(client) {
    this.client = client;
    this.userQueues = new Map(); // userId -> Array of messages (Per-user sequential queuing)
  }

  async processMessage(message) {
    const userId = message.sender.id;

    // Retrieve or create a message queue for this specific user
    if (!this.userQueues.has(userId)) {
      this.userQueues.set(userId, []);
      this.userQueues.get(userId).push(message);
      
      // Start async processing loop for this user
      setImmediate(() => this.processUserQueue(userId));
    } else {
      const queue = this.userQueues.get(userId);
      // Enforce a sensible queue buffer limit per user to protect memory (e.g., 50 pending messages per user)
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

    // Peek at the first message in the queue
    const message = queue[0];

    try {
      await this._processMessage(message);
    } catch (error) {
      console.error(`[MESSAGE_ROUTER] Error processing message for user ${userId}:`, error);
      try {
        await this.client.sendMessage(userId, 'An error occurred while processing your message.');
      } catch (e) {}
    } finally {
      // Remove the message we just processed
      queue.shift();
      
      // Schedule the next message for this user recursively
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

    // 1. Ensure user profile exists in database
    let user = await User.findOne({ instagramId });
    if (!user) {
      user = new User({
        instagramId,
        username: message.sender.username || 'user'
      });
      await user.save();
    }

    // 2. Handle Shared Reel processing
    if (message.reelUrl) {
      if (this.client.activeProcessing.has(message.reelUrl)) {
        console.log(`[MESSAGE_ROUTER] Reel URL is already being processed: ${message.reelUrl}`);
        return;
      }
      this.client.activeProcessing.add(message.reelUrl);

      try {
        await this.client.sendMessage(
          instagramId,
          "📥 Reel received! Downloading and transcribing using Gemini AI... This can take 15-30 seconds. 🤖🎥"
        );

        const parsed = await this.client.geminiHandler.transcribeReel(instagramId, message.reelUrl);
        
        // Save the raw note
        const note = new ReelNote({
          instagramId,
          reelUrl: message.reelUrl,
          title: parsed.title,
          summary: parsed.summary,
          category: parsed.category || 'note',
          workoutDetails: parsed.workoutDetails,
          timetableSuggestions: parsed.timetableSuggestions
        });
        await note.save();

        // Print transcription card
        let details = `📝 【REEL NOTES】 📝\n\n` +
          `📌 Topic: ${parsed.title}\n` +
          `📂 Category: ${parsed.category?.toUpperCase() || 'NOTE'}\n\n` +
          `💡 Summary:\n${parsed.summary}\n`;

        if (parsed.category === 'workout' && parsed.workoutDetails?.exercises?.length > 0) {
          details += `\n💪 Exercises Extracted:\n`;
          parsed.workoutDetails.exercises.forEach(ex => {
            const setsStr = ex.sets > 0 ? `${ex.sets} sets` : '';
            const repsStr = ex.reps > 0 ? `${ex.reps} reps` : '';
            const spec = [setsStr, repsStr].filter(x => x).join(' x ');
            const noteStr = ex.notes ? ` (${ex.notes})` : '';
            details += `• ${ex.name} ${spec ? `- ${spec}` : ''}${noteStr}\n`;
          });
        }

        await this.client.sendMessage(instagramId, details);

        // Send action buttons
        await this.client.sendButtonTemplate(
          instagramId,
          `Would you like to save this to your routine?`,
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
        this.client.activeProcessing.delete(message.reelUrl);
      }
      return;
    }

    // 3. Handle standard text commands vs AI conversations
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

    // 4. NLP Chatbot Mode - Route direct conversation to Gemini Assistant
    if (text.length > 0) {
      try {
        const response = await this.client.geminiHandler.generateChatResponse(
          user.timetable,
          [], 
          text
        );
        await this.client.sendMessage(instagramId, response);
      } catch (chatErr) {
        console.error('[MESSAGE_ROUTER] Gemini Chatbot failed:', chatErr);
      }
    }
  }
}

module.exports = MessageHandler;