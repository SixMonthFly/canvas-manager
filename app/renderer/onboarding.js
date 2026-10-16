window.CanvasOnboarding = (() => {
  let step = 0, schools, language, selectedSchool, busy = false;
  const $ = selector => document.querySelector(selector);
  const copy = (zh, en) => language === 'en' ? en : zh;
  const schoolNames = { 'hkust-gz': 'HKUST (Guangzhou)', hkust: 'HKUST', cityu: 'City University of Hong Kong', nus: 'National University of Singapore', suss: 'Singapore University of Social Sciences' };
  function render() {
    $('#welcome-progress').textContent = (step + 1) + ' / 4';
    $('#welcome-error').textContent = '';
    $('#welcome-back').textContent = copy('上一步', 'Back');
    $('#welcome-back').hidden = step === 0 || step === 3;
    $('#welcome-next').textContent = step === 3 ? copy('完成指引', 'Finish guide') : step === 2 ? (selectedSchool !== schools.active.id ? copy('切换学校并继续', 'Switch school and continue') : copy('进入应用', 'Enter the app')) : copy('继续', 'Continue');
    $('#welcome-skip').textContent = copy('跳过指引', 'Skip guide');
    $('#welcome-close').setAttribute('aria-label', copy('稍后再看', 'Finish later'));
    const content = $('#welcome-content');
    content.replaceChildren();
    const heading = document.createElement('h2'); heading.id = 'onboarding-title';
    const body = document.createElement('p');
    content.append(heading, body);
    if (step === 0) {
      heading.textContent = copy('让每一课，都有条理。', 'A little clarity. Every course.');
      body.textContent = copy('欢迎使用 Canvas 课程管理。先选择你习惯的界面语言。', 'Welcome to Canvas Manager. Choose the language you feel at home with.');
      const group = document.createElement('div'); group.className = 'welcome-languages';
      for (const [value, label] of [['zh-CN', '简体中文'], ['en', 'English']]) {
        const button = document.createElement('button'); button.type = 'button'; button.textContent = label;
        button.setAttribute('aria-pressed', String(value === language));
        button.onclick = () => { language = value; render(); };
        group.append(button);
      }
      content.append(group);
    } else if (step === 1) {
      heading.textContent = copy('连接你的校园。', 'Your campus, connected.');
      body.textContent = copy('选择你使用 Canvas 的学校。课程数据和登录会话会按学校分别保存。', 'Choose your Canvas school. Each school has its own course data and sign-in session.');
      const label = document.createElement('label'); label.textContent = copy('学校', 'School');
      const select = document.createElement('select'); select.id = 'welcome-school';
      for (const school of schools.schools) {
        const option = document.createElement('option'); option.value = school.id;
        option.textContent = language === 'en' ? school.nameEn || schoolNames[school.id] || school.name : school.name;
        select.append(option);
      }
      select.value = selectedSchool; select.onchange = () => { selectedSchool = select.value; };
      label.append(select); content.append(label);
      const note = document.createElement('p'); note.className = 'welcome-note';
      note.textContent = copy('学校选择会先暂存。进入应用时才会应用；若需要重启，指引会自动继续。', 'Your choice is saved as a draft until you enter the app. If a restart is needed, the guide resumes afterward.');
      content.append(note);
    } else if (step === 2) {
      heading.textContent = copy('你的课程，即将就位。', 'Bring your courses home.');
      body.textContent = selectedSchool !== schools.active.id
        ? copy('下一步会切换到你选择的学校并重启。指引进度已保留，重启后会在应用内继续，带你登录和同步。', 'Next, the app switches to your school and restarts. Your progress is saved; the guide resumes inside the app to help you sign in and sync.')
        : copy('下一步会收起这个窗口，进入可以直接操作的应用界面。我们会在那里带你登录和同步。', 'Next, this window closes so you can use the app directly. The guide will help you sign in and sync there.');
      const note = document.createElement('p'); note.className = 'welcome-note';
      note.textContent = copy('现在无需点击背后的任何按钮。', 'You do not need to click anything behind this window.'); content.append(note);
    } else {
      heading.textContent = copy('试着同步一次。', 'Try your first sync.');
      body.textContent = copy('点击下方按钮登录学校账号。同步后，点左侧课程查看作业、公告和课件。', 'Sign in to your school below. After syncing, select a course on the left to see assignments, announcements and files.');
      const sync = document.createElement('button'); sync.id = 'welcome-sync'; sync.type = 'button'; sync.className = 'primary';
      sync.textContent = copy('登录并同步', 'Sign in and sync');
      sync.onclick = async () => {
        const target = $('#refresh-btn');
        if (target.disabled) return;
        sync.disabled = true;
        try { await target.onclick(); }
        finally { sync.disabled = false; }
      };
      content.append(sync);
    }
  }
  async function persist(patch) { return window.api.uiPreferencesSave?.(patch); }
  async function next() {
    if (busy) return;
    busy = true; $('#welcome-next').disabled = true;
    try {
      if (step === 0) {
        await persist({ language, onboardingStep: 1, onboardingStatus: 'pending' });
        if (language !== window.CanvasI18n.language) { location.reload(); return; }
        step = 1;
      } else if (step === 1) {
        // School selection is a draft until the user finishes the entire guide.
        await persist({ onboardingStep: 2, onboardingSchool: selectedSchool, onboardingStatus: 'pending' });
        step = 2;
      } else if (step === 2) {
        const result = await window.api.onboardingConnect(selectedSchool);
        $('#onboarding').close();
        if (!result.restartRequired) { step = 3; render(); show(); }
        return;
      } else {
        await persist({ onboardingStatus: 'completed', onboardingStep: 3 });
        $('#onboarding').close();
        return;
      }
      render(); $('#welcome-next').focus();
    } catch (error) { $('#welcome-error').textContent = error.message; }
    finally { busy = false; $('#welcome-next').disabled = false; }
  }
  function show() {
    const dialog = $('#onboarding');
    dialog.classList.toggle('welcome-in-app', step === 3);
    // The practical step must never make the controls it describes inert.
    if (step === 3) dialog.show(); else dialog.showModal();
  }
  async function close(skip = false) {
    if (busy) return;
    try {
      await persist({ onboardingStatus: skip ? 'skipped' : 'pending', onboardingStep: step, onboardingSchool: selectedSchool });
      $('#onboarding').close(); $('#settings-btn').focus();
    } catch (error) { $('#welcome-error').textContent = error.message; }
  }
  async function open(config, initialStep = 0) {
    const preferences = await window.api.uiPreferences();
    schools = config; step = initialStep || 0;
    selectedSchool = config.schools.some(s => s.id === preferences.onboardingSchool) ? preferences.onboardingSchool : config.selected;
    await persist({ onboardingStatus: 'pending', onboardingStep: step, onboardingSchool: selectedSchool });
    language = window.CanvasI18n.language; render();
    $('#welcome-next').onclick = next;
    $('#welcome-back').onclick = async () => {
      if (busy) return;
      const previous = Math.max(0, step - 1);
      try { await persist({ onboardingStep: previous }); step = previous; render(); }
      catch (error) { $('#welcome-error').textContent = error.message; }
    };
    $('#welcome-close').onclick = () => close(false);
    $('#welcome-skip').onclick = () => close(true);
    $('#onboarding').oncancel = event => { event.preventDefault(); void close(); };
    $('#onboarding').onkeydown = event => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        if (step === 3) { event.preventDefault(); void close(); }
      }
    };
    show();
    $('#welcome-next').focus();
  }
  return { open };
})();
