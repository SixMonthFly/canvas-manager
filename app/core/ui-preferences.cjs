'use strict';
const fs = require('node:fs');
const path = require('node:path');
function createUIPreferences(root, locale = 'zh-CN') {
  const filename = path.join(root, 'ui-preferences.json');
  const defaults = { language: /^zh/i.test(locale) ? 'zh-CN' : 'en', onboardingStatus: 'pending', onboardingStep: 0, onboardingSchool: null };
  function read() {
    try {
      const value = JSON.parse(fs.readFileSync(filename, 'utf8'));
      return { language: ['zh-CN', 'en'].includes(value.language) ? value.language : defaults.language,
        // 4.1.0 also set its boolean for existing courses and closing the guide.
        // It cannot prove completion or an explicit skip: show the new guide once.
        onboardingStatus: ['pending', 'completed', 'skipped'].includes(value.onboardingStatus) ? value.onboardingStatus : 'pending',
        onboardingStep: value.onboardingStatus && [0, 1, 2, 3].includes(value.onboardingStep) ? value.onboardingStep : 0,
        onboardingSchool: typeof value.onboardingSchool === 'string' ? value.onboardingSchool : null };
    } catch { return { ...defaults }; }
  }
  function save(patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Invalid preferences');
    if ('language' in patch && !['zh-CN', 'en'].includes(patch.language)) throw new Error('Unsupported language');
    if ('onboardingStatus' in patch && !['pending', 'completed', 'skipped'].includes(patch.onboardingStatus)) throw new Error('Invalid onboarding state');
    if ('onboardingSchool' in patch && patch.onboardingSchool !== null && (typeof patch.onboardingSchool !== 'string' || !/^[a-z0-9-]{1,40}$/.test(patch.onboardingSchool))) throw new Error('Invalid onboarding school');
    if ('onboardingStep' in patch && ![0, 1, 2, 3].includes(patch.onboardingStep)) throw new Error('Invalid onboarding step');
    const next = { ...read() };
    for (const key of Object.keys(defaults)) if (key in patch) next[key] = patch[key];
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(filename + '.tmp', JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(filename + '.tmp', filename);
    return next;
  }
  return { read, save };
}
module.exports = { createUIPreferences };
