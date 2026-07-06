const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require('@google/generative-ai');
const { GoogleAIFileManager } = require('@google/generative-ai/server');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
const API_TIMEOUT_MS = 60000;

const safetySettings = [
  { 
    category: HarmCategory.HARM_CATEGORY_HARASSMENT, 
    threshold: HarmBlockThreshold.BLOCK_NONE 
  },
  { 
    category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, 
    threshold: HarmBlockThreshold.BLOCK_NONE 
  },
  { 
    category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, 
    threshold: HarmBlockThreshold.BLOCK_NONE 
  },
  { 
    category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, 
    threshold: HarmBlockThreshold.BLOCK_NONE 
  }
];

class GeminiHandler {
  constructor(client) {
    this.client = client;
    this.apiKey = process.env.GEMINI_API_KEY;
    if (this.apiKey) {
      this.genAI = new GoogleGenerativeAI(this.apiKey);
      this.fileManager = new GoogleAIFileManager(this.apiKey);
    } else {
      console.warn('[GEMINI] Missing GEMINI_API_KEY environment variable. AI features will not work.');
    }
    
    this.tempDir = path.join(__dirname, '../temp');
    if (!fs.existsSync(this.tempDir)) {
      fs.mkdirSync(this.tempDir, { recursive: true });
    }
  }

