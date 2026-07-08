const axios = require('axios');

class ApiHandler {
  constructor(client) {
    this.client = client;
  }

  async resolveCarouselFromAssetId(igPostMediaId) {
    const accessToken = process.env.INSTAGRAM_ACCESS_TOKEN;
    if (!accessToken || !igPostMediaId) return null;
    try {
      const response = await axios.get(`https://graph.instagram.com/v21.0/${igPostMediaId}`, {
        params: {
          fields: 'shortcode,media_type,media_url,thumbnail_url,children{media_type,media_url,thumbnail_url}',
          access_token: accessToken
        }
      });
      const data = response.data;
      if (data.media_type === 'CAROUSEL_ALBUM' && data.children?.data) {
        return {
          source: 'graph_api_direct',
          shortcode: data.shortcode,
          items: data.children.data.map(child => ({
            type: child.media_type === 'VIDEO' ? 'video' : 'image',
            url: child.media_url || child.thumbnail_url,
            mimeType: child.media_type === 'VIDEO' ? 'video/mp4' : 'image/jpeg'
          }))
        };
      }
      if (data.shortcode) return { source: 'graph_api_shortcode', shortcode: data.shortcode };
    } catch (err) {
      console.warn('[RESOLVER] Graph API lookup failed:', err.response?.data || err.message);
    }
    return null;
  }

  async resolveViaOembed(cdnUrl) {
    const accessToken = process.env.INSTAGRAM_ACCESS_TOKEN;
    if (!accessToken || !cdnUrl) return null;
    try {
      const response = await axios.get('https://graph.facebook.com/v21.0/instagram_oembed', {
        params: { url: cdnUrl, access_token: accessToken }
      });
      const html = response.data.html || '';
      const match = html.match(/\/(p|reel|reels)\/([A-Za-z0-9_-]+)/) || cdnUrl.match(/\/(p|reel|reels)\/([A-Za-z0-9_-]+)/);
      if (match) return match[2];
    } catch (err) {
      console.warn('[RESOLVER] oEmbed failed:', err.response?.data || err.message);
    }
    return null;
  }

  async verifyToken() {
    try {
      const accessToken = process.env.INSTAGRAM_ACCESS_TOKEN;
      if (!accessToken) return false;
      await axios.get(`https://graph.instagram.com/v21.0/me`, { params: { access_token: accessToken } });
      return true;
    } catch (error) {
      return false;
    }
  }

  async getProfileInfo(userId) {
    try {
      if (this.client.profileCache) {
        const cached = this.client.getCachedProfile(userId);
        if (cached) return cached;
      }
      const accessToken = process.env.INSTAGRAM_ACCESS_TOKEN;
      if (!this.client.rateLimiter.canSendMessage() || !accessToken) {
        return { id: userId, username: `user_${userId.substring(0, 4)}`, name: "Instagram User" };
      }
      const response = await axios.get(`https://graph.instagram.com/v21.0/${userId}`, {
        params: { access_token: accessToken, fields: 'username,name' }
      });
      if (response.headers['x-app-usage']) this.client.rateLimiter.updateFromHeaders(response.headers['x-app-usage']);
      const profileData = response.data;
      if (!profileData.username) profileData.username = profileData.name ? profileData.name.toLowerCase().replace(/\s+/g, '_') : `user_${userId.substring(0, 4)}`;
      this.client.setCachedProfile(userId, profileData);
      return profileData;
    } catch (error) {
      if (error.response?.status === 429) this.client.rateLimiter.markRateLimited();
      return { id: userId, username: `user_${userId.substring(0, 4)}`, name: "Instagram User" };
    }
  }

  splitText(text, limit = 1000) {
    if (text.length <= limit) return [text];
    const chunks = [];
    let currentChunk = "";
    const lines = text.split('\n');
    for (const line of lines) {
      if (line.length > limit) {
        if (currentChunk) { chunks.push(currentChunk); currentChunk = ""; }
        let remainingLine = line;
        while (remainingLine.length > limit) {
          chunks.push(remainingLine.substring(0, limit));
          remainingLine = remainingLine.substring(limit);
        }
        currentChunk = remainingLine;
      } else {
        const nextLength = currentChunk.length + (currentChunk ? 1 : 0) + line.length;
        if (nextLength > limit) { chunks.push(currentChunk); currentChunk = line; }
        else { currentChunk += (currentChunk ? '\n' : '') + line; }
      }
    }
    if (currentChunk) chunks.push(currentChunk);
    return chunks;
  }

