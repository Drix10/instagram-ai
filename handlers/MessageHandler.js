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
      this.client.sendMessage(userId, "⚠️ Slow down! ⏳").catch(() => {});
      return false;
    }
    if (!this.userQueues.has(userId)) {
      this.userQueues.set(userId, [message]);
      setImmediate(() => this.processUserQueue(userId));
    } else {
      const q = this.userQueues.get(userId);
      if (q.length < 50) q.push(message);
    }
    return true;
  }

  async processUserQueue(userId) {
    const q = this.userQueues.get(userId);
    if (!q || q.length === 0) { this.userQueues.delete(userId); return; }
    try { await this._processMessage(q[0]); } catch (err) { await this.client.sendMessage(userId, 'Error processing message.').catch(() => {}); }
    finally { q.shift(); if (q.length > 0) setImmediate(() => this.processUserQueue(userId)); else this.userQueues.delete(userId); }
  }

  async _processMessage(message) {
    if (message.is_echo) return;
    const instagramId = message.sender.id;
    let user = await User.findOne({ instagramId });
    if (!user) { user = new User({ instagramId, username: message.sender.username || 'user' }); await user.save(); }

    if (message.reelUrl) {
      const getUrl = (x) => typeof x === 'string' ? x : (x?.url || x?.fallbackUrl || '');
      const key = Array.isArray(message.reelUrl) ? message.reelUrl.map(getUrl).join(',') : getUrl(message.reelUrl);
      if (this.client.isProcessing(key)) return this.client.sendMessage(instagramId, "⏳ Already analyzing...").catch(() => {});
      this.client.markProcessing(key);
      try {
        await this.client.sendMessage(instagramId, "📥 Analyzing Reel... 🤖🎥");
        let caption = message.reelCaption;
        if (!caption && typeof message.reelUrl === 'string') {
          try {
            const res = await axios.get(`https://www.instagram.com/api/v1/oembed/?url=${encodeURIComponent(message.reelUrl)}`, { timeout: 8000 });
            caption = res.data?.title;
          } catch (e) {}
        }
        const parsed = await this.client.aiHandler.transcribeReel(
          instagramId, 
          message.reelUrl, 
          caption, 
          message.messageId, 
          message.sender.username,
          message.needsCarouselResolution,
          message.carouselPayload
        );
        const note = new ReelNote({ instagramId, reelUrl: Array.isArray(message.reelUrl) ? getUrl(message.reelUrl[0]) : getUrl(message.reelUrl), title: parsed.title, summary: parsed.summary, category: parsed.category || 'resource', resourceDetails: parsed.resourceDetails, timetableSuggestions: parsed.timetableSuggestions });
        await note.save();

        let d = `📝 【REEL NOTES】 📝\n\n📌 Topic: ${parsed.title}\n📂 Category: ${parsed.category?.toUpperCase()}\n\n💡 Summary:\n${parsed.summary}\n`;
        if (parsed.resourceDetails?.resources?.length > 0) {
          d += `\n📦 Resources:\n`;
          parsed.resourceDetails.resources.forEach(r => d += `• *${r.name}*${r.type ? ` [${r.type}]` : ''}${r.url ? ` (${r.url})` : ''}${r.description ? `: ${r.description}` : ''}\n`);
        }
        await this.client.sendMessage(instagramId, d);
        await this.client.sendButtonTemplate(instagramId, `Save this to your timetable?`, {
          buttons: [
            { type: 'postback', title: '📂 Save Note', payload: `${this.client.prefix}save_note:${note._id}` },
            { type: 'postback', title: '📅 Add Timetable', payload: `${this.client.prefix}add_timetable:${note._id}` },
            { type: 'postback', title: '🔔 Set Reminder', payload: `${this.client.prefix}set_reminder:${note._id}` }
          ]
        });
      } catch (err) {
        console.error(`[MESSAGE_ROUTER] Error processing Reel for user ${instagramId}:`, err);
        await this.client.sendMessage(instagramId, `❌ Failed: Sorry, I couldn't analyze that Reel right now. Please try again later.`).catch(() => {});
      }
      finally { this.client.clearProcessing(key); }
      return;
    }

    const text = message.text?.trim() || "";
    if (text.startsWith(this.client.prefix) || message.isPostback) {
      let name, args = [];
      let clean = text.startsWith(this.client.prefix) ? text.substring(this.client.prefix.length) : text;
      if (clean.includes(':')) { const parts = clean.split(':'); name = parts[0].toLowerCase(); args = parts.slice(1); }
      else { args = clean.split(/ +/); name = args.shift().toLowerCase(); }
      const cmd = this.client.commands.get(name);
      if (cmd) { await cmd.execute(this.client, message, args); return; }
    }

    if (text.length > 0) {
      try {
        const res = await this.client.aiHandler.generateChatResponse(user.timetable, [], text, user.blockers);
        let reply = "Sorry, I had a bit of trouble processing that. Could you try again?", action = 'none', data = {};
        try {
          let clean = res.trim();
          if (clean.startsWith('```')) { const m = clean.match(/```(?:json)?\s*([\s\S]*?)\s*```/); if (m) clean = m[1].trim(); }
          
          try {
            const p = JSON.parse(clean);
            reply = p.reply || reply;
            action = p.action || 'none';
            data = p.actionData || {};
          } catch (jsonErr) {
            const replyMatch = clean.match(/"reply":\s*"([^"]+)"/);
            if (replyMatch) reply = replyMatch[1];
          }
        } catch (e) {}

        if (action !== 'none') {
          try {
            if (action === 'add_timetable' && data.day && data.activity) {
              const d = data.day.charAt(0).toUpperCase() + data.day.slice(1).toLowerCase();
              if (!user.timetable.some(x => x.day === d && x.time === (data.time || '') && x.activity === data.activity)) {
                user.timetable.push({ day: d, time: data.time || '', activity: data.activity, notes: data.notes || 'Added via AI' });
                await user.save();
              }
            } else if (action === 'add_reminder' && data.reminderActivity && data.reminderTime) {
              const t = new Date(data.reminderTime);
              if (!isNaN(t) && !user.reminders.some(x => x.active && x.activity === data.reminderActivity && x.time.getTime() === t.getTime())) {
                user.reminders.push({ activity: data.reminderActivity, time: t, repeat: data.reminderRepeat || 'none', active: true });
                await user.save();
              }
            } else if (action === 'add_deadline' && data.deadlineName && data.deadlineEndDate) {
              let e = data.deadlineEndDate.match(/^\d+d$/i) ? new Date(Date.now() + parseInt(data.deadlineEndDate) * 86400000) : new Date(data.deadlineEndDate);
              if (!isNaN(e) && !user.blockers.some(x => !x.notified && x.name === data.deadlineName && x.endDate.getTime() === e.getTime())) {
                user.blockers.push({ name: data.deadlineName, endDate: e, notified: false });
                await user.save();
              }
            } else if (action === 'create_note' && data.noteTitle && data.noteSummary) {
              await new ReelNote({ instagramId: user.instagramId, title: data.noteTitle, summary: data.noteSummary, category: data.noteCategory || 'resource', resourceDetails: { resources: (data.noteResources || []).map(r => ({ name: r.name || 'Res', type: r.type || 'res', description: r.description || '', url: r.url || '' })) }, saved: true }).save();
            } else if (action === 'view_timetable') {
              await this.client.sendMessage(instagramId, reply);
              const cmd = this.client.commands.get('timetable');
              if (cmd) { await cmd.execute(this.client, message, []); return; }
            } else if (action === 'view_reminders') {
              await this.client.sendMessage(instagramId, reply);
              const cmd = this.client.commands.get('reminders');
              if (cmd) { await cmd.execute(this.client, message, []); return; }
            } else if (action === 'view_deadlines') {
              await this.client.sendMessage(instagramId, reply);
              const cmd = this.client.commands.get('deadline');
              if (cmd) { await cmd.execute(this.client, message, ['list']); return; }
            } else if (action === 'view_notes') {
              await this.client.sendMessage(instagramId, reply);
              const cmd = this.client.commands.get('notes');
              if (cmd) { await cmd.execute(this.client, message, []); return; }
            }
          } catch (e) { reply += "\n\n⚠️ Error updating settings."; }
        }
        await this.client.sendMessage(instagramId, reply);
      } catch (e) {}
    }
  }
}

module.exports = MessageHandler;