  async downloadVideo(url, targetPath) {
    
    if (url.includes('instagram.com/')) {
      try {
        const igDownloader = require('../utils/instagram-downloader');
        console.log(`[GEMINI] Downloading Reel via authenticated IG session for: ${url}`);
        await igDownloader.downloadReel(url, targetPath);
        console.log(`[GEMINI] Download completed successfully via IG login method`);
        return;
      } catch (igErr) {
        console.warn(`[GEMINI] IG login download failed: ${igErr.message}. Trying fallback...`);
        
      }
    }

    const downloadUrl = url;
    console.log(`[GEMINI] Downloading video via direct URL: ${downloadUrl.substring(0, 80)}...`);

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

  withTimeout(promise, timeoutMs) {
    let timer;
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`API operation timeout after ${timeoutMs}ms`)),
        timeoutMs
      );
    });

    return Promise.race([promise, timeoutPromise]).finally(() => {
      clearTimeout(timer);
    });
  }

  async transcribeReel(instagramId, reelUrl, captionText, retries = 2) {
    if (!this.genAI) {
      throw new Error('Gemini API is not initialized. Please configure GEMINI_API_KEY.');
    }

    const responseSchema = {
      type: 'OBJECT',
      properties: {
        title: { type: 'STRING', description: 'What is this video/reel about? E.g., Learn SQL in 10 Days' },
        summary: { type: 'STRING', description: 'Brief transcription and summary of the key tips, steps, links, or advice shown in the reel.' },
        category: { 
          type: 'STRING', 
          enum: ['study', 'project', 'resource', 'tips', 'other'], 
          description: 'The category that matches the reel contents.' 
        },
        resourceDetails: {
          type: 'OBJECT',
          properties: {
            resources: {
              type: 'ARRAY',
              items: {
                type: 'OBJECT',
                properties: {
                  name: { type: 'STRING', description: 'Resource, book, website, tool, or step name, e.g. React Docs' },
                  type: { type: 'STRING', description: 'Type of resource: book, link, tool, step, video, custom' },
                  description: { type: 'STRING', description: 'Description or notes about this specific resource/step.' }
                },
                required: ['name']
              }
            }
          }
        },
        timetableSuggestions: {
          type: 'ARRAY',
          items: {
            type: 'OBJECT',
            properties: {
              day: { type: 'STRING', description: 'Recommended day of the week to study/work on this, e.g. Monday, Tuesday. Choose a logical day if none is mentioned.' },
              time: { type: 'STRING', description: 'Recommended time of the day in 24h format, e.g., 09:00, 15:30. Default to 09:00 if not specified.' },
              activity: { type: 'STRING', description: 'Learning activity description.' },
              notes: { type: 'STRING', description: 'Any extra notes.' }
            },
            required: ['day', 'activity']
          }
        }
      },
      required: ['title', 'summary', 'category']
    };

    const baseName = `reel_${instagramId}_${Date.now()}`;
    const igDownloader = require('../utils/instagram-downloader');
    
    let mediaFiles = [];
    let uploadedFiles = [];
    let caption = captionText || '';

    try {
      console.log(`[GEMINI] Downloading post media from URL for user ${instagramId}...`);
      try {
        const result = await igDownloader.downloadMedia(reelUrl, this.tempDir, baseName);
        mediaFiles = result.mediaFiles || [];
        if (result.caption) {
          caption = result.caption;
        }
        console.log(`[GEMINI] Download completed. Ingested ${mediaFiles.length} media files`);
      } catch (igErr) {
        console.warn(`[GEMINI] IG media download failed: ${igErr.message}. Falling back to direct video download...`);
        const tempFileName = `${baseName}_0.mp4`;
        const tempFilePath = path.join(this.tempDir, tempFileName);
        mediaFiles = [{ path: tempFilePath, mimeType: 'video/mp4' }];
        await this.downloadVideo(reelUrl, tempFilePath);
      }

      if (!this.fileManager) {
        throw new Error('GoogleAIFileManager is not initialized.');
      }

      // Upload files to Google AI Storage
      for (let i = 0; i < mediaFiles.length; i++) {
        const media = mediaFiles[i];
        console.log(`[GEMINI] Uploading media chunk ${i + 1}/${mediaFiles.length} (${media.mimeType}) to Google AI File API...`);
        
        const uploadResult = await this.fileManager.uploadFile(media.path, {
          mimeType: media.mimeType,
          displayName: `${baseName}_${i}`,
        });

        // Wait for processing only if video. Images are active instantly.
        let isVideo = media.mimeType.startsWith('video/');
        let file = await this.fileManager.getFile(uploadResult.file.name);
        
        if (isVideo) {
          let attempts = 0;
          while (file.state === 'PROCESSING' && attempts < 20) {
            await new Promise((resolve) => setTimeout(resolve, 5000));
            file = await this.fileManager.getFile(uploadResult.file.name);
            attempts++;
          }
          if (file.state !== 'ACTIVE') {
            throw new Error(`Video processing failed on Gemini server. State: ${file.state}`);
          }
        }
        
        uploadedFiles.push({
          name: uploadResult.file.name,
          uri: uploadResult.file.uri,
          mimeType: media.mimeType
        });
      }

      if (uploadedFiles.length === 0) {
        throw new Error('All media file uploads to Gemini failed.');
      }

      console.log('[GEMINI] Media uploads active. Generating structured note...');

      const model = this.genAI.getGenerativeModel({
        model: GEMINI_MODEL,
        safetySettings,
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: responseSchema
        }
      });

      let prompt = `You are a professional video and image analyzer and transcription assistant.
      Analyze the shared Instagram media files (which may contain one or multiple photos/videos) and extract the following:
      1. Title: Create a concise, clean, search-friendly title of what the shared post teaches (exclude hashtag symbols, emojis, and social media clutter).
      2. Summary: Provide a clean, markdown-formatted summary of the post contents. Use bullet points and clear section headers to make it easily readable on narrow mobile screens (Instagram DM). Detail the core concepts, step-by-step guides, voice-overs, or text descriptions.
      3. Category: Select the best match from 'study', 'project', 'resource', 'tips', or 'other'.
      4. Resources & Links: Extract any specific website links, tools, books, or steps mentioned.
      5. Timetable Suggestions: Provide logical timetable slots to schedule this study content in the user's weekly timetable structure (recommend a day of week like 'Monday', specify a logical 24h time format like '14:00', and write a clear, active activity description).
      
      Format the entire output as a structured JSON object complying with the required response schema.`;

      if (caption && caption.trim()) {
        prompt += `\n\nAdditional Context / Post Caption Text:\n"""\n${caption}\n"""`;
      }

      const contentsList = [];
      for (const f of uploadedFiles) {
        contentsList.push({
          fileData: {
            mimeType: f.mimeType,
            fileUri: f.uri
          }
        });
      }
      contentsList.push({ text: prompt });

      const result = await this.withTimeout(
        model.generateContent(contentsList),
        API_TIMEOUT_MS
      );

      const responseText = result.response.text();
      console.log('[GEMINI] Received structured JSON response');
      return JSON.parse(responseText);

    } catch (error) {
      console.error('[GEMINI] Media analysis or transcription failed:', error.message);
      
      const isDownloadFailure = error.message.includes('Invalid content type') || 
                                error.message.includes('status code 401') || 
                                error.message.includes('redirect') ||
                                error.message.includes('verification required') ||
                                error.message.includes('checkpoint') ||
                                error.message.includes('login failed');

      if (retries > 0 && !isDownloadFailure) {
        console.log(`[GEMINI] Retrying transcription... (${retries} attempts left)`);
        await new Promise((resolve) => setTimeout(resolve, 3000));
        return this.transcribeReel(instagramId, reelUrl, captionText, retries - 1);
      }

      if (caption && caption.trim().length > 0) {
        console.log('[GEMINI] Falling back to caption-only analysis...');
        try {
          const model = this.genAI.getGenerativeModel({
            model: GEMINI_MODEL,
            safetySettings,
            generationConfig: {
              responseMimeType: 'application/json',
              responseSchema: responseSchema
            }
          });

          const prompt = `You are a professional content analysis assistant.
          Analyze the caption text of an Instagram Reel shared by the user:
          Reel URL: ${reelUrl}
          Caption Content:
          """
          ${caption}
          """

          Extract and structure the following details:
          1. Title: Create a clean, search-friendly title representing the topic (exclude hashtags and social media clutter).
          2. Summary: Provide a clean, markdown-formatted summary of the key educational tips, learning steps, or resources described in the caption text. Optimize formatting for mobile DMs (clear spacing, lists, bullet points).
          3. Category: Select the best match from 'study', 'project', 'resource', 'tips', or 'other'.
          4. Resources & Links: Extract any website links, tools, or references.
          5. Timetable Suggestions: Recommend logical schedule slots to insert this study content into the user's weekly timetable (day name, time in 24h format like '09:00', and active activity description).

          Format the output as a structured JSON object according to the response schema.`;

          const result = await this.withTimeout(
            model.generateContent(prompt),
            API_TIMEOUT_MS
          );

          const responseText = result.response.text();
          console.log('[GEMINI] Caption analysis completed successfully');
          return JSON.parse(responseText);
        } catch (fallbackError) {
          console.error('[GEMINI] Caption fallback analysis also failed:', fallbackError.message);
        }
      }

      throw error;
    } finally {
      // Clean up files from Google AI File storage
      for (const f of uploadedFiles) {
        if (f && f.name) {
          console.log(`[GEMINI] Cleaning up file from AI storage: ${f.name}...`);
          await this.fileManager.deleteFile(f.name).catch(err => {
            console.warn('[GEMINI] Error deleting file from AI storage:', err.message);
          });
        }
      }
      // Clean up local temp downloaded files
      for (const media of mediaFiles) {
        if (media && media.path && fs.existsSync(media.path)) {
          fs.unlink(media.path, () => {});
        }
      }
    }
  }

  async generateChatResponse(userTimetable, chatHistory, latestInput, userBlockers = []) {
    if (!this.genAI) {
      return JSON.stringify({
        reply: "I can't chat right now because the Gemini API is not configured. Please add GEMINI_API_KEY in settings.",
        action: "none"
      });
    }

    const responseSchema = {
      type: 'OBJECT',
      properties: {
        thought: {
          type: 'STRING',
          description: 'Your internal reasoning, chain of thought, or step-by-step logic to determine the correct action and conversational reply. REQUIRED.'
        },
        reply: { 
          type: 'STRING', 
          description: 'Your conversational text response back to the user in DMs.' 
        },
        action: { 
          type: 'STRING', 
          enum: ['add_timetable', 'clear_timetable', 'add_reminder', 'clear_reminders', 'add_deadline', 'clear_deadlines', 'create_note', 'none'],
          description: 'Detect if the user requested an action. Select appropriate action, or none.' 
        },
        actionData: {
          type: 'OBJECT',
          properties: {
            day: { type: 'STRING', description: 'Day of week for add_timetable action, e.g. Monday. REQUIRED if action is add_timetable.' },
            time: { type: 'STRING', description: 'Time of day in 24h format, e.g. 14:00. Optional.' },
            activity: { type: 'STRING', description: 'Activity/topic description. REQUIRED if action is add_timetable.' },
            notes: { type: 'STRING', description: 'Additional notes. Optional.' },
            reminderActivity: { type: 'STRING', description: 'Activity/alert description to remind about. REQUIRED if action is add_reminder.' },
            reminderTime: { type: 'STRING', description: 'Target date/time in ISO-8601 UTC format, e.g. 2026-07-06T15:00:00Z. Calculated relative to the current time context. REQUIRED if action is add_reminder.' },
            reminderRepeat: { type: 'STRING', enum: ['none', 'daily', 'weekly'], description: 'Repeat frequency. Optional.' },
            deadlineName: { type: 'STRING', description: 'Name of the task/milestone/deadline. REQUIRED if action is add_deadline.' },
            deadlineEndDate: { type: 'STRING', description: 'Target end date in ISO-8601 UTC format or relative format (e.g. 5d). REQUIRED if action is add_deadline.' },
            noteTitle: { type: 'STRING', description: 'Title of the custom note. REQUIRED if action is create_note.' },
            noteSummary: { type: 'STRING', description: 'Detailed content body/summary of the custom note. REQUIRED if action is create_note.' },
            noteCategory: { type: 'STRING', enum: ['study', 'project', 'resource', 'tips', 'other'], description: 'Category of the note. REQUIRED if action is create_note.' },
            noteResources: {
              type: 'ARRAY',
              items: {
                type: 'OBJECT',
                properties: {
                  name: { type: 'STRING', description: 'Resource name' },
                  type: { type: 'STRING', description: 'Resource type' },
                  description: { type: 'STRING', description: 'Resource description' }
                },
                required: ['name']
              }
            }
          }
        }
      },
      required: ['thought', 'reply', 'action']
    };

    try {
      const model = this.genAI.getGenerativeModel({ 
        model: GEMINI_MODEL,
        safetySettings,
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: responseSchema
        }
      });
      
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

      const contents = [
        { role: 'user', parts: [{ text: systemPrompt }] },
      ];

      if (chatHistory && Array.isArray(chatHistory)) {
        chatHistory.slice(-5).forEach(msg => {
          contents.push({
            role: msg.role,
            parts: [{ text: msg.text }]
          });
        });
      }

      contents.push({ role: 'user', parts: [{ text: latestInput }] });

      const result = await this.withTimeout(
        model.generateContent({ contents }),
        API_TIMEOUT_MS
      );
      
      return result.response.text();
    } catch (error) {
      console.error('[GEMINI] Chat model error:', error);
      return JSON.stringify({
        reply: "Sorry, I had a brief brain freeze while thinking of a response! 🧠❄️ Please try again.",
        action: "none"
      });
    }
  }
}

module.exports = GeminiHandler;
