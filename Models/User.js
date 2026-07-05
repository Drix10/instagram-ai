const mongoose = require('mongoose');

const TimetableActivitySchema = new mongoose.Schema({
  day: { type: String, required: true },
  time: { type: String },
  activity: { type: String, required: true },
  notes: { type: String }
});

const ReminderSchema = new mongoose.Schema({
  activity: { type: String, required: true },
  time: { type: Date, required: true },
  repeat: { type: String, enum: ['none', 'daily', 'weekly'], default: 'none' },
  active: { type: Boolean, default: true }
});

const BlockerSchema = new mongoose.Schema({
  name: { type: String, required: true },
  endDate: { type: Date, required: true },
  notified: { type: Boolean, default: false }
});

ReminderSchema.index({ time: 1, active: 1 });
BlockerSchema.index({ endDate: 1, notified: 1 });

const UserSchema = new mongoose.Schema({
  instagramId: { type: String, required: true, unique: true },
  username: { type: String },
  registeredAt: { type: Date, default: Date.now },
  timetable: [TimetableActivitySchema],
  reminders: [ReminderSchema],
  blockers: [BlockerSchema]
});

module.exports = mongoose.model('User', UserSchema);
