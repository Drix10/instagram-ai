const User = require('../Models/User');
const ReelNote = require('../Models/ReelNote');

function getNextDateForDayAndTime(dayName, timeStr) {
  const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const targetDayIndex = days.indexOf(dayName.toLowerCase());
  
  const now = new Date();
  const resultDate = new Date();
  
  // Parse time e.g., "18:30" or "08:00 AM" robustly
  const timeParts = timeStr ? timeStr.split(':') : [];
  let hours = 9;
  let minutes = 0;
  
  if (timeParts.length >= 2) {
    hours = parseInt(timeParts[0].replace(/\D/g, ''), 10);
    minutes = parseInt(timeParts[1].replace(/\D/g, ''), 10);
    if (isNaN(hours)) hours = 9;
    if (isNaN(minutes)) minutes = 0;
  }
  
  resultDate.setHours(hours, minutes, 0, 0);

  if (targetDayIndex === -1) {
    // If invalid day, fallback to tomorrow at target time
    resultDate.setDate(now.getDate() + 1);
    return resultDate;
  }

  // Calculate day difference
  let dayDifference = targetDayIndex - now.getDay();
  if (dayDifference < 0 || (dayDifference === 0 && now.getTime() >= resultDate.getTime())) {
    dayDifference += 7; // push to next week
  }

  resultDate.setDate(now.getDate() + dayDifference);
  return resultDate;
}

module.exports = {
  name: 'set_reminder',
  description: 'Schedules a weekly reminder alert for the user for the transcribed activity',
  requiresAuth: true,

  async execute(client, message, args) {
    try {
      const instagramId = message.sender.id;
      if (!args || args.length === 0) {
        return client.sendMessage(instagramId, '❌ Invalid parameters.');
      }

      const noteId = args[0];
      const note = await ReelNote.findById(noteId);

      if (!note || note.instagramId !== instagramId) {
        return client.sendMessage(instagramId, '❌ Note not found or access denied.');
      }

      if (!note.timetableSuggestions || note.timetableSuggestions.length === 0) {
        return client.sendMessage(instagramId, '⚠️ No suggested schedules available in this Reel to set reminders for.');
      }

      const user = await User.findOne({ instagramId });
      if (!user) {
        return client.sendMessage(instagramId, '❌ User profile not found.');
      }

      let addedCount = 0;
      let skippedCount = 0;
      let successMsg = `⏰ *Weekly Reminders Configured!* ⏰\n\n`;

      // Schedule reminders for each suggestion, checking for duplicate active alerts
      note.timetableSuggestions.forEach(sug => {
        const nextAlert = getNextDateForDayAndTime(sug.day, sug.time);
        
        const isDuplicate = user.reminders.some(existing => 
          existing.active &&
          existing.activity.toLowerCase() === sug.activity.toLowerCase() &&
          existing.time.getTime() === nextAlert.getTime()
        );

        if (!isDuplicate) {
          user.reminders.push({
            activity: sug.activity,
            time: nextAlert,
            repeat: 'weekly',
            active: true
          });

          const timeString = nextAlert.toLocaleString('en-US', {
            weekday: 'short',
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            hour12: true
          });

          successMsg += `• *${sug.activity}*:\n  Scheduled: ${timeString} (Repeats weekly)\n`;
          addedCount++;
        } else {
          skippedCount++;
        }
      });

      if (addedCount > 0) {
        await user.save();
      }

      if (addedCount === 0 && skippedCount > 0) {
        return client.sendMessage(
          instagramId, 
          `🔔 You already have active reminders scheduled for these times! Check with !reminders.`
        );
      }

      if (skippedCount > 0) {
        successMsg += `\n*(Note: ${skippedCount} duplicate alerts were skipped)*\n`;
      }

      successMsg += `\nI will send you a DM when it's time to start! Let's get moving! 💪🔔`;
      await client.sendMessage(instagramId, successMsg);
    } catch (error) {
      console.error('[BUTTONS] Error setting reminders:', error);
      await client.sendMessage(message.sender.id, 'An error occurred while setting reminders.');
    }
  }
};
