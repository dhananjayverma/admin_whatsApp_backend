
function validateNumbers(rows) {
  const raw = Array.isArray(rows) ? rows : [];
  const seen = new Set();
  let valid = 0;
  let invalid = 0;
  let duplicate = 0;
  const validList = [];

  for (const r of raw) {
    const phone = String(r?.phone ?? r ?? '')
      .replace(/\D/g, '')
      .slice(0, 20);
    if (!phone) continue;
    const ok = phone.length >= 10 && phone.length <= 15;
    if (seen.has(phone)) {
      duplicate += 1;
    } else {
      if (ok) {
        valid += 1;
        validList.push(phone);
      } else {
        invalid += 1;
      }
      seen.add(phone);
    }
  }

  const total = raw.length;
  return { total, valid, invalid, duplicate, validNumbers: validList };
}

module.exports = { validateNumbers };
