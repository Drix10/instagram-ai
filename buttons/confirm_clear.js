const User = require('../Models/User');

module.exports = {
  name: 'confirm_clear',
  description: 'Handles the confirmed clear flow for timetable, reminders, or deadlines',
  requiresAuth: true,

  async execute(client, message, args) {
    try {
      const instagramId = message.sender.id;
      if (!args || args.length === 0) {
        return client.sendMessage(instagramId, '❌ Invalid command parameters.');
      }

      const target = args[0].toLowerCase();
      const user = await User.findOne({ instagramId });

      if (!user) {
        return client.sendMessage(instagramId, '❌ User profile not found.');
      }

      if (target === 'timetable') {
        user.timetable = [];
        await user.save();
        await client.sendMessage(instagramId, '🧹 Your weekly timetable has been cleared successfully.');
      } else if (target === 'reminders') {
        user.reminders = [];
        await user.save();
        await client.sendMessage(instagramId, '🧹 All active alerts and reminders have been cleared successfully.');
      } else if (target === 'deadlines') {
        user.blockers = [];
        await user.save();
        await client.sendMessage(instagramId, '🧹 All task and study deadlines have been cleared successfully.');
      } else {
        await client.sendMessage(instagramId, '❌ Unknown clear target.');
      }
    } catch (error) {
      console.error('[BUTTONS] Error during confirm clear:', error);
      await client.sendMessage(message.sender.id, 'An error occurred while clearing your settings.');
    }
  }
};
