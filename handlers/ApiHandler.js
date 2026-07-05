const axios = require('axios');

class ApiHandler {
  constructor(client) {
    this.client = client;
  }

  async verifyToken() {
    try {
      const accessToken = process.env.INSTAGRAM_ACCESS_TOKEN;
      if (!accessToken) {
        console.error('[INSTAGRAM] No access token available for verification');
        return false;
      }

      await axios({
        method: 'GET',
        url: `https://graph.instagram.com/v21.0/me`,
        headers: {
          'Authorization': `Bearer ${accessToken}`
        }
      });

      return true;
    } catch (error) {
      console.error('[INSTAGRAM] Error verifying token:', error);
      console.error(error.response?.data || error.message);
      return false;
    }
  }

  async getProfileInfo(userId) {
    try {
      if (this.client.profileCache.has(userId)) {
        const cachedProfile = this.client.profileCache.get(userId);
        if (Date.now() - cachedProfile.timestamp < 3600000) {
          return cachedProfile.data;
        }
      }

      const accessToken = process.env.INSTAGRAM_ACCESS_TOKEN;
      if (!this.client.rateLimiter.canSendMessage() || !accessToken) {
        console.warn('[INSTAGRAM] Skipping profile fetch - rate limited or missing token');
        return {
          id: userId,
          username: `user_${userId.substring(0, 4)}`,
          name: "Instagram User"
        };
      }

      try {
        const response = await axios({
          method: 'GET',
          url: `https://graph.instagram.com/v21.0/${userId}`,
          params: {
            access_token: accessToken,
            fields: 'username,name'
          }
        });

        if (response.headers['x-app-usage']) {
          this.client.rateLimiter.updateFromHeaders(response.headers['x-app-usage']);
        }

        const profileData = response.data;
        if (!profileData.username) {
          profileData.username = profileData.name 
            ? profileData.name.toLowerCase().replace(/\s+/g, '_')
            : `user_${userId.substring(0, 4)}`;
        }

        this.client.profileCache.set(userId, {
          data: profileData,
          timestamp: Date.now()
        });

        return profileData;
      } catch (error) {
        console.error(`[INSTAGRAM] Error fetching profile: ${error.message}`);
        const defaultProfile = {
          id: userId,
          username: `user_${userId.substring(0, 4)}`,
          name: "Instagram User"
        };
        this.client.profileCache.set(userId, {
          data: defaultProfile,
          timestamp: Date.now()
        });
        return defaultProfile;
      }
    } catch (error) {
      console.error('[INSTAGRAM] Critical error in getProfileInfo:', error);
      return {
        id: userId,
        username: `user_${userId.substring(0, 4)}`,
        name: "Instagram User"
      };
    }
  }

  async replyToComment(mediaId, commentId, text) {
    try {
      const accessToken = process.env.INSTAGRAM_ACCESS_TOKEN;
      if (!this.client.rateLimiter.canSendMessage() || !accessToken) {
        return false;
      }

      const response = await axios({
        method: 'POST',
        url: `https://graph.instagram.com/v21.0/me/messages`,
        params: {
          access_token: accessToken
        },
        data: {
          recipient: { comment_id: commentId },
          message: { text: text }
        }
      });

      if (response.headers['x-app-usage']) {
        this.client.rateLimiter.updateFromHeaders(response.headers['x-app-usage']);
      }

      return true;
    } catch (error) {
      console.error('[INSTAGRAM] Error replying to comment:', error);
      if (error.response && error.response.status === 429) {
        this.client.rateLimiter.markRateLimited();
      }
      return false;
    }
  }

  async sendMessage(recipientId, text) {
    try {
      const accessToken = process.env.INSTAGRAM_ACCESS_TOKEN;
      if (!this.client.rateLimiter.canSendMessage() || !accessToken) {
        return false;
      }

      const response = await axios({
        method: 'POST',
        url: `https://graph.instagram.com/v21.0/me/messages`,
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        data: {
          recipient: JSON.stringify({ id: recipientId }),
          message: JSON.stringify({ text: text })
        }
      });

      if (response.headers['x-app-usage']) {
        this.client.rateLimiter.updateFromHeaders(response.headers['x-app-usage']);
      }

      return response.data;
    } catch (error) {
      console.error('[INSTAGRAM] Error sending message:', error.response?.data || error.message);
      if (error.response && error.response.status === 429) {
        this.client.rateLimiter.markRateLimited();
      }
      throw error;
    }
  }

