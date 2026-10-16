const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createUIPreferences } = require('../core/ui-preferences.cjs');
test('Language and onboarding survive process-level reload and invalid writes preserve data', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-language-')); t.after(() => fs.rmSync(root, {recursive:true,force:true}));
  const prefs = createUIPreferences(root, 'en-SG');
  assert.equal(prefs.read().language, 'en');
  prefs.save({language:'zh-CN',onboardingStep:2});
  const restored = createUIPreferences(root, 'en-US');
  assert.deepEqual(restored.read(), {language:'zh-CN',onboardingStatus:'pending',onboardingStep:2,onboardingSchool:null});
  for(const bad of [{language:'xx'},{onboardingStatus:'true'},{onboardingStep:4},{onboardingSchool:[]},null]) assert.throws(()=>restored.save(bad));
  assert.equal(restored.read().language,'zh-CN');
  restored.save({onboardingStatus:'completed'});
  assert.equal(restored.read().onboardingStep,2);
});
test('Legacy automatic completion is not evidence of completing or skipping the guide', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-guide-')); t.after(() => fs.rmSync(root,{recursive:true,force:true}));
  fs.writeFileSync(path.join(root,'ui-preferences.json'),JSON.stringify({language:'en',onboardingComplete:true,onboardingStep:2}));
  const prefs = createUIPreferences(root);
  assert.equal(prefs.read().onboardingStatus,'pending'); assert.equal(prefs.read().onboardingStep,0);
  prefs.save({onboardingStatus:'skipped'});
  assert.equal(createUIPreferences(root).read().onboardingStatus,'skipped');
});
test('The discontinued desktop card is absent, while native system widgets remain', () => {
  const catalog = require('../plugins/catalog.json');
  assert(!catalog.some(p=>p.id==='desktop-assignments'));
  assert(catalog.some(p=>p.id==='native-assignments'));
});
