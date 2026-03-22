'use strict';

const db = require('../db/database');

// Get today's health data (or null if not yet received)
function getTodayData() {
  try {
    const todayKey = new Date().toISOString().split('T')[0];
    const raw = db.getState(`health_data_${todayKey}`);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (data.date !== todayKey) return null;
    return data;
  } catch { return null; }
}

// Format health data as a human-readable context string for Claude
function getHealthContextBlock() {
  const data = getTodayData();
  if (!data) return null;

  const parts = [];

  if (data.hrv !== null) {
    parts.push(`HRV: ${data.hrv}ms`);
  }
  if (data.rhr !== null) {
    parts.push(`Resting HR: ${data.rhr}bpm`);
  }
  if (data.sleepDuration !== null) {
    let sleepStr = `Sleep: ${data.sleepDuration}h`;
    if (data.sleepDeep !== null) sleepStr += ` (${data.sleepDeep}h deep`;
    if (data.sleepRem !== null) sleepStr += `, ${data.sleepRem}h REM`;
    if (data.sleepDeep !== null || data.sleepRem !== null) sleepStr += ')';
    if (data.sleepEfficiency !== null) sleepStr += `, ${data.sleepEfficiency}% efficiency`;
    parts.push(sleepStr);
  }
  if (data.steps !== null) {
    parts.push(`Steps: ${data.steps.toLocaleString()}`);
  }
  if (data.activeEnergy !== null) {
    parts.push(`Active energy: ${Math.round(data.activeEnergy)}kcal`);
  }
  if (data.respiratoryRate !== null) {
    parts.push(`Respiratory rate: ${data.respiratoryRate} breaths/min`);
  }
  if (data.vo2max !== null) {
    parts.push(`VO2 max: ${data.vo2max} mL/kg/min`);
  }

  if (parts.length === 0) return null;

  return `## Apple Health — Today\n${parts.join(' · ')}`;
}

// Get a compact summary for journal prompt context
function getHealthSummaryForJournal() {
  const data = getTodayData();
  if (!data) return null;

  const insights = [];

  // HRV interpretation
  if (data.hrv !== null) {
    insights.push(`HRV ${data.hrv}ms`);
  }

  // Sleep quality
  if (data.sleepDuration !== null) {
    const hrs = parseFloat(data.sleepDuration);
    const quality = hrs >= 7.5 ? 'good' : hrs >= 6 ? 'moderate' : 'short';
    insights.push(`${hrs}h sleep (${quality})`);
  }

  // Resting HR
  if (data.rhr !== null) {
    insights.push(`RHR ${data.rhr}bpm`);
  }

  if (insights.length === 0) return null;
  return `Last night's health data: ${insights.join(', ')}`;
}

module.exports = {
  getTodayData,
  getHealthContextBlock,
  getHealthSummaryForJournal
};