  async sendMessage(recipientId, text) {
    let sentCount = 0;
    const chunks = this.splitText(text, 1000);
    try {
      const accessToken = process.env.INSTAGRAM_ACCESS_TOKEN;
      if (!accessToken) return { status: 'error', error: 'Missing access token' };
      let lastResponse = null;
      for (let i = 0; i < chunks.length; i++) {
        if (!this.client.rateLimiter.canSendMessage()) throw new Error('Rate limit reached');
        lastResponse = await axios.post(`https://graph.instagram.com/v21.0/me/messages`, {
          recipient: { id: recipientId },
          message: { text: chunks[i] }
        }, { params: { access_token: accessToken } });
        sentCount++;
        if (lastResponse.headers['x-app-usage']) this.client.rateLimiter.updateFromHeaders(lastResponse.headers['x-app-usage']);
        if (i < chunks.length - 1) await new Promise(resolve => setTimeout(resolve, 500));
      }
      return { status: 'success', sent: sentCount, total: chunks.length };
    } catch (error) {
      if (error.response?.status === 429) this.client.rateLimiter.markRateLimited();
      return { status: sentCount > 0 ? 'partial' : 'error', sent: sentCount, total: chunks.length, error: error.message };
    }
  }

  async sendButtonTemplate(recipientId, title, options = {}) {
    try {
      const accessToken = process.env.INSTAGRAM_ACCESS_TOKEN;
      if (!this.client.rateLimiter.canSendMessage() || !accessToken) return false;
      const { subtitle, imageUrl, buttons = [] } = options;
      const element = { title };
      if (subtitle) element.subtitle = subtitle;
      if (imageUrl) element.image_url = imageUrl;
      if (buttons.length > 0) {
        element.buttons = buttons.map(b => {
          if (b.type === 'web_url') return { type: 'web_url', title: b.title, url: b.url };
          if (b.type === 'postback') return { type: 'postback', title: b.title, payload: b.payload };
          return null;
        }).filter(b => b);
      }
      const response = await axios.post(`https://graph.instagram.com/v21.0/me/messages`, {
        recipient: { id: recipientId },
        message: { attachment: { type: 'template', payload: { template_type: 'generic', elements: [element] } } }
      }, { params: { access_token: accessToken } });
      if (response.headers['x-app-usage']) this.client.rateLimiter.updateFromHeaders(response.headers['x-app-usage']);
      return response.data;
    } catch (error) {
      if (error.response?.status === 429) this.client.rateLimiter.markRateLimited();
      return false;
    }
  }

  async sendCarouselTemplate(recipientId, elements = []) {
    try {
      const accessToken = process.env.INSTAGRAM_ACCESS_TOKEN;
      if (!this.client.rateLimiter.canSendMessage() || !accessToken) return false;
      const formattedElements = elements.slice(0, 10).map(e => {
        const item = { title: e.title };
        if (e.subtitle) item.subtitle = e.subtitle;
        if (e.imageUrl) item.image_url = e.imageUrl;
        if (e.buttons) {
          item.buttons = e.buttons.slice(0, 3).map(b => {
            if (b.type === 'web_url') return { type: 'web_url', title: b.title, url: b.url };
            if (b.type === 'postback') return { type: 'postback', title: b.title, payload: b.payload };
            return null;
          }).filter(b => b);
        }
        return item;
      });
      const response = await axios.post(`https://graph.instagram.com/v21.0/me/messages`, {
        recipient: { id: recipientId },
        message: { attachment: { type: 'template', payload: { template_type: 'generic', elements: formattedElements } } }
      }, { params: { access_token: accessToken } });
      if (response.headers['x-app-usage']) this.client.rateLimiter.updateFromHeaders(response.headers['x-app-usage']);
      return response.data;
    } catch (error) {
      if (error.response?.status === 429) this.client.rateLimiter.markRateLimited();
      return false;
    }
  }
}

module.exports = ApiHandler;
