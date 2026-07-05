import { extractText } from 'unpdf';

export async function extractPdfText(buffer: Buffer): Promise<string> {
  try {
    const { text } = await extractText(buffer, { mergePages: true });
    return text;
  } catch {
    return '';
  }
}

export function isPdf(buffer: Buffer, contentType: string): boolean {
  if (contentType.toLowerCase().includes('application/pdf')) return true;
  return buffer.subarray(0, 5).toString('latin1') === '%PDF-';
}
