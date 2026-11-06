// Phone numbers: one account per number. Stored in international form, e.g. +233241234567.
// Shared by the server and the phone app. Ghana (233) is the default country.
function normalizePhone(input, cc = '233') {
  const s = String(input || '').trim().replace(/[\s\-().]/g, '');
  if (!/^\+?\d+$/.test(s)) return null;
  let d;
  if (s.startsWith('+')) d = s.slice(1);
  else if (s.startsWith('00')) d = s.slice(2);
  else if (s.startsWith('0')) d = cc + s.slice(1);
  else if (s.startsWith(cc) && s.length === cc.length + 9) d = s;
  else if (s.length === 9) d = cc + s;
  else return null;
  if (d.startsWith('233') && d.length !== 12) return null;
  if (d.length < 8 || d.length > 15) return null;
  return '+' + d;
}
// "+233 24 123 4567" for display.
function displayPhone(p) {
  const s = String(p || '');
  const m = s.match(/^\+233(\d{2})(\d{3})(\d{4})$/);
  return m ? `+233 ${m[1]} ${m[2]} ${m[3]}` : s || 'Unknown';
}
module.exports = { normalizePhone, displayPhone };
