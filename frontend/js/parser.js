// ── ZIP Parser (Central Directory based) ─────────────────────────────────────
async function extractTxtFromZip(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  const dec = new TextDecoder("utf-8");
  const files = [];

  let eocdPos = -1;
  for (let i = bytes.length - 22; i >= 0 && i >= bytes.length - 65557; i--) {
    if (bytes[i]===0x50 && bytes[i+1]===0x4B && bytes[i+2]===0x05 && bytes[i+3]===0x06) {
      eocdPos = i; break;
    }
  }
  if (eocdPos === -1) return files;

  const cdOffset = bytes[eocdPos+16]|(bytes[eocdPos+17]<<8)|(bytes[eocdPos+18]<<16)|(bytes[eocdPos+19]<<24);
  const cdCount = bytes[eocdPos+10]|(bytes[eocdPos+11]<<8);

  let pos = cdOffset;
  for (let e = 0; e < cdCount; e++) {
    if (pos+46 > bytes.length) break;
    if (!(bytes[pos]===0x50 && bytes[pos+1]===0x4B && bytes[pos+2]===0x01 && bytes[pos+3]===0x02)) break;

    const method = bytes[pos+10]|(bytes[pos+11]<<8);
    const cSize = bytes[pos+20]|(bytes[pos+21]<<8)|(bytes[pos+22]<<16)|(bytes[pos+23]<<24);
    const fnLen = bytes[pos+28]|(bytes[pos+29]<<8);
    const exLen = bytes[pos+30]|(bytes[pos+31]<<8);
    const cmLen = bytes[pos+32]|(bytes[pos+33]<<8);
    const localOffset = bytes[pos+42]|(bytes[pos+43]<<8)|(bytes[pos+44]<<16)|(bytes[pos+45]<<24);
    const fname = dec.decode(bytes.slice(pos+46, pos+46+fnLen));

    pos += 46 + fnLen + exLen + cmLen;

    if (!fname.toLowerCase().endsWith(".txt")) continue;

    const lh = localOffset;
    const lhFnLen = bytes[lh+26]|(bytes[lh+27]<<8);
    const lhExLen = bytes[lh+28]|(bytes[lh+29]<<8);
    const dataStart = lh + 30 + lhFnLen + lhExLen;
    const raw = bytes.slice(dataStart, dataStart + cSize);

    if (method === 0) {
      files.push({ filename: fname, content: dec.decode(raw) });
    } else if (method === 8) {
      try {
        const ds = new DecompressionStream("deflate-raw");
        const writer = ds.writable.getWriter();
        writer.write(raw); writer.close();
        const chunks = []; const reader = ds.readable.getReader();
        while (true) { const {done, value} = await reader.read(); if (done) break; chunks.push(value); }
        const total = chunks.reduce((s,c)=>s+c.length,0);
        const result = new Uint8Array(total); let off=0;
        for (const c of chunks) { result.set(c,off); off+=c.length; }
        files.push({ filename: fname, content: dec.decode(result) });
      } catch(err) { console.warn("Failed to decompress:", fname, err); }
    }
  }
  return files;
}

function base64ToArrayBuffer(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

// ── WhatsApp Parser ──────────────────────────────────────────────────────────
function parseWhatsApp(text) {
  const lines = text.split("\n");
  const msgs = [];
  const msgRe = /^(\d{1,2}[\/\.]\d{1,2}[\/\.]\d{2,4}),?\s+(\d{1,2}:\d{2}(?::\d{2})?(?:\s?[AP]M)?)\s*[-–]\s+([^:]+?):\s+(.+)$/;
  const sysRe = /^(\d{1,2}[\/\.]\d{1,2}[\/\.]\d{2,4}),?\s+(\d{1,2}:\d{2})/;
  for (const line of lines) {
    const m = msgRe.exec(line.trim());
    if (m) msgs.push({ date:m[1], time:m[2], sender:m[3].trim(), text:m[4] });
    else if (msgs.length && line.trim() && !sysRe.test(line.trim()))
      msgs[msgs.length-1].text += " " + line.trim();
  }
  return msgs;
}

function parseDateStr(s) {
  const p = s.split(/[\/\.]/);
  if (p.length < 3) return null;
  let [d, mo, y] = p; if (y.length === 2) y = "20" + y;
  return new Date(+y, +mo - 1, +d);
}

function toISODate(d) {
  return d.toISOString().slice(0, 10);
}

function getTopSenders(messages, n = 5) {
  const c = {};
  for (const m of messages) c[m.sender] = (c[m.sender] || 0) + 1;
  return Object.entries(c).sort((a, b) => b[1] - a[1]).slice(0, n).map(([name, count]) => ({ name, count }));
}

function getWeeklyBuckets(messages) {
  const b = {};
  for (const m of messages) {
    const d = parseDateStr(m.date); if (!d) continue;
    const mon = new Date(d); mon.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    const k = mon.toISOString().slice(0, 10);
    if (!b[k]) b[k] = []; b[k].push(m);
  }
  return Object.entries(b).sort((a, b) => a[0] > b[0] ? 1 : -1).map(([week, msgs]) => ({ week, msgs, count: msgs.length }));
}

function detectSilence(messages) {
  if (messages.length < 20) return [];
  const mid = Math.floor(messages.length / 2);
  const first = messages.slice(0, mid), second = messages.slice(mid);
  const fs = new Set(first.map(m => m.sender)), ss = new Set(second.map(m => m.sender));
  const c = {};
  for (const m of first) c[m.sender] = (c[m.sender] || 0) + 1;
  return [...fs].filter(s => !ss.has(s) && c[s] >= 3)
    .sort((a, b) => c[b] - c[a]).slice(0, 5).map(s => ({ name: s, messagesBefore: c[s] }));
}

function getDateRange(messages) {
  const dates = messages.map(m => parseDateStr(m.date)).filter(Boolean).sort((a, b) => a - b);
  if (!dates.length) return { min: null, max: null };
  return { min: toISODate(dates[0]), max: toISODate(dates[dates.length - 1]) };
}
