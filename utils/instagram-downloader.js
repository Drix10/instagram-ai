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
    if (this.loginPromise) return this.loginPromise;
    if (this.isLoggedIn) return;
    this.loginPromise = this._doLogin();
    try { await this.loginPromise; } finally { this.loginPromise = null; }
  }

  async _doLogin() {
    const u = process.env.IG_USERNAME;
    const p = process.env.IG_PASSWORD;
    if (!u || !p) throw new Error('IG_USERNAME/IG_PASSWORD required.');
    this.ig.state.generateDevice(u);
    if (fs.existsSync(SESSION_FILE)) {
      try {
        await this.ig.state.deserialize(JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8')));
        await this.ig.account.currentUser();
        this.isLoggedIn = true;
        return;
      } catch (err) {
        try { fs.unlinkSync(SESSION_FILE); } catch (e) {}
      }
    }
    await this._doFreshLogin(u, p);
  }

  async _doFreshLogin(u, p) {
    try {
      await this.ig.simulate.preLoginFlow();
      await this.ig.account.login(u, p);
      try { await this.ig.simulate.postLoginFlow(); } catch (e) {}
      const s = await this.ig.state.serialize();
      delete s.constants; delete s.supportedCapabilities;
      fs.writeFileSync(SESSION_FILE, JSON.stringify(s), { encoding: 'utf8', mode: 0o600 });
      this.isLoggedIn = true;
    } catch (err) {
      this.isLoggedIn = false;
      if (err.name?.includes('Checkpoint') || err.message?.includes('checkpoint')) throw new Error('Checkpoint required.');
      throw new Error(`Login failed: ${err.message}`);
    }
  }

  async getCookieString() {
    await this.login();
    return (await this.ig.state.cookieJar.getCookies('https://instagram.com')).map(c => `${c.key}=${c.value}`).join('; ');
  }

  extractShortcode(url) {
    if (!url) return null;
    const m = url.match(/\/(reel|reels|p)\/([A-Za-z0-9_-]+)/);
    return m ? m[2] : null;
  }

  shortcodeToMediaId(sc) {
    const a = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    let id = BigInt(0);
    for (const c of sc) id = id * BigInt(64) + BigInt(a.indexOf(c));
    return id.toString();
  }

  async downloadFromUrl(url, target) {
    const res = await axios({ url, method: 'GET', responseType: 'stream', timeout: 45000, headers: { 'User-Agent': 'Mozilla/5.0' } });
    const ct = res.headers['content-type'] || '';
    if (!ct.startsWith('video/') && !ct.startsWith('image/') && ct !== 'application/octet-stream' && ct !== '') {
      try { res.data.destroy(); } catch (e) {}
      throw new Error(`Invalid type: ${ct}`);
    }
    return new Promise((resolve, reject) => {
      const w = fs.createWriteStream(target);
      let bw = 0, f = false;
      const clean = (err) => { if (f) return; f = true; try { w.destroy(); } catch (e) {} try { res.data.destroy(); } catch (e) {} if (err) { try { fs.unlinkSync(target); } catch (e) {} reject(err); } };
      res.data.on('data', (c) => { bw += c.length; if (bw > MAX_VIDEO_SIZE) clean(new Error('Exceeded limit')); });
      res.data.pipe(w);
      w.on('finish', () => { if (f) return; f = true; resolve(); });
      w.on('error', clean); res.data.on('error', clean);
    });
  }

  async resolveMediaItems(url) {
    await this.login();
    const sc = this.extractShortcode(url);
    if (!sc) throw new Error('No shortcode');
    const mid = sc.match(/^\d{15,}$/) ? sc : this.shortcodeToMediaId(sc);
    const extract = (info) => {
      const item = info.items[0], list = [];
      if (item.media_type === 8 && item.carousel_media) {
        for (const s of item.carousel_media.slice(0, 10)) {
          if (s.media_type === 2) list.push({ type: 'video', url: s.video_versions[0].url, mimeType: 'video/mp4' });
          else list.push({ type: 'image', url: s.image_versions2.candidates[0].url, mimeType: 'image/jpeg' });
        }
      } else if (item.media_type === 2) list.push({ type: 'video', url: item.video_versions[0].url, mimeType: 'video/mp4' });
      else if (item.media_type === 1) list.push({ type: 'image', url: item.image_versions2.candidates[0].url, mimeType: 'image/jpeg' });
      return { items: list, caption: item.caption?.text || '', author: item.user?.username || '' };
    };
    try {
      const info = await this.ig.media.info(mid);
      if (!info || !info.items || info.items.length === 0) throw new Error('No info');
      return extract(info);
    } catch (err) {
      const errMsg = err?.message || '';
      if (errMsg.includes('login_required') || errMsg.includes('checkpoint')) {
        this.isLoggedIn = false; try { fs.unlinkSync(SESSION_FILE); } catch (e) {}
        await this.login();
        const info2 = await this.ig.media.info(mid);
        if (!info2 || !info2.items || info2.items.length === 0) throw new Error('No info on second attempt');
        return extract(info2);
      }
      throw err;
    }
  }

  async downloadMedia(url, dir, base) {
    const res = await this.resolveMediaItems(url);
    const files = [];
    try {
      for (let i = 0; i < res.items.length; i++) {
        const item = res.items[i];
        const p = path.join(dir, `${base}_${i}.${item.type === 'video' ? 'mp4' : 'jpg'}`);
        await this.downloadFromUrl(item.url, p);
        files.push({ path: p, mimeType: item.mimeType });
      }
      return { mediaFiles: files, caption: res.caption, author: res.author };
    } catch (err) { for (const f of files) try { fs.unlinkSync(f.path); } catch (e) {} throw err; }
  }

  async importCookies(cookieString) {
    const u = process.env.IG_USERNAME; if (!u) throw new Error('IG_USERNAME missing');
    this.ig.state.generateDevice(u);
    for (const part of decodeURIComponent(cookieString).split(';')) {
      const t = part.trim(); if (t) try { await this.ig.state.cookieJar.setCookie(`${t}; Domain=.instagram.com; Path=/; Secure; HttpOnly`, 'https://instagram.com'); } catch (e) {}
    }
    const s = await this.ig.state.serialize();
    delete s.constants; delete s.supportedCapabilities;
    fs.writeFileSync(SESSION_FILE, JSON.stringify(s), { encoding: 'utf8', mode: 0o600 });
    this.isLoggedIn = true;
    return { status: 'success', username: u };
  }
}

module.exports = new InstagramDownloader();
