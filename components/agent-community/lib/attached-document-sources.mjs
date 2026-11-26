import {createHash} from 'node:crypto';

const inlineBytes = 96 * 1024;
const textTypes = new Set(['text/markdown','text/plain','text/csv','application/json']);

// Inputs are the user's upload bytes from this message and the receipt of the attachment store.
// Paths, including paths in document text, are never opened by this reader.
export function attachedDocumentSources(uploaded, stored) {
  if (!Array.isArray(uploaded) || uploaded.length !== stored?.length) return [];
  let remaining = inlineBytes;
  return stored.map((file,index) => {
    const info = {name:file.name,mime:file.mime,bytes:file.size};
    const encoded = uploaded[index]?.dataBase64;
    if (typeof encoded !== 'string') return {...info,readMode:'attachment'};
    const data = Buffer.from(encoded,'base64');
    if (data.length !== file.size) return {...info,readMode:'attachment'};
    const sha256 = createHash('sha256').update(data).digest('hex');
    if (!textTypes.has(file.mime?.split(';',1)[0]) || data.length > remaining || data.includes(0))
      return {...info,sha256,readMode:'attachment'};
    try {
      const text = new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(data);
      remaining -= data.length;
      return {...info,sha256,readMode:'full-text',text};
    } catch { return {...info,sha256,readMode:'attachment'}; }
  });
}