  async sendImage(recipientId, imageUrl, caption = '') {
    try {
      const accessToken = process.env.INSTAGRAM_ACCESS_TOKEN;
      if (!this.client.rateLimiter.canSendMessage() || !accessToken) {
        return false;
      }

      const response = await axios({
        method: 'POST',
        url: `https://graph.instagram.com/v21.0/me/messages`,
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        data: {
          recipient: JSON.stringify({ id: recipientId }),
          message: JSON.stringify({
            attachment: {
              type: 'image',
              payload: {
                url: imageUrl,
                is_reusable: true
              }
            }
          })
        }
      });

      if (caption) {
        await this.sendMessage(recipientId, caption);
      }

      if (response.headers['x-app-usage']) {
        this.client.rateLimiter.updateFromHeaders(response.headers['x-app-usage']);
      }

      return response.data;
    } catch (error) {
      console.error('[INSTAGRAM] Error sending image:', error.response?.data || error.message);
      if (error.response && error.response.status === 429) {
        this.client.rateLimiter.markRateLimited();
      }
    }
  }

  async sendButtonTemplate(recipientId, title, options = {}) {
    try {
      const accessToken = process.env.INSTAGRAM_ACCESS_TOKEN;
      if (!this.client.rateLimiter.canSendMessage() || !accessToken) {
        return false;
      }

      const { subtitle, imageUrl, buttons = [] } = options;

      const element = { title };
      if (subtitle) element.subtitle = subtitle;
      if (imageUrl) element.image_url = imageUrl;

      if (buttons.length > 0) {
        element.buttons = buttons.map(button => {
          if (button.type === 'web_url') {
            return {
              type: 'web_url',
              title: button.title,
              url: button.url
            };
          } else if (button.type === 'postback') {
            return {
              type: 'postback',
              title: button.title,
              payload: button.payload
            };
          }
          return null;
        }).filter(b => b);
      }

      const response = await axios({
        method: 'POST',
        url: `https://graph.instagram.com/v21.0/me/messages`,
        headers: {
          'Authorization': `Bearer ${accessToken}`
        },
        data: {
          recipient: { id: recipientId },
          message: {
            attachment: {
              type: 'template',
              payload: {
                template_type: 'generic',
                elements: [element]
              }
            }
          }
        }
      });

      if (response.headers['x-app-usage']) {
        this.client.rateLimiter.updateFromHeaders(response.headers['x-app-usage']);
      }

      return response.data;
    } catch (error) {
      console.error('[INSTAGRAM] Error sending button template:', error.response?.data || error.message);
      if (error.response && error.response.status === 429) {
        this.client.rateLimiter.markRateLimited();
      }
    }
  }

  async sendCarouselTemplate(recipientId, elements = []) {
    try {
      const accessToken = process.env.INSTAGRAM_ACCESS_TOKEN;
      if (!this.client.rateLimiter.canSendMessage() || !accessToken) {
        return false;
      }

      const formattedElements = elements.slice(0, 10).map(element => {
        const item = { title: element.title };
        if (element.subtitle) item.subtitle = element.subtitle;
        if (element.imageUrl) item.image_url = element.imageUrl;

        if (element.buttons && element.buttons.length > 0) {
          item.buttons = element.buttons.slice(0, 3).map(button => {
            if (button.type === 'web_url') {
              return {
                type: 'web_url',
                title: button.title,
                url: button.url
              };
            } else if (button.type === 'postback') {
              return {
                type: 'postback',
                title: button.title,
                payload: button.payload
              };
            }
            return null;
          }).filter(b => b);
        }

        return item;
      });

      const response = await axios({
        method: 'POST',
        url: `https://graph.instagram.com/v21.0/me/messages`,
        headers: {
          'Authorization': `Bearer ${accessToken}`
        },
        data: {
          recipient: { id: recipientId },
          message: {
            attachment: {
              type: 'template',
              payload: {
                template_type: 'generic',
                elements: formattedElements
              }
            }
          }
        }
      });

      if (response.headers['x-app-usage']) {
        this.client.rateLimiter.updateFromHeaders(response.headers['x-app-usage']);
      }

      return response.data;
    } catch (error) {
      console.error('[INSTAGRAM] Error sending carousel template:', error.response?.data || error.message);
      if (error.response && error.response.status === 429) {
        this.client.rateLimiter.markRateLimited();
      }
    }
  }
}

module.exports = ApiHandler;