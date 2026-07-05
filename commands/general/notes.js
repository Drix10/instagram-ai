const ReelNote = require('../../Models/ReelNote');

module.exports = {
  name: 'notes',
  description: 'List or view your saved Reel transcriptions',
  usage: '[view <index>]',
  cooldown: 5,
  aliases: ['note', 'transcripts'],
  requiresAuth: true,

  async execute(client, message, args) {
    try {
      const instagramId = message.sender.id;

      // Handle detailed note lookup (e.g. !notes view 1 or !notes view <id>)
      if (args.length > 1 && args[0].toLowerCase() === 'view') {
        const query = args[1].trim();
        let note = null;

        // Try viewing by ID first
        if (query.match(/^[0-9a-fA-F]{24}$/)) {
          note = await ReelNote.findById(query);
        } else {
          // Try viewing by list index (from saved notes)
          const idx = parseInt(query, 10);
          if (!isNaN(idx)) {
            const list = await ReelNote.find({ instagramId, saved: true }).sort({ savedAt: -1 }).limit(10);
            if (idx > 0 && idx <= list.length) {
              note = list[idx - 1];
            }
          }
        }

        if (!note || note.instagramId !== instagramId) {
          return client.sendMessage(instagramId, '❌ Note not found. Please verify the index or ID.');
        }

        let fullText = `📝 【REEL DETAIL NOTES】 📝\n\n` +
          `📌 Title: ${note.title}\n` +
          `📂 Category: ${note.category?.toUpperCase() || 'NOTE'}\n\n` +
          `💡 Summary:\n${note.summary}\n`;

        if (note.workoutDetails?.exercises?.length > 0) {
          fullText += `\n💪 Exercises Extracted:\n`;
          note.workoutDetails.exercises.forEach(ex => {
            const setsStr = ex.sets > 0 ? `${ex.sets} sets` : '';
            const repsStr = ex.reps > 0 ? `${ex.reps} reps` : '';
            const spec = [setsStr, repsStr].filter(x => x).join(' x ');
            const noteStr = ex.notes ? ` (${ex.notes})` : '';
            fullText += `• ${ex.name} ${spec ? `- ${spec}` : ''}${noteStr}\n`;
          });
        }

        if (note.timetableSuggestions?.length > 0) {
          fullText += `\n📅 Recommended Schedule:\n`;
          note.timetableSuggestions.forEach(sug => {
            const timeVal = sug.time ? ` at ${sug.time}` : '';
            fullText += `• [${sug.day}${timeVal}] ${sug.activity}${sug.notes ? ` (${sug.notes})` : ''}\n`;
          });
        }

        return client.sendMessage(instagramId, fullText);
      }

      // Default: List recent 10 SAVED notes
      const notes = await ReelNote.find({ instagramId, saved: true }).sort({ savedAt: -1 }).limit(10);

      if (notes.length === 0) {
        return client.sendMessage(
          instagramId,
          `📂 Your saved Reel notes list is empty!\n\n` +
          `Try sending a fitness Reel here and click "Save Note" on the returned summary card! 📲`
        );
      }

      let listText = `📂 【SAVED REEL NOTES】 📂\n\n`;
      notes.forEach((note, index) => {
        listText += `${index + 1}. [${note.category?.toUpperCase() || 'NOTE'}] ${note.title}\n`;
      });

      listText += `\n💡 Type "!notes view <index>" to view full exercises or details.`;

      await client.sendMessage(instagramId, listText);
    } catch (error) {
      console.error('[COMMANDS] Error in notes command:', error);
      await client.sendMessage(message.sender.id, 'An error occurred while fetching notes. Please try again.');
    }
  }
};
