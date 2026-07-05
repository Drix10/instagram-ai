const mongoose = require('mongoose');

const TimetableActivitySchema = new mongoose.Schema({
  day: { type: String, required: true }, // e.g. "Monday", "Tuesday"
  time: { type: String }, // Time is optional (e.g. for "Anytime" workouts)
  activity: { type: String, required: true },
  notes: { type: String }
});

const ReminderSchema = new mongoose.Schema({
  activity: { type: String, required: true },
  time: { type: Date, required: true },
  repeat: { type: String, enum: ['none', 'daily', 'weekly'], default: 'none' },
  active: { type: Boolean, default: true }
});

// Compound index on reminder subdocument fields to speed up recurring alerts checks
ReminderSchema.index({ time: 1, active: 1 });

const UserSchema = new mongoose.Schema({
  instagramId: { type: String, required: true, unique: true },
  username: { type: String },
  registeredAt: { type: Date, default: Date.now },
  timetable: [TimetableActivitySchema],
  reminders: [ReminderSchema]
});

module.exports = mongoose.model('User', UserSchema);
