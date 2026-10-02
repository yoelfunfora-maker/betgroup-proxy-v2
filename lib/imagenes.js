'use strict';

// ==================== FOTOS SIN METADATOS ====================
// Las fotos de comprobantes llegan del móvil. Una foto de cámara lleva datos ocultos (EXIF):
// coordenadas GPS de dónde se hizo, modelo de teléfono, fecha exacta, a veces el nombre del
// dueño. Aquí se eliminan EN MEMORIA antes de guardarla en ningún sitio.
// Solo se acepta JPEG (la web convierte cualquier foto a JPEG antes de enviarla).

const TAMANO_MAXIMO = 1.5 * 1024 * 1024; // 1,5 MB

class ImagenInvalida extends Error {
  constructor(mensaje) { super(mensaje); this.estado = 400; }
}

// Recorre los bloques del JPEG y copia solo los necesarios para dibujar la imagen.
// Se descartan APP1…APP15 (EXIF, GPS, XMP, IPTC, ICC, datos del fabricante) y COM (comentarios).
function limpiarJpeg(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 4 || buf.length > TAMANO_MAXIMO) throw new ImagenInvalida('Foto vacía o demasiado grande (máx. 1,5 MB)');
  if (buf[0] !== 0xFF || buf[1] !== 0xD8) throw new ImagenInvalida('Solo se aceptan fotos JPEG');
  const partes = [buf.subarray(0, 2)]; // SOI
  let i = 2;
  while (i < buf.length) {
    if (buf[i] !== 0xFF) throw new ImagenInvalida('Foto dañada');
    const marca = buf[i + 1];
    if (marca === 0xFF) { i += 1; continue; } // relleno
    if (marca === 0xD9) { partes.push(buf.subarray(i, i + 2)); break; } // EOI
    if (marca >= 0xD0 && marca <= 0xD7) { partes.push(buf.subarray(i, i + 2)); i += 2; continue; }
    if (i + 4 > buf.length) throw new ImagenInvalida('Foto dañada');
    const largo = buf.readUInt16BE(i + 2);
    if (largo < 2 || i + 2 + largo > buf.length) throw new ImagenInvalida('Foto dañada');
    const bloque = buf.subarray(i, i + 2 + largo);
    if (marca === 0xDA) { // SOS: desde aquí son los píxeles, se copian hasta el final
      partes.push(buf.subarray(i));
      break;
    }
    const esMetadato = (marca >= 0xE1 && marca <= 0xEF) || marca === 0xFE;
    if (!esMetadato) partes.push(bloque);
    i += 2 + largo;
  }
  return Buffer.concat(partes);
}

// Sube la foto ya limpia a ImgBB con la clave guardada en el servidor (nunca en la web).
async function subirAImgbb(buf, clave) {
  const cuerpo = new FormData();
  cuerpo.append('image', buf.toString('base64'));
  const r = await fetch(`https://api.imgbb.com/1/upload?key=${encodeURIComponent(clave)}`, { method: 'POST', body: cuerpo, signal: AbortSignal.timeout(30000) });
  const j = await r.json().catch(() => ({}));
  const url = j && j.data && j.data.url;
  if (!r.ok || typeof url !== 'string' || !/^https:\/\/i\.ibb\.co\//.test(url)) throw new Error('ImgBB no aceptó la foto');
  return url;
}

module.exports = { limpiarJpeg, subirAImgbb, ImagenInvalida, TAMANO_MAXIMO };
