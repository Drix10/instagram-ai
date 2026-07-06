const User = require('../../Models/User');

module.exports = {
  name: 'deadline',
  description: 'Manage exam blockers and study deadlines',
  usage: 'add <name> <YYYY-MM-DD or Xd> | list | clear',
  cooldown: 3,
  aliases: ['blocker', 'deadlines', 'exams'],
  requiresAuth: true,

  async execute(client, message, args) {
    try {
      const instagramId = message.sender.id;
      const user = await User.findOne({ instagramId });

      if (!user) {
        return client.sendMessage(instagramId, 'You need to be registered first! Send !register.');
      }

      if (args.length === 0 || args[0].toLowerCase() === 'list') {
        
        const activeBlockers = user.blockers.filter(b => !b.notified);
        
        if (activeBlockers.length === 0) {
          return client.sendMessage(
            instagramId, 
            `🎓 You have no active exam blockers or learning deadlines!\n\n` +
            `Type "!deadline add Exams 5d" or "!deadline add Board Exams 2026-07-15" to block your schedule. ` +
            `I will remind you to start learning new things once your exams finish! 🚀`
          );
        }

        let listText = `🎓 【ACTIVE EXAMS & DEADLINES】 🎓\n\n`;
        activeBlockers.forEach((b, index) => {
          listText += `${index + 1}. *${b.name}* 📅\n   Ends on: ${new Date(b.endDate).toDateString()}\n\n`;
        });
        listText += `💡 I will automatically DM you to check in and suggest your saved learning resources once these dates complete!`;
        return client.sendMessage(instagramId, listText);
      }

      const subcmd = args[0].toLowerCase();

      if (subcmd === 'clear') {
        user.blockers = [];
        await user.save();
        return client.sendMessage(instagramId, '🧹 All exam blockers and learning deadlines have been cleared.');
      }

      if (subcmd === 'add') {
        if (args.length < 3) {
          return client.sendMessage(instagramId, `❌ Usage: !deadline add <Exam/Project Name> <YYYY-MM-DD or relative days e.g. 5d>`);
        }

        const dateStr = args[args.length - 1].trim();
        const name = args.slice(1, args.length - 1).join(' ').trim();

        let endDate;
        if (dateStr.match(/^\d+d$/i)) {
          const days = parseInt(dateStr, 10);
          endDate = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
        } else {
          endDate = new Date(dateStr);
        }

        if (isNaN(endDate.getTime())) {
          return client.sendMessage(instagramId, `❌ Invalid date format. Use YYYY-MM-DD (e.g. 2026-07-15) or relative days (e.g. 10d).`);
        }

        user.blockers.push({
          name,
          endDate,
          notified: false
        });

        await user.save();

        return client.sendMessage(
          instagramId, 
          `🎓 Added Blocker: *${name}*\n` +
          `📅 Scheduled End: ${endDate.toDateString()}\n\n` +
          `Study schedules are paused during this period. I will DM you as soon as this completes to suggest resource notes and start learning! 🚀`
        );
      }

      await client.sendMessage(instagramId, `❌ Unknown deadline subcommand. Use "!deadline add", "!deadline list", or "!deadline clear".`);
    } catch (error) {
      console.error('[COMMANDS] Error in deadline command:', error);
      await client.sendMessage(message.sender.id, 'An error occurred while managing your deadlines.');
    }
  }
};
