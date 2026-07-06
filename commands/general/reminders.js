const User = require('../../Models/User');

module.exports = {
  name: 'reminders',
  description: 'View or clear your scheduled learning reminders',
  usage: '[clear]',
  cooldown: 5,
  aliases: ['alerts', 'reminder'],
  requiresAuth: true,

  async execute(client, message, args) {
    try {
      const instagramId = message.sender.id;
      const user = await User.findOne({ instagramId });

      if (!user) {
        return client.sendMessage(instagramId, 'You need to be registered to manage reminders! Send !register first.');
      }

      if (args.length > 0 && args[0].toLowerCase() === 'clear') {
        user.reminders = [];
        await user.save();
        return client.sendMessage(instagramId, '🧹 All active alerts and reminders have been cleared successfully.');
      }

      const activeReminders = user.reminders.filter(rem => rem.active);

      if (activeReminders.length === 0) {
        return client.sendMessage(
          instagramId,
          `🔔 You have no active learning reminders!\n\n` +
          `How to set one:\n` +
          `1️⃣ Share an educational Reel with me 📲\n` +
          `2️⃣ Click "Set Reminder" on the transcription card to schedule a study alert! ⏰`
        );
      }

      let alertsText = `🔔 【ACTIVE ALERTS】 🔔\n\n`;
      activeReminders.forEach((rem, index) => {
        const timeStr = new Date(rem.time).toLocaleString('en-US', {
          weekday: 'short',
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
          hour12: true
        });
        const repeatStr = rem.repeat !== 'none' ? ` (${rem.repeat})` : '';
        alertsText += `${index + 1}. 📚 *${rem.activity}*\n   📅 Time: ${timeStr}${repeatStr}\n\n`;
      });

      alertsText += `💡 Type "!reminders clear" to clear all active reminders.`;

      await client.sendMessage(instagramId, alertsText);
    } catch (error) {
      console.error('[COMMANDS] Error in reminders command:', error);
      await client.sendMessage(message.sender.id, 'An error occurred while fetching reminders. Please try again.');
    }
  }
};
