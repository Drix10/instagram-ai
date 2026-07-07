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
    if (!this.apiKey) {
      console.warn('[AI] Missing MESH_API_KEY environment variable. AI features will not work.');
    }
    
    this.tempDir = path.join(__dirname, '../temp');
    if (!fs.existsSync(this.tempDir)) {
      fs.mkdirSync(this.tempDir, { recursive: true });
    }
  }

  cleanJsonText(text) {
    let clean = text.trim();
    const match = clean.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (match && match[1]) {
      clean = match[1].trim();
    }
    const firstBrace = clean.indexOf('{');
    const lastBrace = clean.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      clean = clean.substring(firstBrace, lastBrace + 1);
    }
    return clean.trim();
  }

  async checkFFmpeg() {
    try {
      await execFilePromise('ffmpeg', ['-version'], { timeout: 5000 });
      return true;
    } catch (err) {
      console.warn('[AI] FFmpeg is not available in system path. Video/audio extraction is disabled.');
      return false;
    }
  }

  async extractAudio(videoPath, audioOutputPath) {
    const args = [
      '-i', videoPath,
      '-vn',
      '-ar', '16000',
      '-ac', '1',
      '-c:a', 'libmp3lame',
      audioOutputPath,
      '-y'
    ];
    await execFilePromise('ffmpeg', args, { timeout: 30000 });
  }

  async extractFrames(videoPath, framesDir) {
    const pattern = path.join(framesDir, 'frame_%03d.jpg');
    const args = [
      '-i', videoPath,
      '-vf', 'fps=1/10',
      '-q:v', '2',
      pattern,
      '-y'
    ];
    await execFilePromise('ffmpeg', args, { timeout: 30000 });
    
    let files = fs.readdirSync(framesDir);
    if (files.length === 0) {
      console.log('[AI] Short video. Extracting fallback frame at 1s...');
      const fallbackPattern = path.join(framesDir, 'frame_001.jpg');
      const fallbackArgs = [
        '-i', videoPath,
        '-ss', '00:00:01',
        '-vframes', '1',
        '-q:v', '2',
        fallbackPattern,
        '-y'
      ];
      await execFilePromise('ffmpeg', fallbackArgs, { timeout: 15000 });
      files = fs.readdirSync(framesDir);
    }
    return files.map(file => path.join(framesDir, file));
  }

  async transcribeAudio(audioPath) {
    if (!fs.existsSync(audioPath)) {
      throw new Error(`Audio file does not exist: ${audioPath}`);
    }

    const formData = new FormData();
    const fileBuffer = fs.readFileSync(audioPath);
    const blob = new Blob([fileBuffer], { type: 'audio/mp3' });
    
    formData.append('file', blob, 'audio.mp3');
    formData.append('model', 'openai/whisper-large-v3-turbo');

    console.log('[AI] Sending audio to Whisper for transcription...');
    const response = await axios.post('https://api.meshapi.ai/v1/audio/transcriptions', formData, {
      headers: {
        'Authorization': `Bearer ${this.apiKey}`
      },
      timeout: API_TIMEOUT_MS
    });

    return response.data.text || '';
  }

  async postWithTimeout(url, data, timeoutMs) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, timeoutMs);

    try {
      const response = await axios.post(url, data, {
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json'
        },
        signal: controller.signal
      });
      return response;
    } catch (err) {
      if (err.name === 'CanceledError' || axios.isCancel(err) || err.code === 'ERR_CANCELED') {
        throw new Error(`API operation timeout after ${timeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async downloadVideo(url, targetPath) {
    if (url.includes('instagram.com/')) {
      try {
        const igDownloader = require('../utils/instagram-downloader');
        console.log(`[AI] Downloading Reel via authenticated IG session for: ${url}`);
        await igDownloader.downloadReel(url, targetPath);
        console.log(`[AI] Download completed successfully via IG login method`);
        return;
      } catch (igErr) {
        console.warn(`[AI] IG login download failed: ${igErr.message}. Trying fallback...`);
      }
    }

    const downloadUrl = url;
    console.log(`[AI] Downloading video via direct URL: ${downloadUrl.substring(0, 80)}...`);

    const response = await axios({
      url: downloadUrl,
      method: 'GET',
      responseType: 'stream',
      timeout: 45000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });

    const contentType = response.headers['content-type'] || '';
    const isClearlyInvalid = contentType.includes('text/html') || contentType.includes('text/plain') || contentType.includes('application/json');
    const isValidType = contentType.includes('video/') || contentType.includes('application/octet-stream') || contentType === '';

    if (!isValidType || isClearlyInvalid) {
      try { response.data.destroy(); } catch (e) {}
      throw new Error(`Invalid content type: received "${contentType}" instead of video`);
    }

    const stream = response.data;
    const contentLength = parseInt(response.headers['content-length'], 10);
    const limitBytes = 35 * 1024 * 1024;

    if (!isNaN(contentLength) && contentLength > limitBytes) {
      try { stream.destroy(); } catch (e) {}
      throw new Error('File size exceeds the 35MB limit');
    }

    return new Promise((resolve, reject) => {
      const writer = fs.createWriteStream(targetPath);
      let bytesWritten = 0;
      let settled = false;

      let stallTimer = setTimeout(() => {
        finish(new Error('Download stalled (no data for 60s)'));
      }, 60000);

      const resetStallTimer = () => {
        if (settled) return;
        if (stallTimer) clearTimeout(stallTimer);
        stallTimer = setTimeout(() => {
          finish(new Error('Download stalled (no data for 60s)'));
        }, 60000);
      };

      const finish = (err) => {
        if (settled) return;
        settled = true;
        if (stallTimer) { clearTimeout(stallTimer); stallTimer = null; }
        try { stream.destroy(); } catch (e) {}
        try { writer.destroy(); } catch (e) {}
        if (err) {
          fs.unlink(targetPath, () => {});
          reject(err);
        } else {
          resolve();
        }
      };

      stream.on('data', (chunk) => {
        bytesWritten += chunk.length;
        resetStallTimer();
        if (bytesWritten > limitBytes) {
          finish(new Error('File size exceeded the 35MB limit during download'));
        }
      });

      stream.pipe(writer);

      writer.on('finish', () => {
        finish(null);
      });

      writer.on('error', (err) => {
        finish(new Error(`Write error: ${err.message}`));
      });

      stream.on('error', (err) => {
        finish(new Error(`Stream error: ${err.message}`));
      });
    });
  }

  async transcribeReel(instagramId, reelUrl, captionText, retries = 2) {
    if (!this.apiKey) {
      throw new Error('Mesh API key is not configured. Please add MESH_API_KEY in settings.');
    }

    const responseSchema = {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'What is this video/reel about? E.g., Learn SQL in 10 Days' },
        summary: { type: 'string', description: 'Brief transcription and summary of the key tips, steps, links, or advice shown in the reel.' },
        category: { 
          type: 'string', 
          enum: ['study', 'project', 'resource', 'tips', 'other'], 
          description: 'The category that matches the reel contents.' 
        },
        resourceDetails: {
          type: 'object',
          properties: {
            resources: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string', description: 'Resource, book, website, tool, or step name, e.g. React Docs' },
                  type: { type: 'string', description: 'Type of resource: book, link, tool, step, video, custom' },
                  description: { type: 'string', description: 'Description or notes about this specific resource/step.' }
                },
                required: ['name'],
                additionalProperties: false
              }
            }
          },
          additionalProperties: false
        },
        timetableSuggestions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              day: { type: 'string', description: 'Recommended day of the week to study/work on this, e.g. Monday, Tuesday. Choose a logical day if none is mentioned.' },
              time: { type: 'string', description: 'Recommended time of the day in 24h format, e.g., 09:00, 15:30. Default to 09:00 if not specified.' },
              activity: { type: 'string', description: 'Learning activity description.' },
              notes: { type: 'string', description: 'Any extra notes.' }
            },
            required: ['day', 'activity'],
            additionalProperties: false
          }
        }
      },
      required: ['title', 'summary', 'category'],
      additionalProperties: false
    };

    const baseName = `reel_${instagramId}_${Date.now()}`;
    const igDownloader = require('../utils/instagram-downloader');
    
    let mediaFiles = [];
    let caption = captionText || '';
    let speechTranscript = '';
    let visualFrames = [];

    const isFFmpegAvailable = await this.checkFFmpeg();

    try {
      console.log(`[AI] Downloading post media from URL for user ${instagramId}...`);
      try {
        const result = await igDownloader.downloadMedia(reelUrl, this.tempDir, baseName);
        mediaFiles = result.mediaFiles || [];
        if (result.caption) {
          caption = result.caption;
        }
        console.log(`[AI] Download completed. Ingested ${mediaFiles.length} media files`);
      } catch (igErr) {
        console.warn(`[AI] IG media download failed: ${igErr.message}. Falling back to direct video download...`);
        const tempFileName = `${baseName}_0.mp4`;
        const tempFilePath = path.join(this.tempDir, tempFileName);
        mediaFiles = [{ path: tempFilePath, mimeType: 'video/mp4' }];
        await this.downloadVideo(reelUrl, tempFilePath);
      }

      console.log('[AI] Processing media files...');
      
      const content = [];

      for (let i = 0; i < mediaFiles.length; i++) {
        const media = mediaFiles[i];
        if (fs.existsSync(media.path)) {
          if (media.mimeType.startsWith('video/')) {
            if (isFFmpegAvailable) {
              const framesDir = path.join(this.tempDir, `frames_${baseName}_${i}`);
              const audioOutputPath = path.join(this.tempDir, `${baseName}_${i}_audio.mp3`);
              
              if (!fs.existsSync(framesDir)) {
                fs.mkdirSync(framesDir, { recursive: true });
              }

              try {
                console.log(`[AI] Extracting audio from video: ${media.path}`);
                await this.extractAudio(media.path, audioOutputPath);
                
                if (fs.existsSync(audioOutputPath)) {
                  console.log(`[AI] Transcribing extracted audio: ${audioOutputPath}`);
                  const transcript = await this.transcribeAudio(audioOutputPath);
                  if (transcript) {
                    const cleaned = transcript.replace(/\[music\]|\[ambient\]|\[noise\]|\(music\)|\(ambient\)|\(noise\)|♪|♫/gi, '').trim();
                    if (cleaned.length > 0) {
                      speechTranscript += (speechTranscript ? '\n' : '') + cleaned;
                    }
                  }
                }
              } catch (audioErr) {
                console.warn(`[AI] Audio extraction/transcription skipped or failed: ${audioErr.message}`);
              } finally {
                if (fs.existsSync(audioOutputPath)) {
                  try {
                    fs.unlinkSync(audioOutputPath);
                  } catch (e) {}
                }
              }

              try {
                console.log(`[AI] Extracting keyframes from video: ${media.path}`);
                const framePaths = await this.extractFrames(media.path, framesDir);
                visualFrames.push(...framePaths);
              } catch (frameErr) {
                console.warn(`[AI] Vision keyframe extraction skipped or failed: ${frameErr.message}`);
              }
            } else {
              console.log('[AI] FFmpeg not available. Skipping deep video/audio processing.');
            }
          } else if (media.mimeType.startsWith('image/')) {
            const stats = fs.statSync(media.path);
            const limitBytes = 5 * 1024 * 1024;
            if (stats.size <= limitBytes) {
              visualFrames.push(media.path);
            } else {
              console.warn(`[AI] Image file too large (${(stats.size / 1024 / 1024).toFixed(1)}MB), skipping: ${media.path}`);
            }
          }
        }
      }

      let prompt = `You are a professional video and image analyzer and transcription assistant.
      Analyze the shared Instagram media files (which may contain one or multiple photos/videos) and extract the following:
      1. Title: Create a concise, clean, search-friendly title of what the shared post teaches (exclude hashtag symbols, emojis, and social media clutter).
      2. Summary: Provide a clean, plain text summary of the post contents. Do not use any markdown formatting (no headers, no bold markdown syntax, no blockquotes, since Instagram DMs do not render markdown. Use simple line breaks and plain text bullet points instead). Detail the core concepts, step-by-step guides, voice-overs, or text descriptions.
      3. Category: Select the best match from 'study', 'project', 'resource', 'tips', or 'other'.
      4. Resources & Links: Extract all links, URLs, resources, tools, or references mentioned in the video visuals or the caption/audio. Make sure to capture them fully and accurately.
      5. Timetable Suggestions: Provide logical timetable slots to schedule this study content in the user's weekly timetable structure (recommend a day of week like 'Monday', specify a logical 24h time format like '14:00', and write a clear, active activity description).
      
      Format the entire output as a structured JSON object complying with the required response schema.`;

      if (caption && caption.trim()) {
        prompt += `\n\nAdditional Context / Post Caption Text:\n"""\n${caption}\n"""`;
      }

      if (speechTranscript && speechTranscript.trim()) {
        prompt += `\n\nSpoken Audio Transcript of the Video:\n"""\n${speechTranscript}\n"""`;
      }

      content.push({ type: 'text', text: prompt });

      const finalFrames = visualFrames.slice(0, 10);
      for (const framePath of finalFrames) {
        if (fs.existsSync(framePath)) {
          const ext = path.extname(framePath).toLowerCase();
          const mimeType = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'image/png';
          const base64Data = fs.readFileSync(framePath, { encoding: 'base64' });
          content.push({
            type: 'image_url',
            image_url: {
              url: `data:${mimeType};base64,${base64Data}`
            }
          });
        }
      }

      const messages = [
        { role: 'user', content: content }
      ];

      console.log(`[AI] Triggering multimodal completions with ${finalFrames.length} keyframes and transcription context...`);
      const response = await this.postWithTimeout('https://api.meshapi.ai/v1/chat/completions', {
        model: AI_MODEL,
        messages: messages,
        temperature: 0,
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'ReelNoteSchema',
            schema: responseSchema
          }
        }
      }, API_TIMEOUT_MS);

      const responseText = response.data.choices[0].message.content;
      console.log('[AI] Received structured JSON response from MeshAPI');
      
      const cleanedJson = this.cleanJsonText(responseText);
      return JSON.parse(cleanedJson);

    } catch (error) {
      console.error('[AI] Media analysis or transcription failed:', error.message);
      
      const isDownloadFailure = error.message.includes('Invalid content type') || 
                                error.message.includes('status code 401') || 
                                error.message.includes('redirect') ||
                                error.message.includes('verification required') ||
                                error.message.includes('checkpoint') ||
                                error.message.includes('login failed');

      if (retries > 0 && !isDownloadFailure) {
        console.log(`[AI] Retrying transcription... (${retries} attempts left)`);
        await new Promise((resolve) => setTimeout(resolve, 3000));
        return this.transcribeReel(instagramId, reelUrl, captionText, retries - 1);
      }

      if (caption && caption.trim().length > 0) {
        console.log('[AI] Falling back to caption-only analysis...');
        try {
          const prompt = `You are a professional content analysis assistant.
          Analyze the caption text of an Instagram Reel shared by the user:
          Reel URL: ${reelUrl}
          Caption Content:
          """
          ${caption}
          """

          Extract and structure the following details:
          1. Title: Create a clean, search-friendly title representing the topic (exclude hashtags and social media clutter).
          2. Summary: Provide a clean, plain text summary of the key educational tips, learning steps, or resources described in the caption text. Do not use any markdown formatting (no headers, no bold markdown syntax, no blockquotes, since Instagram DMs do not render markdown. Use simple line breaks and plain text bullet points instead).
          3. Category: Select the best match from 'study', 'project', 'resource', 'tips', or 'other'.
          4. Resources & Links: Extract all links, URLs, resources, tools, or references. Make sure to capture them fully and accurately.
          5. Timetable Suggestions: Recommend logical schedule slots to insert this study content into the user's weekly timetable (day name, time in 24h format like '09:00', and active activity description).

          Format the output as a structured JSON object according to the response schema.`;

          const response = await this.postWithTimeout('https://api.meshapi.ai/v1/chat/completions', {
            model: AI_MODEL,
            messages: [{ role: 'user', content: prompt }],
            temperature: 0,
            response_format: {
              type: 'json_schema',
              json_schema: {
                name: 'ReelNoteSchema',
                schema: responseSchema
              }
            }
          }, API_TIMEOUT_MS);

          const responseText = response.data.choices[0].message.content;
          console.log('[AI] Caption analysis completed successfully');
          
          const cleanedJson = this.cleanJsonText(responseText);
          return JSON.parse(cleanedJson);
        } catch (fallbackError) {
          console.error('[AI] Caption fallback analysis also failed:', fallbackError.message);
        }
      }

      throw error;
    } finally {
      for (let i = 0; i < mediaFiles.length; i++) {
        const framesDir = path.join(this.tempDir, `frames_${baseName}_${i}`);
        if (fs.existsSync(framesDir)) {
          try {
            fs.rmSync(framesDir, { recursive: true, force: true });
          } catch (rmErr) {
            console.warn('[AI] Failed to delete frames temp directory:', rmErr.message);
          }
        }
      }
      for (const media of mediaFiles) {
        if (media && media.path && fs.existsSync(media.path)) {
          try {
            fs.unlinkSync(media.path);
          } catch (unlinkErr) {
            console.warn('[AI] Failed to delete media temp file:', unlinkErr.message);
          }
        }
      }
    }
  }

  async generateChatResponse(userTimetable, chatHistory, latestInput, userBlockers = []) {
    if (!this.apiKey) {
      return JSON.stringify({
        reply: "I can't chat right now because the Mesh API is not configured. Please add MESH_API_KEY in settings.",
        action: "none"
      });
    }

    try {
      const timetableStr = userTimetable && userTimetable.length > 0 
        ? userTimetable.map(act => `- [${act.day} ${act.time || 'Anytime'}] ${act.activity} (Notes: ${act.notes || 'none'})`).join('\n')
        : 'No scheduled activities in the weekly timetable.';

      const blockersStr = userBlockers && userBlockers.length > 0
        ? userBlockers.map(b => `- [${b.name}] Ends on ${new Date(b.endDate).toDateString()} (Active: ${!b.notified})`).join('\n')
        : 'No active task deadlines configured.';

      const nowStr = new Date().toISOString();
      const localTimeStr = new Date().toLocaleString();

      const systemPrompt = `You are a supportive, knowledgeable AI personal schedule, study helper, and resource assistant named ReeF AI. 
      You help the user stay on track with their learning timetable, deadlines, and notes.

      Here is the user's CURRENT WEEKLY TIMETABLE:
      ${timetableStr}

      Here are their ACTIVE TASK DEADLINES:
      ${blockersStr}

      CURRENT TIME CONTEXT:
      - Current Server Time (UTC): ${nowStr}
      - Current Local Time: ${localTimeStr}

      Role instructions:
      1. Conversational Reply: Address the user's query concisely and helpfully.
      2. Mention Commands: You MUST actively inform the user about the prefix commands available to them in the bot when greeting them, showing help, or when you complete/trigger an action for them. Ensure they know how to access their saved details using these prefixes:
         - When greeting or starting: Mention '!help' to list commands.
         - When a note is saved (create_note): Remind the user they can view their notes list via '!notes' or detailed notes with '!notes view <index>'.
         - When a timetable activity is added (add_timetable): Remind the user they can see their weekly routine via '!timetable'.
         - When a deadline is added (add_deadline): Remind the user they can list their deadlines via '!deadline'.
         - When a reminder is scheduled (add_reminder): Remind the user they can inspect notifications via '!reminders'.
      3. Triggering Actions: If the user indicates they want to schedule a class/activity, set a reminder, add a deadline, clear any schedules, or save/write down notes/facts, determine the correct "action" and parse the relevant arguments into "actionData".
      4. CRITICAL JSON COMPLIANCE: Do not write thoughts, system comments, or formatting explanations inside the 'reply' or any field of 'actionData'. Keep 'actionData' values brief, clean, and containing ONLY the direct raw value (e.g. 'time' must be exactly HH:MM, 'day' must be a simple day name, and 'notes' must be clean text without meta-commentary). All reasoning must reside strictly inside the 'thought' field.
      
      Actions Reference:
      - 'add_timetable': User wants to schedule an activity in their weekly routine. (e.g. "put study math on Monday at 3pm"). Must populate 'day', 'activity', 'time' (if specified).
      - 'clear_timetable': User wants to clear their timetable.
      - 'add_reminder': User wants to set a reminder/alert. (e.g. "remind me to review biology tomorrow at 9 AM"). Must calculate and populate 'reminderActivity' and 'reminderTime' (ISO-8601 UTC format relative to current time context).
      - 'clear_reminders': User wants to clear active reminders.
      - 'add_deadline': User wants to add a project/course deadline. (e.g. "I have a homework deadline in 3 days"). Must calculate and populate 'deadlineName' and 'deadlineEndDate' (ISO-8601 UTC format or relative format like '3d').
      - 'clear_deadlines': User wants to clear all active deadlines.
      - 'create_note': User wants to save custom notes, guidelines, or summaries. (e.g. "save a note about quicksort: it uses divide-and-conquer"). Must populate 'noteTitle' and 'noteSummary' (the detailed explanation or facts the user wanted to save).
      - 'none': Default for normal conversations, questions, or if the action was already completed and they are just saying thanks.

      Note: If the user says "!notes", "!deadline", "!timetable", or "!reminders", those are handled by command files. If they type natural messages asking you to add, set, clear, or save these things, trigger the corresponding action!`;

      const messages = [
        { role: 'system', content: systemPrompt }
      ];

      if (chatHistory && Array.isArray(chatHistory)) {
        chatHistory.slice(-5).forEach(msg => {
          const role = msg.role === 'model' ? 'assistant' : msg.role;
          messages.push({
            role: role,
            content: msg.text
          });
        });
      }

      messages.push({ role: 'user', content: latestInput });

      const response = await this.postWithTimeout('https://api.meshapi.ai/v1/chat/completions', {
        model: AI_MODEL,
        messages: messages,
        response_format: { type: 'json_object' }
      }, API_TIMEOUT_MS);
      
      const responseText = response.data.choices[0].message.content;
      return this.cleanJsonText(responseText);
    } catch (error) {
      console.error('[AI] Chat model error:', error);
      return JSON.stringify({
        reply: "Sorry, I had a brief brain freeze while thinking of a response! 🧠❄️ Please try again.",
        action: "none"
      });
    }
  }
}

module.exports = AIHandler;
