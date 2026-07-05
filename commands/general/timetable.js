const User = require('../../Models/User');

module.exports = {
  name: 'timetable',
  description: 'View or clear your weekly study/learning timetable',
  usage: '[clear]',
  cooldown: 5,
  aliases: ['schedule', 'routines'],
  requiresAuth: true,

  async execute(client, message, args) {
    try {
      const instagramId = message.sender.id;
      const user = await User.findOne({ instagramId });

      if (!user) {
        return client.sendMessage(instagramId, 'You need to be registered first! Send !register to get started.');
      }

      // Handle "clear" argument
      if (args.length > 0 && args[0].toLowerCase() === 'clear') {
        user.timetable = [];
        await user.save();
        return client.sendMessage(instagramId, '🧹 Your weekly timetable has been cleared successfully.');
      }

      if (!user.timetable || user.timetable.length === 0) {
        return client.sendMessage(
          instagramId,
          `📅 Your Weekly Timetable is empty!\n\n` +
          `How to build your routine:\n` +
          `1️⃣ Share an educational or learning Reel with me 📲\n` +
          `2️⃣ Click "Add to Timetable" on the transcription card to map it to your week! ⏰`
        );
      }

      // Group activities by day of the week
      const daysOfWeek = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
      let timetableText = `📅 【WEEKLY TIMETABLE】 📅\n\n`;
      let hasActivities = false;

      daysOfWeek.forEach(day => {
        const activities = user.timetable.filter(act => act.day.toLowerCase() === day.toLowerCase());
        if (activities.length > 0) {
          hasActivities = true;
          // Sort activities by time
          activities.sort((a, b) => {
            if (!a.time) return 1;
            if (!b.time) return -1;
            return a.time.localeCompare(b.time);
          });

          timetableText += `*${day.toUpperCase()}*:\n`;
          activities.forEach(act => {
            const timeStr = act.time ? ` [${act.time}]` : '';
            const noteStr = act.notes ? ` (${act.notes})` : '';
            timetableText += `  •${timeStr} ${act.activity}${noteStr}\n`;
          });
          timetableText += `\n`;
        }
      });

      if (!hasActivities) {
        // Fallback for custom day mappings not matched in standard array
        timetableText += `Custom Schedules:\n`;
        user.timetable.forEach(act => {
          const timeStr = act.time ? ` [${act.time}]` : '';
          timetableText += `  • [${act.day}]${timeStr} ${act.activity}\n`;
        });
        timetableText += `\n`;
      }

      timetableText += `💡 Type "!timetable clear" to empty your schedule.`;
      await client.sendMessage(instagramId, timetableText);
    } catch (error) {
      console.error('[COMMANDS] Error in timetable command:', error);
      await client.sendMessage(message.sender.id, 'An error occurred while fetching your timetable.');
    }
  }
};
