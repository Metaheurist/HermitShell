// Word files and PDF-and-Word bundles as HermitShell sends them, for the unit and browser tests.
// A zip of empty parts with these names: enough for the Worker's look at a Word file's directory.
export function zipOf(names) {
  const enc = new TextEncoder();
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const n of names) {
    const name = enc.encode(n);
    const local = new Uint8Array(30 + name.length);
    new DataView(local.buffer).setUint32(0, 0x04034b50, true);
    new DataView(local.buffer).setUint16(26, name.length, true);
    local.set(name, 30);
    const central = new Uint8Array(46 + name.length);
    const view = new DataView(central.buffer);
    view.setUint32(0, 0x02014b50, true);
    view.setUint16(28, name.length, true);
    view.setUint32(42, offset, true);
    central.set(name, 46);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const size = centrals.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const view = new DataView(end.buffer);
  view.setUint32(0, 0x06054b50, true);
  view.setUint16(8, names.length, true);
  view.setUint16(10, names.length, true);
  view.setUint32(12, size, true);
  view.setUint32(16, offset, true);
  return concat(...locals, ...centrals, end);
}

export const WORD_PARTS = ["[Content_Types].xml", "_rels/.rels", "word/_rels/document.xml.rels", "word/styles.xml", "word/document.xml"];

// A PDF and its Word copy as HermitShell uploads them (cover_letter.doc_bundle).
export function bundle(pdf, word) {
  const head = new Uint8Array(8);
  head.set([0x48, 0x53, 0x44, 0x31]);
  new DataView(head.buffer).setUint32(4, pdf.length);
  return concat(head, pdf, word);
}

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}
