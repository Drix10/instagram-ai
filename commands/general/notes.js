const ReelNote = require('../../Models/ReelNote');

module.exports = {
  name: 'notes',
  description: 'List or view your saved Reel study notes/resources',
  usage: '[view <index>]',
  cooldown: 5,
  aliases: ['note', 'transcripts'],
  requiresAuth: true,

  async execute(client, message, args) {
    try {
      const instagramId = message.sender.id;

      if (args.length > 1 && args[0].toLowerCase() === 'view') {
        const query = args[1].trim();
        let note = null;

        if (query.match(/^[0-9a-fA-F]{24}$/)) {
          note = await ReelNote.findById(query);
        } else {
          
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
          `📂 Category: ${note.category?.toUpperCase() || 'RESOURCE'}\n\n` +
          `💡 Summary:\n${note.summary}\n`;

        if (note.resourceDetails?.resources?.length > 0) {
          fullText += `\n📦 Resources & Steps Extracted:\n`;
          note.resourceDetails.resources.forEach(res => {
            const typeStr = res.type ? ` [${res.type}]` : '';
            const descStr = res.description ? `: ${res.description}` : '';
            fullText += `• *${res.name}*${typeStr}${descStr}\n`;
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

      const notes = await ReelNote.find({ instagramId, saved: true }).sort({ savedAt: -1 }).limit(10);

      if (notes.length === 0) {
        return client.sendMessage(
          instagramId,
          `📂 Your saved Reel notes list is empty!\n\n` +
          `Try sending a learning Reel here and click "Save Note" on the returned summary card! 📲`
        );
      }

      let listText = `📂 【SAVED REEL NOTES】 📂\n\n`;
      notes.forEach((note, index) => {
        listText += `${index + 1}. [${note.category?.toUpperCase() || 'RESOURCE'}] ${note.title}\n`;
      });

      listText += `\n💡 Type "!notes view <index>" to view full resource details.`;

      await client.sendMessage(instagramId, listText);
    } catch (error) {
      console.error('[COMMANDS] Error in notes command:', error);
      await client.sendMessage(message.sender.id, 'An error occurred while fetching notes. Please try again.');
    }
  }
};
