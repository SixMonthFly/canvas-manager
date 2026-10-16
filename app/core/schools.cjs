const fs = require('node:fs');
const path = require('node:path');

// Only verified Canvas deployments; this list does not imply account-level validation.
const schools = Object.freeze([
  { id: 'hkust-gz', name: '香港科技大学（广州）', region: '内地', origin: 'https://hkust-gz.instructure.com' },
  { id: 'hkust', name: '香港科技大学', region: '香港', origin: 'https://canvas.ust.hk' },
  { id: 'cityu', name: '香港城市大学', region: '香港', origin: 'https://canvas.cityu.edu.hk' },
  { id: 'nus', name: '新加坡国立大学', region: '新加坡', origin: 'https://canvas.nus.edu.sg' },
  { id: 'suss', name: '新加坡社科大学', region: '新加坡', origin: 'https://canvas.suss.edu.sg' },
  {"id": "harvard", "name": "哈佛大学", "nameEn": "Harvard University", "region": "美国", "regionEn": "United States", "continent": "North America", "origin": "https://canvas.harvard.edu", "source": "https://atg.fas.harvard.edu/canvas-behind-scenes"},
  {"id": "oxford", "name": "牛津大学", "nameEn": "University of Oxford", "region": "英国", "regionEn": "United Kingdom", "continent": "Europe", "origin": "https://canvas.ox.ac.uk", "source": "https://login.canvas.ox.ac.uk/"},
  {"id": "unimelb", "name": "墨尔本大学", "nameEn": "University of Melbourne", "region": "澳大利亚", "regionEn": "Australia", "continent": "Oceania", "origin": "https://canvas.lms.unimelb.edu.au", "source": "https://study.unimelb.edu.au/study-with-us/online-courses/current-students/online-systems-support/lms"},
  {"id": "auckland", "name": "奥克兰大学", "nameEn": "University of Auckland", "region": "新西兰", "regionEn": "New Zealand", "continent": "Oceania", "origin": "https://canvas.auckland.ac.nz", "source": "https://teachwell.auckland.ac.nz/canvas/canvas-baseline-practices-2/2-orientation-to-course/"},
  {"id": "wits", "name": "金山大学", "nameEn": "University of the Witwatersrand", "region": "南非", "regionEn": "South Africa", "continent": "Africa", "origin": "https://ulwazi.wits.ac.za", "source": "https://www.wits.ac.za/ulwazi/"},
  {"id": "uc-chile", "name": "智利天主教大学", "nameEn": "Pontificia Universidad Católica de Chile", "region": "智利", "regionEn": "Chile", "continent": "South America", "origin": "https://cursos.canvas.uc.cl", "source": "https://cddoc.uc.cl/servicios/canvas/"},
]);
function getSchool(id) {
  const school = schools.find(s => s.id === id);
  if (!school) throw new Error('不支持的学校');
  return school;
}
function readSchool(root) {
  try { return getSchool(JSON.parse(fs.readFileSync(path.join(root, 'school.json'), 'utf8')).schoolId); }
  catch (error) { if (error.code === 'ENOENT') return getSchool('hkust-gz'); throw error; }
}
function writeSchool(root, id) {
  const school = getSchool(id);
  fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, 'school.json');
  fs.writeFileSync(file + '.tmp', JSON.stringify({ schoolId: school.id }, null, 2));
  fs.renameSync(file + '.tmp', file);
  return school;
}
function schoolDataDir(root, id) {
  getSchool(id);
  return id === 'hkust-gz' ? root : path.join(root, 'schools', id);
}
function schoolPartition(id) { getSchool(id); return id === 'hkust-gz' ? 'persist:canvas' : `persist:canvas-${id}`; }
function isCanvasUrl(value, origin) {
  try { const u = new URL(value); return u.origin === origin && !u.username && !u.password; }
  catch { return false; }
}
module.exports = { schools, getSchool, readSchool, writeSchool, schoolDataDir, schoolPartition, isCanvasUrl };
