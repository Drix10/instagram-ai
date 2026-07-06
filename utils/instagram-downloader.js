
const { IgApiClient } = require('instagram-private-api');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const SESSION_FILE = path.join(__dirname, '..', '.ig-session.json');
const MAX_VIDEO_SIZE = 35 * 1024 * 1024; 

class InstagramDownloader {
  constructor() {
    this.ig = new IgApiClient();
    
    this.ig.state.constants.APP_VERSION = '331.0.0.37.105';
    this.ig.state.constants.APP_VERSION_CODE = '594611413';

    this.isLoggedIn = false;
    this.loginPromise = null; 
  }

  async login() {
    
    if (this.loginPromise) {
      return this.loginPromise;
    }

    if (this.isLoggedIn) return;

    this.loginPromise = this._doLogin();
    try {
      await this.loginPromise;
    } finally {
      this.loginPromise = null;
    }
  }

  async _doLogin() {
    const username = process.env.IG_USERNAME;
    const password = process.env.IG_PASSWORD;

    if (!username || !password) {
      throw new Error('IG_USERNAME and IG_PASSWORD environment variables are required for reel downloads.');
    }

    this.ig.state.generateDevice(username);

    if (fs.existsSync(SESSION_FILE)) {
      try {
        const savedSession = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
        await this.ig.state.deserialize(savedSession);
        
        await this.ig.account.currentUser();
        
        this.isLoggedIn = true;
        console.log('[IG-DL] Session restored successfully');
        return;
      } catch (err) {
        console.warn(`[IG-DL] Saved session invalid or expired: ${err.message}. Performing fresh login...`);
        
        try { fs.unlinkSync(SESSION_FILE); } catch (e) {}
      }
    }

    try {
      console.log(`[IG-DL] Logging in as @${username}...`);
      
      await this.ig.simulate.preLoginFlow();
      
      const loggedInUser = await this.ig.account.login(username, password);
      console.log(`[IG-DL] Logged in as @${loggedInUser.username} (ID: ${loggedInUser.pk})`);

      try {
        await this.ig.simulate.postLoginFlow();
      } catch (e) {
        
      }

      const serialized = await this.ig.state.serialize();
      
      delete serialized.constants;
      delete serialized.supportedCapabilities;
      fs.writeFileSync(SESSION_FILE, JSON.stringify(serialized), { encoding: 'utf8', mode: 0o600 });
      console.log('[IG-DL] Session saved to disk');

      this.isLoggedIn = true;
    } catch (err) {
      this.isLoggedIn = false;
      
      const isCheckpoint = err.name === 'IgCheckpointError' || 
                           err.name === 'IgChallengeRequiredError' ||
                           (err.message && (err.message.includes('checkpoint_required') || err.message.includes('challenge_required')));

      console.log(`[IG-DL] Login catch block error name: ${err.name}`);
      if (err.response) {
        console.log(`[IG-DL] Response status: ${err.response.statusCode}`);
        if (err.response.body && typeof err.response.body === 'object') {
          console.log(`[IG-DL] Response message: ${err.response.body.message || 'None'}`);
        }
      }

      if (isCheckpoint) {
        throw new Error('Instagram checkpoint/verification required. Please import active cookies from your browser via POST /ig/session/import.');
      }

      if (err.name === 'IgLoginTwoFactorRequiredError') {
        throw new Error('Instagram 2FA required. Disable 2FA on the download account.');
      }

      throw new Error(`Instagram login failed: ${err.message}`);
    }
  }

  extractShortcode(url) {
    const match = url.match(/\/(reel|reels|p)\/([A-Za-z0-9_-]+)/);
    return match ? match[2] : null;
  }

  shortcodeToMediaId(shortcode) {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    let id = BigInt(0);
    for (const char of shortcode) {
      id = id * BigInt(64) + BigInt(alphabet.indexOf(char));
    }
    return id.toString();
  }

  async resolveVideoUrl(instagramUrl) {
    await this.login();

    const shortcode = this.extractShortcode(instagramUrl);
    if (!shortcode) {
      throw new Error(`Could not extract shortcode from URL: ${instagramUrl}`);
    }

    const mediaId = this.shortcodeToMediaId(shortcode);
    console.log(`[IG-DL] Resolving video URL for shortcode: ${shortcode} (media ID: ${mediaId})`);

    try {
      const mediaInfo = await this.ig.media.info(mediaId);

      if (!mediaInfo || !mediaInfo.items || mediaInfo.items.length === 0) {
        throw new Error('No media info returned from Instagram API');
      }

      const item = mediaInfo.items[0];

      if (item.media_type !== 2) { 
        throw new Error(`Media is not a video (type: ${item.media_type})`);
      }

      const videoVersions = item.video_versions;
      if (!videoVersions || videoVersions.length === 0) {
        throw new Error('No video versions found in media info');
      }

      const bestVideo = videoVersions[0];
      console.log(`[IG-DL] Resolved video URL (${bestVideo.width}x${bestVideo.height})`);

      return {
        videoUrl: bestVideo.url,
        width: bestVideo.width,
        height: bestVideo.height,
        caption: item.caption ? item.caption.text : '',
        duration: item.video_duration || 0,
        author: item.user ? item.user.username : '',
      };
    } catch (err) {
      
      const isSessionExpired = err.name === 'IgLoginRequiredError' || 
                               err.name === 'IgCheckpointError' ||
                               err.name === 'IgChallengeRequiredError' ||
                               (err.message && (err.message.includes('login_required') || err.message.includes('checkpoint')));

      if (isSessionExpired) {
        console.warn('[IG-DL] Session expired or checkpoint triggered. Re-logging in...');
        this.isLoggedIn = false;
        try { fs.unlinkSync(SESSION_FILE); } catch (e) {}
        
        await this.login();
        
        const mediaInfo = await this.ig.media.info(mediaId);
        if (mediaInfo && mediaInfo.items && mediaInfo.items.length > 0) {
          const item = mediaInfo.items[0];
          if (item.video_versions && item.video_versions.length > 0) {
            return {
              videoUrl: item.video_versions[0].url,
              width: item.video_versions[0].width,
              height: item.video_versions[0].height,
              caption: item.caption ? item.caption.text : '',
              duration: item.video_duration || 0,
              author: item.user ? item.user.username : '',
            };
          }
        }
      }
      
      throw new Error(`Failed to resolve video URL: ${err.message}`);
    }
  }

