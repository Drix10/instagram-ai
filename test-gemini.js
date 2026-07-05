require('dotenv').config();
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { GoogleAIFileManager } = require('@google/generative-ai/server');
const fs = require('fs');
const path = require('path');

const apiKey = process.env.GEMINI_API_KEY;

if (!apiKey || apiKey === 'YOUR_GEMINI_API_KEY_HERE') {
  console.error('❌ Error: GEMINI_API_KEY is not set in the .env file.');
  process.exit(1);
}

const args = process.argv.slice(2);
const videoPath = args[0];

if (!videoPath) {
  console.log('\n🔍 Reel Transcription Offline Verification Script');
  console.log('--------------------------------------------------');
  console.log('Usage: npm run test:gemini <path_to_video.mp4>\n');
  console.log('Please provide a path to a local MP4 video file to test transcription parsing.');
  process.exit(0);
}

const resolvedPath = path.resolve(videoPath);
if (!fs.existsSync(resolvedPath)) {
  console.error(`❌ Error: File not found at ${resolvedPath}`);
  process.exit(1);
}

const fileManager = new GoogleAIFileManager(apiKey);
const genAI = new GoogleGenerativeAI(apiKey);

async function runTest() {
  try {
    console.log(`[TEST] Uploading video: ${resolvedPath}...`);
    const uploadResult = await fileManager.uploadFile(resolvedPath, {
      mimeType: 'video/mp4',
      displayName: 'Test_Reel_Video'
    });

    const fileUri = uploadResult.file.uri;
    const fileName = uploadResult.file.name;
    console.log(`[TEST] Uploaded successfully. Name: ${fileName}, URI: ${fileUri}`);

    // Poll status
    let file = await fileManager.getFile(fileName);
    console.log('[TEST] Waiting for video processing to complete (usually 10-30s)...');
    let attempts = 0;
    while (file.state === 'PROCESSING' && attempts < 15) {
      process.stdout.write('.');
      await new Promise(resolve => setTimeout(resolve, 5000));
      file = await fileManager.getFile(fileName);
      attempts++;
    }
    console.log('');

    if (file.state !== 'ACTIVE') {
      throw new Error(`File processing state is ${file.state}`);
    }

    console.log('[TEST] Video processing active. Sending prompt to Gemini model...');

    const responseSchema = {
      type: 'OBJECT',
      properties: {
        title: { type: 'STRING', description: 'What is this video/reel about?' },
        summary: { type: 'STRING', description: 'Brief transcription and summary of the key tips/exercises.' },
        category: { type: 'STRING', enum: ['workout', 'note', 'recipe', 'coding', 'other'] },
        workoutDetails: {
          type: 'OBJECT',
          properties: {
            exercises: {
              type: 'ARRAY',
              items: {
                type: 'OBJECT',
                properties: {
                  name: { type: 'STRING' },
                  sets: { type: 'INTEGER' },
                  reps: { type: 'INTEGER' },
                  notes: { type: 'STRING' }
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
              day: { type: 'STRING' },
              time: { type: 'STRING' },
              activity: { type: 'STRING' },
              notes: { type: 'STRING' }
            },
            required: ['day', 'activity']
          }
        }
      },
      required: ['title', 'summary', 'category']
    };

    const model = genAI.getGenerativeModel({
      model: 'gemini-1.5-flash',
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: responseSchema
      }
    });

    const prompt = 'Analyze this video. Transcribe and extract the key information matching the requested schema.';
    const result = await model.generateContent([
      {
        fileData: {
          mimeType: file.mimeType,
          fileUri: file.uri
        }
      },
      { text: prompt }
    ]);

    console.log('\n🎉 [TEST] Success! Transcription result received from Gemini:');
    console.log('------------------------------------------------------------');
    console.log(JSON.stringify(JSON.parse(result.response.text()), null, 2));
    console.log('------------------------------------------------------------');

    // Clean up
    console.log('[TEST] Cleaning up file from Google AI Storage...');
    await fileManager.deleteFile(fileName);
    console.log('[TEST] Cleanup completed.');
  } catch (error) {
    console.error('❌ [TEST] Error running offline verification:', error);
  }
}

runTest();
