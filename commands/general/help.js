module.exports = {
  name: 'help',
  description: 'Show all available commands',
  usage: '',
  cooldown: 3,
  aliases: ['h', 'commands'],
  requiresAuth: false,

  async execute(client, message, args) {
    const instagramId = message.sender.id;
    
    const helpText = `📚 【REEL BOT COMMANDS】 📚\n\n` +
      `• ${client.prefix}register - Register your profile\n` +
      `• ${client.prefix}timetable - View your weekly workout timetable\n` +
      `• ${client.prefix}notes - List all transcribed notes & exercises\n` +
      `• ${client.prefix}reminders - View your active reminder alerts\n\n` +
      `💬 【AI CHATBOT】\n` +
      `Simply type a message to chat with our AI fitness assistant. It has context on your saved timetable! 🏋️‍♂️🤖`;

    try {
      await client.sendButtonTemplate(instagramId, helpText, {
        buttons: [
          {
            type: 'postback',
            title: '📅 View Timetable',
            payload: `${client.prefix}timetable`
          },
          {
            type: 'postback',
            title: '📂 View Notes',
            payload: `${client.prefix}notes`
          },
          {
            type: 'postback',
            title: '🔔 View Reminders',
            payload: `${client.prefix}reminders`
          }
        ]
      });
    } catch (err) {
      await client.sendMessage(instagramId, helpText);
    }
  }
};