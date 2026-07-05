const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require('@google/generative-ai');
const { GoogleAIFileManager } = require('@google/generative-ai/server');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const GEMINI_MODEL = 'gemini-3.5-flash';
const API_TIMEOUT_MS = 35000; // 35 seconds timeout for generative requests

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
    
    // Create temp directory for downloading reels
    this.tempDir = path.join(__dirname, '../temp');
    if (!fs.existsSync(this.tempDir)) {
      fs.mkdirSync(this.tempDir, { recursive: true });
    }
  }

  async downloadVideo(url, targetPath) {
    return new Promise(async (resolve, reject) => {
      let writer;
      let stream;
      try {
        writer = fs.createWriteStream(targetPath);
        const response = await axios({
          url,
          method: 'GET',
          responseType: 'stream',
          timeout: 45000, // 45s absolute request timeout
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
          }
        });

        stream = response.data;
        const contentLength = parseInt(response.headers['content-length'], 10);
        const limitBytes = 35 * 1024 * 1024; // 35MB limit

        if (!isNaN(contentLength) && contentLength > limitBytes) {
          writer.close();
          fs.unlink(targetPath, () => {});
          return reject(new Error('File size exceeds the 35MB limit'));
        }

        let bytesWritten = 0;
        stream.on('data', (chunk) => {
          bytesWritten += chunk.length;
          if (bytesWritten > limitBytes) {
            stream.destroy();
            writer.destroy();
            fs.unlink(targetPath, () => {});
            reject(new Error('File size exceeded the 35MB limit during download'));
          }
        });

        stream.pipe(writer);

        writer.on('finish', () => {
          writer.close();
          resolve();
        });

        writer.on('error', (err) => {
          fs.unlink(targetPath, () => {});
          reject(err);
        });

        stream.on('error', (err) => {
          writer.destroy();
          fs.unlink(targetPath, () => {});
          reject(err);
        });
      } catch (error) {
        if (writer) {
          writer.destroy();
        }
        fs.unlink(targetPath, () => {});
        reject(error);
      }
    });
  }

  async withTimeout(promise, timeoutMs) {
    return Promise.race([
      promise,
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error(`API operation timeout after ${timeoutMs}ms`)),
          timeoutMs
        )
      ),
    ]);
  }

  async transcribeReel(instagramId, reelUrl, retries = 2) {
    if (!this.genAI || !this.fileManager) {
      throw new Error('Gemini API is not initialized. Please configure GEMINI_API_KEY.');
    }

    const tempFileName = `reel_${instagramId}_${Date.now()}.mp4`;
    const tempFilePath = path.join(this.tempDir, tempFileName);
    let uploadedFileName = null;

    try {
      console.log(`[GEMINI] Downloading Reel from URL for user ${instagramId}...`);
      await this.downloadVideo(reelUrl, tempFilePath);
      console.log('[GEMINI] Download completed successfully');

      console.log('[GEMINI] Uploading Reel to Google AI File API...');
      const uploadResult = await this.fileManager.uploadFile(tempFilePath, {
        mimeType: 'video/mp4',
        displayName: `Reel_${instagramId}`,
      });
      
      uploadedFileName = uploadResult.file.name;
      const fileUri = uploadResult.file.uri;
      console.log(`[GEMINI] Uploaded. File Name: ${uploadedFileName}, URI: ${fileUri}`);

      // Poll until file processing is ACTIVE
      console.log('[GEMINI] Waiting for video processing to complete...');
      let file = await this.fileManager.getFile(uploadedFileName);
      let attempts = 0;
      while (file.state === 'PROCESSING' && attempts < 20) {
        await new Promise((resolve) => setTimeout(resolve, 5000));
        file = await this.fileManager.getFile(uploadedFileName);
        attempts++;
      }

      if (file.state !== 'ACTIVE') {
        throw new Error(`Video processing failed on Gemini server. State: ${file.state}`);
      }
      console.log('[GEMINI] Video processing completed. Generating structured note...');

      // Configure structured JSON schema response (General Study/Project/Resource Scheduler)
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

      const model = this.genAI.getGenerativeModel({
        model: GEMINI_MODEL,
        safetySettings,
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: responseSchema
        }
      });

      const prompt = `Analyze this Instagram Reel video. Transcribe the spoken text or text overlays. Extract the main educational tips, learning steps, resources, links, or tasks shown. 
      Format the output as a structured JSON object according to the schema. 
      If there is resource/learning data, populate resourceDetails. 
      Provide timetableSuggestions for scheduling this into the user's weekly timetable structure.`;

      // Run generative request with timeout protection
      const result = await this.withTimeout(
        model.generateContent([
          {
            fileData: {
              mimeType: file.mimeType,
              fileUri: file.uri,
            },
          },
          { text: prompt },
        ]),
        API_TIMEOUT_MS
      );

      const responseText = result.response.text();
      console.log('[GEMINI] Received structured JSON response');

      const parsedNote = JSON.parse(responseText);
      return parsedNote;
    } catch (error) {
      console.error('[GEMINI] Error transcribing Reel:', error);
      
      // Retry logic for transient network or timeout issues
      if (retries > 0) {
        console.log(`[GEMINI] Retrying transcription... (${retries} attempts left)`);
        await new Promise((resolve) => setTimeout(resolve, 3000));
        return this.transcribeReel(instagramId, reelUrl, retries - 1);
      }
      throw error;
    } finally {
      // 1. Guaranteed Google AI Storage cleanup (avoids quota leaks)
      if (uploadedFileName) {
        console.log(`[GEMINI] Cleaning up file from AI storage: ${uploadedFileName}...`);
        await this.fileManager.deleteFile(uploadedFileName).catch(err => {
          console.warn('[GEMINI] Error deleting file from AI storage:', err.message);
        });
      }
      // 2. Guaranteed local disk cleanup (avoids disk filling leaks)
      if (fs.existsSync(tempFilePath)) {
        fs.unlinkSync(tempFilePath);
        console.log('[GEMINI] Cleaned up local temp file');
      }
    }
  }

  async generateChatResponse(userTimetable, chatHistory, latestInput, userBlockers = []) {
    if (!this.genAI) {
      return "I can't chat right now because the Gemini API is not configured. Please add GEMINI_API_KEY in settings.";
    }

    try {
      const model = this.genAI.getGenerativeModel({ 
        model: GEMINI_MODEL,
        safetySettings 
      });
      
      const timetableStr = userTimetable && userTimetable.length > 0 
        ? userTimetable.map(act => `- [${act.day} ${act.time || 'Anytime'}] ${act.activity} (Notes: ${act.notes || 'none'})`).join('\n')
        : 'No scheduled activities in the weekly timetable.';

      const blockersStr = userBlockers && userBlockers.length > 0
        ? userBlockers.map(b => `- [${b.name}] Ends on ${new Date(b.endDate).toDateString()} (Active: ${!b.notified})`).join('\n')
        : 'No current blocker deadlines (e.g. exams) configured.';

      const systemPrompt = `You are a supportive, knowledgeable AI personal schedule, study helper, and resource assistant. 
      You help the user stay on track with their learning timetable, deadlines, and notes.
      Here is the user's CURRENT WEEKLY TIMETABLE:\n${timetableStr}\n\n
      Here are their ACTIVE BLOCKERS/EXAM DEADLINES:\n${blockersStr}\n\n
      Answer the user's query concisely and helpfully, using their timetable and blockers context. 
      If they ask to add deadlines, show schedules, or view notes, explain how they can use commands like !timetable, !deadline, or share learning Reels.
      If they have exams/blockers going on, support them, and reassure them they can start learning new things once their exam deadlines are completed!`;

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

      // Run chatbot query with timeout protection
      const result = await this.withTimeout(
        model.generateContent({ contents }),
        API_TIMEOUT_MS
      );
      
      return result.response.text();
    } catch (error) {
      console.error('[GEMINI] Chat model error:', error);
      return "Sorry, I had a brief brain freeze while thinking of a response! 🧠❄️ Please try again.";
    }
  }
}

module.exports = GeminiHandler;
