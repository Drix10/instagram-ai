const User = require('../../Models/User');

module.exports = {
  name: 'register',
  description: 'Register with the Reel notes and workout timetable bot',
  usage: '',
  cooldown: 5,
  aliases: ['reg', 'start'],
  requiresAuth: false,

  async execute(client, message, args) {
    try {
      const instagramId = message.sender.id;
      let username = message.sender.username || 'user';

      let user = await User.findOne({ instagramId });

      if (user) {
        return client.sendMessage(
          instagramId,
          `👋 Welcome back, ${username}! You're already registered.\n\n` +
          `Try sending (sharing) a fitness Reel with me to transcribe it, or type !help to check commands! 🏋️‍♂️✨`
        );
      }

      user = new User({
        instagramId,
        username
      });
      await user.save();

      await client.sendMessage(
        instagramId,
        `🎉 Registration successful! Welcome to Reel Notes & Timetable Bot! 🎉\n\n` +
        `How it works:\n` +
        `1️⃣ Share any fitness or workout Reel directly to our DMs 📲\n` +
        `2️⃣ Our AI will automatically download, watch, and transcribe the exercises 🤖🎥\n` +
        `3️⃣ Click the buttons to add the workout to your Weekly Timetable or Set Reminders! 📅🔔\n\n` +
        `You can also just type normal messages to chat with me about workouts!`
      );
    } catch (error) {
      console.error('[COMMANDS] Error in register command:', error);
      await client.sendMessage(
        message.sender.id,
        'Sorry, I hit a snag while trying to register your account. Please try again in a moment!'
      );
    }
  }
};