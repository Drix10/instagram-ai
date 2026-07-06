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

        const parsed = await this.client.aiHandler.transcribeReel(instagramId, message.reelUrl, reelCaptionText);
        
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
        const response = await this.client.aiHandler.generateChatResponse(
          user.timetable,
          [], 
          text,
          user.blockers
        );

        let replyText = response;
        let action = 'none';
        let actionData = {};

        try {
          let cleanResponse = response.trim();
          if (cleanResponse.startsWith('```')) {
            const match = cleanResponse.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
            if (match && match[1]) {
              cleanResponse = match[1].trim();
            }
          }
          const parsed = JSON.parse(cleanResponse);
          replyText = parsed.reply || response;
          action = parsed.action || 'none';
          actionData = parsed.actionData || {};
        } catch (jsonErr) {
          // Response is not structured JSON, treat as raw reply text
        }

        if (action && action !== 'none') {
          console.log(`[MESSAGE_ROUTER] AI triggered action: ${action} with data:`, actionData);
          try {
            switch (action) {
              case 'add_timetable': {
                if (actionData.day && actionData.activity) {
                  let day = actionData.day.trim();
                  if (day.length > 0) {
                    day = day.charAt(0).toUpperCase() + day.slice(1).toLowerCase();
                  }
                  const time = actionData.time || '';
                  const activity = actionData.activity;
                  const isDuplicate = user.timetable.some(existing => 
                    existing.day.toLowerCase() === day.toLowerCase() &&
                    (existing.time || '') === time &&
                    existing.activity.toLowerCase() === activity.toLowerCase()
                  );
                  if (!isDuplicate) {
                    user.timetable.push({
                      day: day,
                      time: time,
                      activity: activity,
                      notes: actionData.notes || 'Added via AI chat'
                    });
                    await user.save();
                  }
                }
                break;
              }
              case 'clear_timetable': {
                await this.client.sendButtonTemplate(
                  instagramId,
                  "⚠️ Are you sure you want to clear your weekly timetable?",
                  {
                    buttons: [
                      {
                        type: 'postback',
                        title: '🗑️ Yes, Clear It',
                        payload: `${this.client.prefix}confirm_clear:timetable`
                      }
                    ]
                  }
                );
                break;
              }
              case 'add_reminder': {
                const reminderActivity = actionData.reminderActivity || actionData.activity || actionData.deadlineName || actionData.name;
                const reminderTime = actionData.reminderTime || actionData.time || actionData.deadlineEndDate || actionData.endDate;
                if (reminderActivity && reminderTime) {
                  const targetTime = new Date(reminderTime);
                  if (!isNaN(targetTime.getTime())) {
                    const isDuplicate = user.reminders.some(existing => 
                      existing.active &&
                      existing.activity.toLowerCase() === reminderActivity.toLowerCase() &&
                      existing.time.getTime() === targetTime.getTime()
                    );
                    if (!isDuplicate) {
                      let repeat = (actionData.reminderRepeat || 'none').toLowerCase().trim();
                      if (!['none', 'daily', 'weekly'].includes(repeat)) {
                        repeat = 'none';
                      }
                      user.reminders.push({
                        activity: reminderActivity,
                        time: targetTime,
                        repeat: repeat,
                        active: true
                      });
                      await user.save();
                    }
                  }
                }
                break;
              }
              case 'clear_reminders': {
                await this.client.sendButtonTemplate(
                  instagramId,
                  "⚠️ Are you sure you want to clear all active reminders?",
                  {
                    buttons: [
                      {
                        type: 'postback',
                        title: '🗑️ Yes, Clear It',
                        payload: `${this.client.prefix}confirm_clear:reminders`
                      }
                    ]
                  }
                );
                break;
              }
              case 'add_deadline': {
                const deadlineName = actionData.deadlineName || actionData.name || actionData.reminderActivity || actionData.activity;
                const deadlineEndDate = actionData.deadlineEndDate || actionData.endDate || actionData.reminderTime || actionData.time;
                if (deadlineName && deadlineEndDate) {
                  let endDate;
                  if (typeof deadlineEndDate === 'string' && deadlineEndDate.match(/^\d+d$/i)) {
                    const days = parseInt(deadlineEndDate, 10);
                    endDate = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
                  } else {
                    endDate = new Date(deadlineEndDate);
                  }

                  if (!isNaN(endDate.getTime())) {
                    const isDuplicate = user.blockers.some(existing => 
                      !existing.notified &&
                      existing.name.toLowerCase() === deadlineName.toLowerCase() &&
                      existing.endDate.getTime() === endDate.getTime()
                    );
                    if (!isDuplicate) {
                      user.blockers.push({
                        name: deadlineName,
                        endDate: endDate,
                        notified: false
                      });
                      await user.save();
                    }
                  }
                }
                break;
              }
              case 'clear_deadlines': {
                await this.client.sendButtonTemplate(
                  instagramId,
                  "⚠️ Are you sure you want to clear all task deadlines?",
                  {
                    buttons: [
                      {
                        type: 'postback',
                        title: '🗑️ Yes, Clear It',
                        payload: `${this.client.prefix}confirm_clear:deadlines`
                      }
                    ]
                  }
                );
                break;
              }
              case 'create_note': {
                const title = actionData.noteTitle || actionData.title || 'Custom Note';
                const summary = actionData.noteSummary || actionData.notes || actionData.summary || '';
                
                let category = (actionData.noteCategory || actionData.category || 'resource').toLowerCase().trim();
                const validCategories = ['study', 'project', 'resource', 'tips', 'other'];
                if (!validCategories.includes(category)) {
                  category = 'resource';
                }

                const rawResources = Array.isArray(actionData.noteResources || actionData.resources)
                  ? (actionData.noteResources || actionData.resources)
                  : [];

                if (title && summary) {
                  const resourcesFormatted = rawResources.map(r => ({
                    name: r ? (r.name || 'Resource') : 'Resource',
                    type: r ? (r.type || 'resource') : 'resource',
                    description: r ? (r.description || '') : ''
                  }));

                  const note = new ReelNote({
                    instagramId: user.instagramId,
                    reelUrl: undefined,
                    title: title,
                    summary: summary,
                    category: category,
                    resourceDetails: {
                      resources: resourcesFormatted
                    },
                    saved: true,
                    savedAt: new Date()
                  });
                  await note.save();
                }
                break;
              }
            }
          } catch (actionErr) {
            console.error(`[MESSAGE_ROUTER] Failed to execute action ${action}:`, actionErr);
            replyText += "\n\n⚠️ (Note: I encountered an issue updating your settings for this action.)";
          }
        }

        await this.client.sendMessage(instagramId, replyText);
      } catch (chatErr) {
        console.error('[MESSAGE_ROUTER] Gemini Chatbot failed:', chatErr);
      }
    }
  }
}

module.exports = MessageHandler;