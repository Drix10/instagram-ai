module.exports = {
  name: 'ping',
  description: 'Check the bot\'s response time',
  usage: '',
  cooldown: 3,
  aliases: ['latency'],
  requiresAuth: false,

  async execute(client, message, args) {
    try {
      const start = Date.now();
      const msg = await client.sendMessage(message.sender.id, '🏓 Pinging...');
      const end = Date.now();
      
      const latency = end - start;
      
      await client.sendMessage(message.sender.id, `🏓 Pong! Response time: ${latency}ms`);
    } catch (error) {
      console.error(`[INSTAGRAM] Error in ping command: ${error.message}`);
      console.error(error.stack);
      client.sendMessage(message.sender.id, 'An error occurred while checking ping. Please try again later.');
    }
  }
}; 