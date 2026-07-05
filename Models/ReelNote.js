const mongoose = require('mongoose');

const ExerciseSchema = new mongoose.Schema({
  name: { type: String, required: true },
  sets: { type: Number },
  reps: { type: Number },
  notes: { type: String }
});

const TimetableSuggestionSchema = new mongoose.Schema({
  day: { type: String },
  time: { type: String },
  activity: { type: String },
  notes: { type: String }
});

const ReelNoteSchema = new mongoose.Schema({
  instagramId: { type: String, required: true },
  reelUrl: { type: String, required: true },
  title: { type: String, required: true },
  summary: { type: String, required: true },
  category: { type: String, enum: ['workout', 'note', 'recipe', 'coding', 'other'], default: 'note' },
  workoutDetails: {
    exercises: [ExerciseSchema]
  },
  timetableSuggestions: [TimetableSuggestionSchema],
  saved: { type: Boolean, default: false }, // Filter out transient transcriptions from user notes list
  savedAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('ReelNote', ReelNoteSchema);
