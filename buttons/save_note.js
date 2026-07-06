const ReelNote = require('../Models/ReelNote');

module.exports = {
  name: 'save_note',
  description: 'Confirms saving the reel note to the user profile',
  requiresAuth: true,

  async execute(client, message, args) {
    try {
      const instagramId = message.sender.id;
      if (!args || args.length === 0) {
        return client.sendMessage(instagramId, '❌ Invalid command parameters.');
      }

      const noteId = args[0];
      const note = await ReelNote.findById(noteId);

      if (!note || note.instagramId !== instagramId) {
        return client.sendMessage(instagramId, '❌ Note not found or access denied.');
      }

      if (note.saved) {
        return client.sendMessage(
          instagramId, 
          `📋 The note *"${note.title}"* is already saved under your profile!`
        );
      }

      note.saved = true;
      note.savedAt = new Date();
      await note.save();

      await client.sendMessage(
        instagramId,
        `📂 *Saved successfully!* 📝\n\n` +
        `Reel Note *"${note.title}"* is now stored in your profile notes.\n` +
        `Type "!notes" to list them or "!notes view ${noteId}" to inspect details!`
      );
    } catch (error) {
      console.error('[BUTTONS] Error saving note:', error);
      await client.sendMessage(message.sender.id, 'An error occurred while saving the note.');
    }
  }
};
