const User = require('../Models/User');
const ReelNote = require('../Models/ReelNote');

class MessageHandler {
  constructor(client) {
    this.client = client;
    this.processingQueue = [];
    this.isProcessing = false;
  }

  async processMessage(message) {
    if (this.processingQueue.length < 100) {
      this.processingQueue.push(message);
      setImmediate(() => this.processNextInQueue());
      return true;
    } else {
      console.warn(`[INSTAGRAM] Message queue full, dropping message from ${message.sender?.id}`);
      this.client.sendMessage(
        message.sender.id,
        "System is experiencing high traffic. Please try again in a moment."
      ).catch(() => { });
      return false;
    }
  }

  async processNextInQueue() {
    if (this.isProcessing || this.processingQueue.length === 0) return;

    this.isProcessing = true;
    const message = this.processingQueue.shift();

    try {
      await this._processMessage(message);
    } catch (error) {
      console.error('[INSTAGRAM] Error processing Instagram message:', error);
      try {
        this.client.sendMessage(message.sender.id, 'An error occurred while processing your message.');
      } catch (e) { }
    } finally {
      this.isProcessing = false;
      if (this.processingQueue.length > 0) {
        setImmediate(() => this.processNextInQueue());
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
      // Parse command name and arguments
      let commandName;
      let args = [];

      let cleanText = text;
      if (cleanText.startsWith(this.client.prefix)) {
        cleanText = cleanText.substring(this.client.prefix.length);
      }

      // Check if command has parameter payload split (e.g. save_note:id)
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
        // Show typing indicator or friendly placeholder
        const response = await this.client.geminiHandler.generateChatResponse(
          user.timetable,
          [], // Conversational history can be added here
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