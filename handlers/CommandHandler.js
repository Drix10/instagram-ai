const fs = require('fs');
const path = require('path');

class CommandHandler {
  constructor(client) {
    this.client = client;
  }

  async loadCommands() {
    const commandsDir = path.join(__dirname, '../commands');
    const categories = fs.readdirSync(commandsDir)
      .filter(file => fs.statSync(path.join(commandsDir, file)).isDirectory());

    for (const category of categories) {
      const categoryPath = path.join(commandsDir, category);
      const commandFiles = fs.readdirSync(categoryPath)
        .filter(file => file.endsWith('.js'));

      for (const file of commandFiles) {
        const command = require(path.join(categoryPath, file));
        const commandName = file.split('.')[0];

        this.client.commands.set(commandName, command);

        if (command.aliases && Array.isArray(command.aliases)) {
          command.aliases.forEach(alias => this.client.commands.set(alias, command));
        }
      }
    }

    const buttonsDir = path.join(__dirname, '../buttons');
    if (fs.existsSync(buttonsDir)) {
      const buttonFiles = fs.readdirSync(buttonsDir)
        .filter(file => file.endsWith('.js'));

      for (const file of buttonFiles) {
        const command = require(path.join(buttonsDir, file));
        const commandName = file.split('.')[0];

        this.client.commands.set(commandName, command);

        if (command.aliases && Array.isArray(command.aliases)) {
          command.aliases.forEach(alias => this.client.commands.set(alias, command));
        }
      }
    }

    console.log(`[INSTAGRAM] Loaded ${this.client.commands.size} Instagram commands`);
  }

  getCommand(commandName) {
    return this.client.commands.get(commandName);
  }

  async executeCommand(command, message, args) {
    if (!command) return false;
    try {
      await command.execute(this.client, message, args);
      return true;
    } catch (error) {
      console.error(`[INSTAGRAM] Error executing command ${command.name}:`, error);
      return false;
    }
  }
}

module.exports = CommandHandler; 