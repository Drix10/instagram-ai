module.exports = {
  name: 'help',
  description: 'Display all available commands',
  usage: '',
  cooldown: 3,
  aliases: ['h', 'commands'],

  async execute(client, message, args) {
    const instagramId = message.sender.id;
    const prefix = client.prefix;

    const helpMessage = 
      `📚 【LEARNING MANAGER COMMANDS】 📚\n\n` +
      `Here is a list of commands you can run:\n\n` +
      `• ${prefix}register - Register your profile\n` +
      `• ${prefix}timetable - View your weekly study/learning timetable\n` +
      `• ${prefix}timetable clear - Clear all items from your timetable\n` +
      `• ${prefix}notes - List your saved Reel notes & resources\n` +
      `• ${prefix}notes view <index> - View detailed content of a saved note\n` +
      `• ${prefix}reminders - View your scheduled learning reminder alerts\n` +
      `• ${prefix}reminders clear - Clear all active reminders\n` +
      `• ${prefix}deadline add <name> <date> - Add a task or learning deadline (Date: YYYY-MM-DD or 3d)\n` +
      `• ${prefix}deadline list - View all current deadlines\n` +
      `• ${prefix}deadline clear - Clear all active deadlines\n` +
      `• ${prefix}ping - Test bot latency\n\n` +
      `💡 *Tip*: Share any learning/educational Reel with me in this chat! I will watch, transcribe, and help you map it directly into your schedule! 📲🎥`;

    await client.sendMessage(instagramId, helpMessage);
  }
};