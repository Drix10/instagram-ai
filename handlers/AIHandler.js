const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const util = require('util');
const execFilePromise = util.promisify(execFile);

const AI_MODEL = 'google/gemini-3.5-flash';
const API_TIMEOUT_MS = 60000;

class AIHandler {
  constructor(client) {
    this.client = client;
    this.apiKey = process.env.MESH_API_KEY;
    this.tempDir = path.join(__dirname, '../temp');
    if (!fs.existsSync(this.tempDir)) fs.mkdirSync(this.tempDir, { recursive: true });
  }

  cleanJsonText(text) {
    let clean = text.trim();
    const match = clean.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (match && match[1]) clean = match[1].trim();
    const firstBrace = clean.indexOf('{');
    const lastBrace = clean.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) clean = clean.substring(firstBrace, lastBrace + 1);
    return clean.trim();
  }

  async checkFFmpeg() {
    try { await execFilePromise('ffmpeg', ['-version'], { timeout: 5000 }); return true; }
    catch (err) { return false; }
  }

  async extractAudio(v, a) { await execFilePromise('ffmpeg', ['-i', v, '-vn', '-ar', '16000', '-ac', '1', '-c:a', 'libmp3lame', a, '-y'], { timeout: 30000 }); }

  async extractFrames(v, d) {
    const p = path.join(d, 'frame_%03d.jpg');
    await execFilePromise('ffmpeg', ['-i', v, '-vf', 'fps=1/10', '-q:v', '2', p, '-y'], { timeout: 30000 });
    let f = fs.readdirSync(d);
    if (f.length === 0) {
      await execFilePromise('ffmpeg', ['-i', v, '-ss', '00:00:01', '-vframes', '1', '-q:v', '2', path.join(d, 'frame_001.jpg'), '-y'], { timeout: 15000 });
      f = fs.readdirSync(d);
    }
    return f.map(x => path.join(d, x));
  }

  async transcribeAudio(a) {
    const formData = new FormData();
    formData.append('file', new Blob([fs.readFileSync(a)], { type: 'audio/mp3' }), 'audio.mp3');
    formData.append('model', 'openai/whisper-large-v3-turbo');
    const res = await axios.post('https://api.meshapi.ai/v1/audio/transcriptions', formData, { headers: { 'Authorization': `Bearer ${this.apiKey}` }, timeout: API_TIMEOUT_MS });
    return res.data.text || '';
  }

  async postWithTimeout(url, data, timeoutMs) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try { return await axios.post(url, data, { headers: { 'Authorization': `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' }, signal: controller.signal }); }
    finally { clearTimeout(timeoutId); }
  }

  async downloadFallbackMedia(url, base) {
    const res = await axios({ url, method: 'GET', responseType: 'stream', timeout: 45000 });
    const ct = res.headers['content-type'] || '';
    if (!ct.startsWith('video/') && !ct.startsWith('image/')) { res.data.destroy(); throw new Error(`Unsupported type: ${ct}`); }
    const cl = parseInt(res.headers['content-length'], 10);
    if (!isNaN(cl) && cl > 35 * 1024 * 1024) { res.data.destroy(); throw new Error('Too large'); }
    const ext = ct.startsWith('image/') ? (ct.includes('png') ? 'png' : 'jpg') : 'mp4';
    const target = path.join(this.tempDir, `${base}_0.${ext}`);
    const writer = fs.createWriteStream(target);
    let bytes = 0;
    try {
      await new Promise((resolve, reject) => {
        res.data.on('data', (c) => {
          bytes += c.length;
          if (bytes > 35 * 1024 * 1024) { 
            res.data.destroy(); 
            writer.destroy();
            reject(new Error('Limit exceeded')); 
          }
        });
        res.data.pipe(writer);
        writer.on('finish', resolve);
        writer.on('error', (e) => { res.data.destroy(); reject(e); });
        res.data.on('error', (e) => { writer.destroy(); reject(e); });
      });
      return { path: target, mimeType: ct.startsWith('image/') ? (ct.includes('png') ? 'image/png' : 'image/jpeg') : 'video/mp4' };
    } catch (err) {
      if (fs.existsSync(target)) try { fs.unlinkSync(target); } catch (e) {}
      throw err;
    }
  }

  async transcribeReel(instagramId, reelUrl, captionText, messageId = null, username = null, needsCarouselResolution = false, carouselPayload = null, retries = 2) {
    if (!this.apiKey) throw new Error('Mesh API key not set');
    const schema = {
      type: 'object',
      properties: {
        title: { type: 'string' }, summary: { type: 'string' },
        category: { type: 'string', enum: ['study', 'project', 'resource', 'tips', 'other'] },
        resourceDetails: { type: 'object', properties: { resources: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, type: { type: 'string' }, description: { type: 'string' }, url: { type: 'string' } }, required: ['name'] } } } },
        timetableSuggestions: { type: 'array', items: { type: 'object', properties: { day: { type: 'string' }, time: { type: 'string' }, activity: { type: 'string' }, notes: { type: 'string' } }, required: ['day', 'activity'] } }
      },
      required: ['title', 'summary', 'category']
    };
    const base = `reel_${instagramId}_${Date.now()}`;
    const igDl = require('../utils/instagram-downloader');
    const { resolveCarouselFromThread } = require('../utils/carousel-resolver');
    let mediaFiles = [];
    let caption = captionText || '';
    let speech = '';
    let frames = [];
    const isFF = await this.checkFFmpeg();

    try {
      if (username && captionText) {
        try {
          const result = await resolveCarouselFromThread(username, captionText, this.tempDir);
          if (result && result.mediaFiles?.length > 0) {
            mediaFiles = result.mediaFiles;
            if (result.caption) caption = result.caption;
          }
        } catch (e) {}
      }

      if (mediaFiles.length === 0) {
        const urls = Array.isArray(reelUrl) ? reelUrl : [reelUrl];
        for (let u = 0; u < urls.length; u++) {
          const item = urls[u];
          const cUrl = typeof item === 'string' ? item : (item.url || item.fallbackUrl);
          const mId = typeof item === 'object' ? item.mediaId : null;
          try {
            const input = mId ? `https://www.instagram.com/p/${mId}/` : cUrl;
            if (input) {
              const res = await igDl.downloadMedia(input, this.tempDir, `${base}_u${u}`);
              if (res.mediaFiles?.length > 0) {
                mediaFiles.push(...res.mediaFiles);
                if (res.caption) caption = (caption ? caption + '\n' : '') + res.caption;
              }
            }
          } catch (e) {
            const fUrl = typeof item === 'object' ? item.fallbackUrl : null;
            if (fUrl && mediaFiles.length === 0) {
              mediaFiles.push(await this.downloadFallbackMedia(fUrl, `${base}_u${u}`));
            }
          }
        }
      }

      for (let i = 0; i < mediaFiles.length; i++) {
        const m = mediaFiles[i];
        if (m && fs.existsSync(m.path)) {
          if (m.mimeType.startsWith('video/') && isFF) {
            const d = path.join(this.tempDir, `frames_${base}_${i}`);
            const a = path.join(this.tempDir, `${base}_${i}_audio.mp3`);
            if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
            try {
              await this.extractAudio(m.path, a);
              if (fs.existsSync(a)) {
                const t = await this.transcribeAudio(a);
                if (t) speech += (speech ? '\n' : '') + t.replace(/\[music\]|\[ambient\]|\[noise\]|\(music\)|\(ambient\)|\(noise\)|♪|♫/gi, '').trim();
              }
            } catch (e) {} finally { if (fs.existsSync(a)) try { fs.unlinkSync(a); } catch (e) {} }
            try { frames.push(...(await this.extractFrames(m.path, d))); } catch (e) {}
          } else if (m.mimeType.startsWith('image/')) {
            if (fs.statSync(m.path).size <= 5 * 1024 * 1024) frames.push(m.path);
          }
        }
      }

      let prompt = `You are an expert educational content analyzer. Analyze the shared Instagram media (and its accompanying transcript/caption) and extract the following:
      1. Title: Create a concise, clean, search-friendly title of what the shared post teaches (exclude hashtags, emojis, and social media clutter).
      2. Summary: Provide a clear, actionable summary of the core concepts, step-by-step guides, or advice shown in the reel. 
         CRITICAL: Do NOT use markdown formatting (no headers, no bold syntax like **text**, no blockquotes). Instagram DMs do not render markdown. Use simple line breaks and plain text bullet points (•) only.
      3. Category: Select the best match from 'study', 'project', 'resource', 'tips', or 'other'.
      4. Resources & Links: Extract all links, URLs, tools, or books mentioned. Reconstruct spoken URLs if necessary (e.g. 'react dot dev' -> 'https://react.dev').
      5. Timetable Suggestions: Recommend logical schedule slots to insert this study content into a weekly timetable.
      Output strictly as structured JSON matching the provided schema.`;

      if (caption) prompt += `\n\nCaption:\n${caption}`;
      if (speech) prompt += `\n\nTranscript:\n${speech}`;

      const content = [{ type: 'text', text: prompt }];
      for (const f of frames.slice(0, 10)) if (fs.existsSync(f)) content.push({ type: 'image_url', image_url: { url: `data:${path.extname(f).toLowerCase() === '.png' ? 'image/png' : 'image/jpeg'};base64,${fs.readFileSync(f, { encoding: 'base64' })}` } });
      const res = await this.postWithTimeout('https://api.meshapi.ai/v1/chat/completions', { model: AI_MODEL, messages: [{ role: 'user', content }], temperature: 0, response_format: { type: 'json_schema', json_schema: { name: 'ReelNoteSchema', schema } } }, API_TIMEOUT_MS);
      return JSON.parse(this.cleanJsonText(res.data.choices[0].message.content));
    } catch (error) {
      const errMsg = error?.message || '';
      if (retries > 0 && !errMsg.includes('login')) { await new Promise(r => setTimeout(r, 2000)); return this.transcribeReel(instagramId, reelUrl, captionText, messageId, username, needsCarouselResolution, carouselPayload, retries - 1); }
      throw error;
    } finally {
      for (let i = 0; i < mediaFiles.length; i++) {
        const d = path.join(this.tempDir, `frames_${base}_${i}`);
        if (fs.existsSync(d)) try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {}
      }
      for (const m of mediaFiles) if (m && m.path && fs.existsSync(m.path)) try { fs.unlinkSync(m.path); } catch (e) {}
    }
  }

  async generateChatResponse(timetable, chatHistory, latestInput, blockers = []) {
    if (!this.apiKey) return JSON.stringify({ reply: "API not set", action: "none" });
    try {
      const system = `You are ReeF, a friendly and highly organized study assistant operating inside Instagram DMs. 
      Your goal is to help the user manage their learning timetable, deadlines, and study resources. Keep replies concise, conversational, and use emojis appropriately.

      CRITICAL: You must ALWAYS output a valid JSON object matching this structure: {"reply": "Your conversational response", "action": "none|add_timetable|add_reminder|add_deadline|create_note|view_timetable|view_reminders|view_deadlines|view_notes", "actionData": { ... }}

      Action Triggers:
      - If the user asks to schedule study time, set action="add_timetable" and provide {day, time, activity}.
      - If the user asks for a reminder, set action="add_reminder" and provide {reminderActivity, reminderTime, reminderRepeat}.
      - If the user mentions an upcoming exam or due date, proactively set action="add_deadline" and provide {deadlineName, deadlineEndDate}.
      - If the user asks to save a note, set action="create_note" and provide {noteTitle, noteSummary}.
      - If the user asks to see their schedule, timetable, or upcoming classes, set action="view_timetable".
      - If the user asks to see their reminders or alerts, set action="view_reminders".
      - If the user asks to see their deadlines or tasks, set action="view_deadlines".
      - If the user asks to see their saved notes or resources, set action="view_notes".
      If no specific action is requested or implied, set action="none".`;
      
      const messages = [{ role: 'system', content: system }];
      if (chatHistory) chatHistory.slice(-5).forEach(m => messages.push({ role: m.role === 'model' ? 'assistant' : m.role, content: m.text }));
      messages.push({ role: 'user', content: latestInput });
      const res = await this.postWithTimeout('https://api.meshapi.ai/v1/chat/completions', { model: AI_MODEL, messages, response_format: { type: 'json_object' } }, API_TIMEOUT_MS);
      return this.cleanJsonText(res.data.choices[0].message.content);
    } catch (e) { return JSON.stringify({ reply: "Error. Try again.", action: "none" }); }
  }
}

module.exports = AIHandler;
