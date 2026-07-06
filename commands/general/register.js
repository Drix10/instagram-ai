const User = require('../../Models/User');

module.exports = {
  name: 'register',
  description: 'Register with the Reel notes and learning scheduler bot',
  usage: '',
  cooldown: 5,
  aliases: ['signup'],

  async execute(client, message, args) {
    try {
      const instagramId = message.sender.id;
      const username = message.sender.username || 'user';

      let user = await User.findOne({ instagramId });

      if (user) {
        return client.sendMessage(
          instagramId, 
          `👋 Hello @${username}! You are already registered.\n\n` +
          `Try sharing a learning or educational Reel with me directly to generate study schedules and notes! 📝`
        );
      }

      user = new User({
        instagramId,
        username
      });

      await user.save();

      const welcomeMsg = `🎉 Welcome to your AI Learning & Timetable Manager, @${username}! 🎉\n\n` +
        `I will help you transcribe study Reels, save learning resources, and organize your weekly schedules.\n\n` +
        `💡 *How to use:* \n` +
        `1️⃣ Share any educational, tutorial, or resource Reel directly to our DMs 📲\n` +
        `2️⃣ Wait for Gemini AI to transcribe the summary, steps, and resources\n` +
        `3️⃣ Click the buttons to add the resources to your Weekly Timetable or Set Reminders! 📅🔔\n` +
        `4️⃣ Set task/course deadlines with "!deadline add [name] [YYYY-MM-DD]". When the deadline date completes, I'll check in with you! 📅\n\n` +
        `You can also just type normal messages to chat with me about your learning schedule! Let's build something great! 🚀`;

      await client.sendMessage(instagramId, welcomeMsg);
    } catch (error) {
      console.error('[COMMANDS] Error in register command:', error);
      await client.sendMessage(message.sender.id, 'An error occurred during registration. Please try again.');
    }
  }
};