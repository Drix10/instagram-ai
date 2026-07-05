const mongoose = require('mongoose');

const ResourceSchema = new mongoose.Schema({
  name: { type: String, required: true },
  type: { type: String },
  description: { type: String }
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
  category: { type: String, enum: ['study', 'project', 'resource', 'tips', 'other'], default: 'resource' },
  resourceDetails: {
    resources: [ResourceSchema]
  },
  timetableSuggestions: [TimetableSuggestionSchema],
  saved: { type: Boolean, default: false }, 
  savedAt: { type: Date, default: Date.now }
});

ReelNoteSchema.index({ instagramId: 1, saved: 1, savedAt: -1 });

module.exports = mongoose.model('ReelNote', ReelNoteSchema);
