/* Only application-owned strings enter the catalog. Interpolated Canvas data
 * is appended after translation and remains exactly as supplied by Canvas. */
window.CanvasI18n = (() => {
  let language = 'zh-CN', catalog = {}, matcher;
  let preferences = { language, onboardingStatus: 'pending', onboardingStep: 0, onboardingSchool: null };
  function t(value) {
    if (language !== 'en' || typeof value !== 'string') return value;
    if (Object.hasOwn(catalog, value)) return catalog[value];
    return value.replace(matcher, word => catalog[word]);
  }
  function html(parts, ...values) {
    return parts.reduce((result, part, index) => result + t(part) + (index < values.length ? values[index] : ''), '');
  }
  function staticDOM(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const node of nodes) if (!node.parentElement?.closest('script,style,[data-no-translate]')) node.nodeValue = t(node.nodeValue);
    for (const el of root.querySelectorAll('[title],[aria-label],[placeholder]')) {
      for (const name of ['title', 'aria-label', 'placeholder']) if (el.hasAttribute(name)) el.setAttribute(name, t(el.getAttribute(name)));
    }
  }
  const ready = (async () => {
    catalog = await (await fetch('locales/en.json')).json();
    matcher = new RegExp(Object.keys(catalog).sort((a,b) => b.length-a.length).map(key => key.replace(/[.*+?^$()|[\]{}\\]/g, '\\$&')).join('|'), 'g');
    preferences = await window.api.uiPreferences?.().catch(() => preferences) || preferences;
    language = preferences.language;
    document.documentElement.lang = language;
    staticDOM(document.body);
    if (language === 'en') document.querySelector('.privacy-text').textContent = 'Anonymous diagnostics are stored locally in data/telemetry.jsonl to help troubleshoot sync and download issues. Nothing is uploaded automatically. Logs include a random installation ID, app version, OS and hardware, feature results, error codes, file sizes and usage counts. They exclude names, student IDs, credentials, course names and course or assignment content.';
  })();
  return { t, html, staticDOM, ready, get language() { return language; }, get preferences() { return preferences; } };
})();
