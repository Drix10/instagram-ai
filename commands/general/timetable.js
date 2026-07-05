const User = require('../../Models/User');

module.exports = {
  name: 'timetable',
  description: 'View or clear your weekly timetable',
  usage: '[clear]',
  cooldown: 5,
  aliases: ['schedule', 'routine'],
  requiresAuth: true,

  async execute(client, message, args) {
    try {
      const instagramId = message.sender.id;
      const user = await User.findOne({ instagramId });

      if (!user) {
        return client.sendMessage(instagramId, 'You need to be registered to check your timetable! Send !register first.');
      }

      // Handle "clear" argument
      if (args.length > 0 && args[0].toLowerCase() === 'clear') {
        user.timetable = [];
        await user.save();
        return client.sendMessage(instagramId, '🧹 Your weekly timetable has been cleared successfully.');
      }

      // Group timetable activities by day
      if (!user.timetable || user.timetable.length === 0) {
        return client.sendMessage(
          instagramId, 
          `📅 Your Weekly Timetable is empty!\n\n` +
          `How to populate:\n` +
          `1️⃣ Share a workout Reel with me 📲\n` +
          `2️⃣ Click "Add to Timetable" on the transcription card! ⚡️`
        );
      }

      const daysOfWeek = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
      let scheduleText = `📅 【WEEKLY TIMETABLE】 📅\n`;
      
      let hasActivities = false;
      daysOfWeek.forEach(day => {
        const activities = user.timetable.filter(act => act.day.toLowerCase() === day.toLowerCase());
        if (activities.length > 0) {
          hasActivities = true;
          scheduleText += `\n🔴 *${day}*:\n`;
          activities.sort((a, b) => a.time.localeCompare(b.time));
          activities.forEach(act => {
            scheduleText += `  • [${act.time}] ${act.activity}${act.notes ? ` (${act.notes})` : ''}\n`;
          });
        }
      });

      if (!hasActivities) {
        scheduleText += '\nNo activities found.';
      }

      scheduleText += `\n\n💡 Type "!timetable clear" to clear your routine.`;

      await client.sendMessage(instagramId, scheduleText);
    } catch (error) {
      console.error('[COMMANDS] Error in timetable command:', error);
      await client.sendMessage(message.sender.id, 'An error occurred while fetching your timetable. Please try again.');
    }
  }
};
