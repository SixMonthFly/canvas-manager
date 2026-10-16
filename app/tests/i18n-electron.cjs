const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const {spawnSync} = require('node:child_process');
const root = process.env.CANVAS_TEST_APP_ROOT || path.join(__dirname,'..');
if (!process.versions.electron) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'canvas-language-e2e-'));
  try {
    for(const phase of ['welcome','later','resume','practical','practical-resume','completed','skip','skipped','legacy']) {
      const result=spawnSync(require('electron'),[__filename],{env:{...process.env,CANVAS_LANGUAGE_TEST_DIR:dir,CANVAS_LANGUAGE_PHASE:phase},encoding:'utf8',timeout:35000});
      process.stdout.write(result.stdout||'');process.stderr.write(result.stderr||'');
      assert.equal(result.status,0,phase+' failed: '+result.error);
    }
    console.log('PASS first launch, unfinished relaunches, explicit skip, deferred school restart, completed relaunch, legacy migration, bilingual UI and original course content');
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
} else {
  const {app,BrowserWindow,session}=require('electron');
  const dir=process.env.CANVAS_LANGUAGE_TEST_DIR,phase=process.env.CANVAS_LANGUAGE_PHASE;
  assert(dir?.startsWith(os.tmpdir()));
  app.setPath('userData',dir);Object.defineProperty(app,'isPackaged',{get:()=>true});app.disableHardwareAcceleration();
  let relaunched=false;app.relaunch=()=>{relaunched=true;};
  BrowserWindow.prototype.show=function(){};
  const data=path.join(dir,'data');fs.mkdirSync(data,{recursive:true});
  const prefsFile=path.join(data,'ui-preferences.json');
  const prefs=()=>JSON.parse(fs.readFileSync(prefsFile));
  if(phase==='welcome')fs.writeFileSync(prefsFile,JSON.stringify({language:'zh-CN'}));
  if(phase==='completed'||phase==='legacy') {
    const campus=path.join(data,'schools','nus');fs.mkdirSync(campus,{recursive:true});
    fs.writeFileSync(path.join(campus,'courses.json'),JSON.stringify([{id:1,code:'TEST101',name:'Original Canvas course'}]));
    fs.writeFileSync(path.join(campus,'assignments_1.json'),JSON.stringify([]));
  }
  if(phase==='legacy')fs.writeFileSync(prefsFile,JSON.stringify({language:'zh-CN',onboardingComplete:true,onboardingStep:2}));
  app.whenReady().then(()=>session.defaultSession.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_r,cb)=>cb({cancel:true})));
  require(path.join(root,'main.js'));
  const delay=ms=>new Promise(r=>setTimeout(r,ms));
  async function run() {
    await app.whenReady();
    let win;
    for(let i=0;i<120;i++){win=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('renderer/index.html'));if(win)break;await delay(50);}
    const js=code=>win.webContents.executeJavaScript(code);
    async function wait(code){for(let i=0;i<160;i++){try{if(await js(code))return;}catch{}await delay(40);}throw Error('Timeout '+code);}
    await wait('window.pluginHost && document.querySelector("#language-select").value');
    await js('pluginHost.whenSettled()');
    if(['welcome','later','resume','legacy'].includes(phase)) {
      await wait('document.querySelector("#onboarding").open');
      assert(await js('(()=>{const r=document.querySelector("#onboarding").getBoundingClientRect();return Math.abs(r.x+r.width/2-innerWidth/2)<2 && Math.abs(r.y+r.height/2-innerHeight/2)<2})()'),'Guide centers in the entire viewport');
    }
    if(phase==='welcome') {
      await js('document.querySelectorAll(".welcome-languages button")[1].click();document.querySelector("#welcome-next").click()');
      await wait('document.documentElement.lang==="en" && !!document.querySelector("#welcome-school")');
      await js('document.querySelector("#welcome-school").value="nus";document.querySelector("#welcome-school").dispatchEvent(new Event("change"));document.querySelector("#welcome-next").click()');
      await wait('document.querySelector("#onboarding-title").textContent==="Bring your courses home."');
      await delay(350);
      assert.equal(relaunched,false);assert.equal(fs.existsSync(path.join(data,'school.json')),false,'School remains a draft');
      assert.equal(prefs().onboardingSchool,'nus');assert.equal(prefs().onboardingStatus,'pending');
      await js('document.querySelector("#welcome-close").click()');
      await wait('!document.querySelector("#onboarding").open');
      assert.equal(prefs().onboardingStatus,'pending','Close means finish later, not skip');
    } else if(phase==='later') {
      assert.equal(await js('document.querySelector("#onboarding-title").textContent'),'Bring your courses home.');
      assert.equal(prefs().onboardingStatus,'pending');
      // Quit mid-guide again. The following process must still show it.
    } else if(phase==='resume') {
      assert.equal(prefs().onboardingStatus,'pending');assert.equal(prefs().onboardingSchool,'nus');
      assert.equal(await js('document.querySelector("#school-select").value'),'hkust-gz');
      const output=path.join(__dirname,'../../output/release-v'+require('../package.json').version);fs.mkdirSync(output,{recursive:true});
      await delay(600);fs.writeFileSync(path.join(output,'onboarding-en.png'),(await win.webContents.capturePage()).toPNG());
      await js('document.querySelector("#welcome-next").click()');
      await wait('!document.querySelector("#onboarding").open');
      assert.equal(prefs().onboardingStatus,'pending');assert.equal(prefs().onboardingStep,3);
      assert.equal(JSON.parse(fs.readFileSync(path.join(data,'school.json'))).schoolId,'nus');
      // Completion is durable before the restart timer can fire.
    } else if(phase==='practical'||phase==='practical-resume') {
      await wait('document.querySelector("#onboarding").open');
      assert.equal(await js('document.querySelector("#onboarding").matches(":modal")'),false,'Practical guidance must not block the app');
      assert.equal(prefs().onboardingStatus,'pending');
      assert.equal(await js('document.querySelector("#school-select").value'),'nus');
      assert(await js('(()=>{const b=document.querySelector("#refresh-btn"),r=b.getBoundingClientRect();return b.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))})()'),'Sync is actually clickable');
      await js('window.syncClicks=0;document.querySelector("#refresh-btn").onclick=async()=>{window.syncClicks++};document.querySelector("#welcome-sync").click()');
      await wait('window.syncClicks===1');
      assert.equal(prefs().onboardingStatus,'pending','Starting sync alone must not complete guidance');
      if(phase==='practical') {
        await js('document.querySelector("#welcome-close").click()');
        await wait('!document.querySelector("#onboarding").open');
      } else {
        const output=path.join(__dirname,'../../output/release-v'+require('../package.json').version);
        await delay(500);fs.writeFileSync(path.join(output,'practical-guide-en.png'),(await win.webContents.capturePage()).toPNG());
        await js('document.querySelector("#welcome-next").click()');
        await wait('!document.querySelector("#onboarding").open');
        assert.equal(prefs().onboardingStatus,'completed');
      }
    } else if(phase==='completed') {
      assert.equal(await js('document.querySelector("#onboarding").open'),false);
      assert.equal(await js('courses[0].name'),'Original Canvas course');
      await js('openSettings()');assert.equal(await js('document.querySelector("#settings-save-btn").textContent'),'Save');
      await js('document.querySelector("#language-select").value="zh-CN";saveSettings()');
      await wait('document.documentElement.lang==="zh-CN" && typeof courses!=="undefined" && courses.length===1');
      assert.equal(await js('document.querySelector("#onboarding").open'),false);
      assert.equal(await js('courses[0].name'),'Original Canvas course');
    } else if(phase==='skip') {
      await js('openSettings();document.querySelector("#onboarding-replay").click()');
      await wait('document.querySelector("#onboarding").open');
      await js('document.querySelector("#welcome-skip").click()');
      await wait('!document.querySelector("#onboarding").open');
      assert.equal(prefs().onboardingStatus,'skipped');
    } else if(phase==='skipped') {
      await delay(300);assert.equal(await js('document.querySelector("#onboarding").open'),false);
      assert.equal(prefs().onboardingStatus,'skipped');
    } else if(phase==='legacy') {
      assert.equal(await js('courses.length'),1,'Existing courses cannot suppress an unfinished guide');
      assert.equal(prefs().onboardingStatus,'pending');assert.equal(prefs().onboardingStep,0);
    }
    console.log('PASS guide phase:',phase);app.exit(0);
  }
  run().catch(e=>{console.error(e);app.exit(1)});
}
