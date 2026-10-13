import { crc32, deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { PolicyViolation, inspectContent, sanitizeFilename, validateDeclaration } from './file-policy';
import { parseClamdReply, ScannerUnavailableError } from './clamav';

const MiB = 1024 * 1024;
const policy = { maxBytes: 10 * MiB };

function violation(fn: () => unknown): PolicyViolation {
  try {
    fn();
  } catch (e) {
    if (e instanceof PolicyViolation) return e;
    throw e;
  }
  throw new Error('expected a policy violation');
}

/** Minimal ZIP writer (stored or deflated entries) for structural tests. */
function zip(entries: Array<{ name: string; data: string | Buffer; deflate?: boolean }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data);
    const body = e.deflate ? deflateRawSync(raw) : raw;
    const name = Buffer.from(e.name);
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(e.deflate ? 8 : 0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(e.deflate ? 8 : 0, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, body);
    centrals.push(central, name);
    offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const PNG_1x1 = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const ctXml = '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>';
const EICAR = ['X5O!P%@AP[4\\PZX54(P^)7CC)7}$', 'EICAR-STANDARD-ANTIVIRUS-', 'TEST-FILE!$H+H*'].join('');

describe('validateDeclaration', () => {
  it('accepts allow-listed types and canonicalises MIME aliases', () => {
    expect(validateDeclaration({ name: 'photo.JPG', mime: 'image/jpg', sizeBytes: 10 }, policy).mime).toBe('image/jpeg');
    expect(validateDeclaration({ name: 'doc.pdf', mime: 'application/octet-stream', sizeBytes: 10 }, policy).mime).toBe('application/pdf');
    expect(validateDeclaration({ name: 'notes.txt', mime: 'text/plain; charset=utf-8', sizeBytes: 10 }, policy).mime).toBe('text/plain');
  });

  it('rejects oversized files before transfer', () => {
    expect(violation(() => validateDeclaration({ name: 'big.pdf', mime: 'application/pdf', sizeBytes: 10 * MiB + 1 }, policy)).code).toBe('FILE_TOO_LARGE');
    expect(violation(() => validateDeclaration({ name: 'big.pdf', mime: 'application/pdf', sizeBytes: 3 * MiB }, { maxBytes: 2 * MiB })).code).toBe('FILE_TOO_LARGE');
  });

  it.each([
    ['setup.exe', 'application/x-msdownload', 'executable'],
    ['invoice.pdf.exe', 'application/pdf', 'executable'],
    ['run.sh', 'text/plain', 'script'],
    ['page.html', 'text/html', 'html'],
    ['logo.svg', 'image/svg+xml', 'svg'],
    ['bundle.zip', 'application/zip', 'archive'],
    ['budget.xlsm', 'application/vnd.ms-excel.sheet.macroEnabled.12', 'macro'],
    ['anim.gif', 'image/gif', 'type_not_allowed'],
  ])('blocks %s', (name, mime, reason) => {
    const v = violation(() => validateDeclaration({ name, mime, sizeBytes: 100 }, policy));
    expect(v.code).toBe('FILE_TYPE_BLOCKED');
    expect(v.reason).toBe(reason);
  });

  it('requires MIME↔extension consistency and honours the tenant allow-list', () => {
    expect(violation(() => validateDeclaration({ name: 'a.png', mime: 'application/pdf', sizeBytes: 1 }, policy)).reason).toBe('type_mismatch');
    expect(violation(() => validateDeclaration({ name: 'a.pdf', mime: 'application/pdf', sizeBytes: 1 }, { ...policy, tenantAllowed: ['image/png'] })).reason).toBe('type_not_allowed');
  });

  it('sanitises file names (path, control and bidi override characters)', () => {
    expect(sanitizeFilename('../../etc/pass\u0000wd.txt')).toBe('passwd.txt');
    expect(sanitizeFilename('C:\\Users\\x\\evil\u202Etxt.exe')).toBe('eviltxt.exe');
    expect(sanitizeFilename('<img src=x onerror=alert(1)>.png')).toBe('_img src=x onerror=alert(1)_.png');
  });
});

describe('inspectContent', () => {
  it('accepts a real PNG and a plain PDF', () => {
    expect(inspectContent(PNG_1x1, 'image/png')).toEqual({ ok: true, detectedMime: 'image/png' });
    expect(inspectContent(Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n%%EOF\n'), 'application/pdf')).toEqual({ ok: true, detectedMime: 'application/pdf' });
    expect(inspectContent(Buffer.from('Hello مرحبا 👋\n'), 'text/plain')).toEqual({ ok: true, detectedMime: 'text/plain' });
  });

  it('rejects a renamed executable by magic bytes', () => {
    const exe = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(200, 0x90)]);
    expect(inspectContent(exe, 'image/png')).toMatchObject({ ok: false, reason: 'executable' });
    expect(inspectContent(exe, 'text/plain')).toMatchObject({ ok: false, reason: 'executable' });
  });

  it('rejects the EICAR test signature and type mismatches', () => {
    expect(inspectContent(Buffer.from(EICAR), 'text/plain')).toMatchObject({ ok: false, code: 'FILE_REJECTED', reason: 'malware' });
    expect(inspectContent(PNG_1x1, 'application/pdf')).toMatchObject({ ok: false, reason: 'type_mismatch' });
    expect(inspectContent(Buffer.from('<!DOCTYPE html><script>alert(1)</script>'), 'text/plain')).toMatchObject({ ok: false, reason: 'html' });
  });

  it('rejects PDFs with active content, including hex-escaped names', () => {
    expect(inspectContent(Buffer.from('%PDF-1.7\n<< /OpenAction << /S /JavaScript /JS (app.alert(1)) >> >>'), 'application/pdf')).toMatchObject({ ok: false, reason: 'pdf_active_content' });
    expect(inspectContent(Buffer.from('%PDF-1.7\n<< /S /J#61vaScript >>'), 'application/pdf')).toMatchObject({ ok: false, reason: 'pdf_active_content' });
    expect(inspectContent(Buffer.from('%PDF-1.7\n<< /Type /Action /S /Launch /F (cmd.exe) >>'), 'application/pdf')).toMatchObject({ ok: false, reason: 'pdf_active_content' });
  });

  it('validates OOXML structure and blocks macros', () => {
    const docx = zip([
      { name: '[Content_Types].xml', data: ctXml, deflate: true },
      { name: 'word/document.xml', data: '<w:document/>', deflate: true },
    ]);
    expect(inspectContent(docx, DOCX_MIME)).toEqual({ ok: true, detectedMime: DOCX_MIME });
    const docm = zip([
      { name: '[Content_Types].xml', data: ctXml },
      { name: 'word/document.xml', data: '<w:document/>' },
      { name: 'word/vbaProject.bin', data: 'x' },
    ]);
    expect(inspectContent(docm, DOCX_MIME)).toMatchObject({ ok: false, reason: 'macro' });
    const macroCt = zip([
      { name: '[Content_Types].xml', data: ctXml.replace('document.main+xml', 'document.macroEnabled.main+xml'), deflate: true },
      { name: 'word/document.xml', data: '<w:document/>' },
    ]);
    expect(inspectContent(macroCt, DOCX_MIME)).toMatchObject({ ok: false, reason: 'macro' });
    const plainZip = zip([{ name: 'readme.txt', data: 'hi' }]);
    expect(inspectContent(plainZip, DOCX_MIME)).toMatchObject({ ok: false, reason: 'type_mismatch' });
    const xlsxAsDocx = zip([
      { name: '[Content_Types].xml', data: ctXml },
      { name: 'xl/workbook.xml', data: '<workbook/>' },
    ]);
    expect(inspectContent(xlsxAsDocx, DOCX_MIME)).toMatchObject({ ok: false, reason: 'type_mismatch' });
  });

  it('validates OpenDocument packages', () => {
    const mime = 'application/vnd.oasis.opendocument.text';
    const odt = zip([{ name: 'mimetype', data: mime }, { name: 'content.xml', data: '<office:document-content/>' }]);
    expect(inspectContent(odt, mime)).toEqual({ ok: true, detectedMime: mime });
    const withMacro = zip([{ name: 'mimetype', data: mime }, { name: 'content.xml', data: '<x/>' }, { name: 'Basic/Standard/Module1.xml', data: 'Sub Main' }]);
    expect(inspectContent(withMacro, mime)).toMatchObject({ ok: false, reason: 'macro' });
  });
});

describe('clamd reply parsing', () => {
  it('maps OK / FOUND / ERROR', () => {
    expect(parseClamdReply('stream: OK\0')).toEqual({ status: 'clean' });
    expect(parseClamdReply('stream: Eicar-Test-Signature FOUND\0')).toEqual({ status: 'infected', signature: 'Eicar-Test-Signature' });
    expect(() => parseClamdReply('INSTREAM size limit exceeded. ERROR\0')).toThrow(ScannerUnavailableError);
  });
});
