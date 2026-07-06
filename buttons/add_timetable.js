const User = require('../Models/User');
const ReelNote = require('../Models/ReelNote');

module.exports = {
  name: 'add_timetable',
  description: 'Adds the Reel timetable suggestions into the user weekly timetable',
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
        return client.sendMessage(instagramId, '⚠️ This Reel has no schedule suggestions to add.');
      }

      const user = await User.findOne({ instagramId });
      if (!user) {
        return client.sendMessage(instagramId, '❌ User profile not found.');
      }

      let addedCount = 0;
      let skippedCount = 0;

      note.timetableSuggestions.forEach(sug => {
        const isDuplicate = user.timetable.some(existing => 
          existing.day.toLowerCase() === sug.day.toLowerCase() &&
          existing.time === sug.time &&
          existing.activity.toLowerCase() === sug.activity.toLowerCase()
        );

        if (!isDuplicate) {
          user.timetable.push({
            day: sug.day,
            time: sug.time,
            activity: sug.activity,
            notes: sug.notes || note.title
          });
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
          `📋 These activities are already scheduled in your weekly timetable! No duplicates added. Check with !timetable.`
        );
      }

      let successMsg = `📅 *Routine Added to Timetable!* 📅\n\n`;
      note.timetableSuggestions.forEach(sug => {
        successMsg += `• *${sug.day} [${sug.time}]*: ${sug.activity}\n`;
      });
      
      if (skippedCount > 0) {
        successMsg += `\n*(Note: ${skippedCount} duplicate items were skipped)*\n`;
      }
      
      successMsg += `\nType "!timetable" to view your weekly routine! 🏋️‍♂️✨`;

      await client.sendMessage(instagramId, successMsg);
    } catch (error) {
      console.error('[BUTTONS] Error adding to timetable:', error);
      await client.sendMessage(message.sender.id, 'An error occurred while updating your timetable.');
    }
  }
};
