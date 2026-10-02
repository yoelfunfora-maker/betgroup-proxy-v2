// Limpieza de metadatos de imágenes en memoria (sin dependencias externas).
// Quita EXIF/GPS/XMP/comentarios de JPEG y los bloques de texto/EXIF de PNG,
// para que una foto de un comprobante no revele ubicación, teléfono o equipo.

const FIRMA_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function detectarTipo(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf.length > 8 && buf.subarray(0, 8).equals(FIRMA_PNG)) return 'png';
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return null;
}

// JPEG: se conservan los segmentos de imagen y se descartan APP1..APP15 (EXIF, XMP, IPTC…) y COM.
// APP0 (JFIF) se conserva porque algunos visores lo necesitan.
function limpiarJpeg(buf) {
  const partes = [buf.subarray(0, 2)]; // SOI
  let i = 2;
  while (i < buf.length) {
    if (buf[i] !== 0xff) throw new Error('JPEG corrupto');
    const marcador = buf[i + 1];
    // Inicio de los datos comprimidos: el resto del archivo se copia tal cual
    if (marcador === 0xda) {
      partes.push(buf.subarray(i));
      break;
    }
    // Marcadores sin longitud
    if (marcador === 0xd8 || (marcador >= 0xd0 && marcador <= 0xd7) || marcador === 0x01) {
      partes.push(buf.subarray(i, i + 2));
      i += 2;
      continue;
    }
    if (marcador === 0xd9) { // EOI
      partes.push(buf.subarray(i, i + 2));
      break;
    }
    const longitud = buf.readUInt16BE(i + 2);
    const fin = i + 2 + longitud;
    if (longitud < 2 || fin > buf.length) throw new Error('JPEG corrupto');
    const esMetadato = (marcador >= 0xe1 && marcador <= 0xef) || marcador === 0xfe;
    if (!esMetadato) partes.push(buf.subarray(i, fin));
    i = fin;
  }
  return Buffer.concat(partes);
}

// PNG: se descartan los bloques de texto, EXIF y hora.
const BLOQUES_PNG_PRIVADOS = new Set(['tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME']);

function limpiarPng(buf) {
  const partes = [FIRMA_PNG];
  let i = 8;
  while (i + 12 <= buf.length) {
    const longitud = buf.readUInt32BE(i);
    const tipo = buf.toString('ascii', i + 4, i + 8);
    const fin = i + 12 + longitud;
    if (fin > buf.length) throw new Error('PNG corrupto');
    if (!BLOQUES_PNG_PRIVADOS.has(tipo)) partes.push(buf.subarray(i, fin));
    i = fin;
    if (tipo === 'IEND') break;
  }
  return Buffer.concat(partes);
}

// WEBP: se descartan los bloques EXIF y XMP del contenedor RIFF.
function limpiarWebp(buf) {
  const bloques = [];
  let i = 12;
  while (i + 8 <= buf.length) {
    const tipo = buf.toString('ascii', i, i + 4);
    const longitud = buf.readUInt32LE(i + 4);
    const fin = i + 8 + longitud + (longitud % 2); // los bloques se rellenan a tamaño par
    if (i + 8 + longitud > buf.length) throw new Error('WEBP corrupto');
    if (tipo === 'VP8X' && longitud >= 1) {
      // Se apagan las banderas "tiene EXIF" (0x08) y "tiene XMP" (0x04)
      const copia = Buffer.from(buf.subarray(i, Math.min(fin, buf.length)));
      copia[8] &= ~0x0c;
      bloques.push(copia);
    } else if (tipo !== 'EXIF' && tipo !== 'XMP ') {
      bloques.push(buf.subarray(i, Math.min(fin, buf.length)));
    }
    i = fin;
  }
  const cuerpo = Buffer.concat(bloques);
  const cabecera = Buffer.alloc(12);
  cabecera.write('RIFF', 0, 'ascii');
  cabecera.writeUInt32LE(cuerpo.length + 4, 4);
  cabecera.write('WEBP', 8, 'ascii');
  return Buffer.concat([cabecera, cuerpo]);
}

function limpiarMetadatos(buf) {
  const tipo = detectarTipo(buf);
  if (tipo === 'jpeg') return { tipo, datos: limpiarJpeg(buf) };
  if (tipo === 'png') return { tipo, datos: limpiarPng(buf) };
  if (tipo === 'webp') return { tipo, datos: limpiarWebp(buf) };
  throw new Error('Formato de imagen no permitido');
}

module.exports = { limpiarMetadatos, detectarTipo };