  async downloadFromUrl(videoUrl, targetPath) {
    console.log(`[IG-DL] Downloading video to: ${path.basename(targetPath)}`);

    const response = await axios({
      url: videoUrl,
      method: 'GET',
      responseType: 'stream',
      timeout: 45000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      },
    });

    const contentType = response.headers['content-type'] || '';
    const isValidType = contentType.startsWith('video/') || contentType === 'application/octet-stream' || contentType === '';
    if (!isValidType) {
      try { response.data.destroy(); } catch (e) {}
      throw new Error(`Invalid content type: "${contentType}" (expected video)`);
    }

    const contentLength = parseInt(response.headers['content-length'], 10);
    if (!isNaN(contentLength) && contentLength > MAX_VIDEO_SIZE) {
      try { response.data.destroy(); } catch (e) {}
      throw new Error(`Video too large: ${(contentLength / 1024 / 1024).toFixed(1)}MB (limit: ${MAX_VIDEO_SIZE / 1024 / 1024}MB)`);
    }

    return new Promise((resolve, reject) => {
      const writer = fs.createWriteStream(targetPath);
      let bytesWritten = 0;
      let finished = false;

      let timeout;

      const cleanup = (err) => {
        if (finished) return;
        finished = true;
        if (timeout) clearTimeout(timeout);
        try { writer.destroy(); } catch (e) {}
        try { response.data.destroy(); } catch (e) {}
        if (err) {
          fs.unlink(targetPath, () => {});
          reject(err);
        }
      };

      timeout = setTimeout(() => {
        cleanup(new Error('Download timeout (45s)'));
      }, 45000);

      response.data.on('data', (chunk) => {
        bytesWritten += chunk.length;
        if (bytesWritten > MAX_VIDEO_SIZE) {
          cleanup(new Error('Video exceeded size limit during download'));
        }
      });

      response.data.pipe(writer);

      writer.on('finish', () => {
        if (finished) return;
        finished = true;
        if (timeout) clearTimeout(timeout);

        try {
          const stats = fs.statSync(targetPath);
          if (stats.size < 1024) {
            fs.unlinkSync(targetPath);
            reject(new Error('Downloaded file too small to be a valid video'));
            return;
          }
          console.log(`[IG-DL] Download complete: ${(stats.size / 1024 / 1024).toFixed(2)}MB`);
          resolve();
        } catch (e) {
          reject(new Error(`Failed to verify download: ${e.message}`));
        }
      });

      writer.on('error', (err) => {
        cleanup(new Error(`Write error: ${err.message}`));
      });

      response.data.on('error', (err) => {
        cleanup(new Error(`Stream error: ${err.message}`));
      });

    });
  }

  async downloadReel(instagramUrl, targetPath) {
    const resolved = await this.resolveVideoUrl(instagramUrl);
    await this.downloadFromUrl(resolved.videoUrl, targetPath);
    
    return {
      videoUrl: resolved.videoUrl,
      targetPath,
      caption: resolved.caption,
      author: resolved.author,
      duration: resolved.duration,
      width: resolved.width,
      height: resolved.height,
    };
  }

  async importCookies(cookieString) {
    if (!cookieString || cookieString.trim() === '') {
      throw new Error('Cookie string cannot be empty');
    }

    const username = process.env.IG_USERNAME;
    if (!username) {
      throw new Error('IG_USERNAME must be configured in .env');
    }

    console.log(`[IG-DL] Importing browser cookies for @${username}...`);
    this.ig.state.generateDevice(username);

    const decodedCookies = decodeURIComponent(cookieString);

    const parts = decodedCookies.split(';');
    for (const part of parts) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      try {
        await this.ig.state.cookieJar.setCookie(
          `${trimmed}; Domain=.instagram.com; Path=/; Secure; HttpOnly`,
          'https://instagram.com'
        );
      } catch (cookieErr) {
        console.warn(`[IG-DL] Failed to set cookie part "${trimmed}":`, cookieErr.message);
      }
    }

    try {
      console.log('[IG-DL] Verifying imported session via currentUser...');
      const currentUser = await this.ig.account.currentUser();
      console.log(`[IG-DL] Session verified! Logged in as: @${currentUser.username} (ID: ${currentUser.pk})`);

      const serialized = await this.ig.state.serialize();
      delete serialized.constants;
      delete serialized.supportedCapabilities;
      fs.writeFileSync(SESSION_FILE, JSON.stringify(serialized), { encoding: 'utf8', mode: 0o600 });

      this.isLoggedIn = true;
      console.log('[IG-DL] Session state serialized and saved to disk.');

      return { status: 'success', username: username, message: 'Cookies imported and verified successfully!' };
    } catch (err) {
      console.error('[IG-DL] Failed to verify imported cookies:', err.message);
      throw new Error(`Cookies verification failed: ${err.message}. Make sure you copied the correct cookies and are logged in.`);
    }
  }
}

module.exports = new InstagramDownloader();
