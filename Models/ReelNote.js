const mongoose = require('mongoose');

const ResourceSchema = new mongoose.Schema({
  name: { type: String, required: true }, // e.g. "Github Repo Link" or "VS Code Extension"
  type: { type: String }, // e.g. "link", "tool", "step", "book"
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

// Compound index on query keys to optimize notes listing history queries
ReelNoteSchema.index({ instagramId: 1, saved: 1, savedAt: -1 });

module.exports = mongoose.model('ReelNote', ReelNoteSchema);
