/**
 * Extract document title metadata from PDF, DOCX, XLSX files.
 * Lightweight: only reads title, not full content.
 */

import fs from "node:fs";
import { Buffer } from "node:buffer";

/**
 * Extract title from a PDF file using pdf-parse.
 */
async function extractPdfTitle(filepath: string): Promise<string | null> {
  try {
    const { PDFParse } = await import("pdf-parse");
    const data = fs.readFileSync(filepath);
    const pdf = new PDFParse({ data });
    const info = await pdf.getInfo();
    const title = info.info?.Title as string | undefined;
    await pdf.destroy();
    return title || null;
  } catch {
    return null;
  }
}

/**
 * Extract title from a DOCX file by reading docProps/core.xml from the ZIP.
 * DOCX is a ZIP containing XML files; title is in dc:title element.
 */
async function extractDocxTitle(filepath: string): Promise<string | null> {
  try {
    const { Readable } = await import("node:stream");
    const { createReadStream } = await import("node:fs");
    // Use a simple approach: read the ZIP and find core.xml
    const AdmZip = (await import("adm-zip")).default;
    const zip = new AdmZip(filepath);
    const coreXml = zip.readAsText("docProps/core.xml");
    if (!coreXml) return null;

    // Extract <dc:title>...</dc:title>
    const match = coreXml.match(/<dc:title[^>]*>([\s\S]*?)<\/dc:title>/);
    return match?.[1]?.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Extract title from an XLSX file using exceljs (reads workbook properties).
 */
async function extractXlsxTitle(filepath: string): Promise<string | null> {
  try {
    const ExcelJS = await import("exceljs");
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(filepath);
    return (workbook as any).title || (workbook as any).properties?.title || null;
  } catch {
    return null;
  }
}

/**
 * Extract title from a PPTX file (same ZIP structure as DOCX).
 */
async function extractPptxTitle(filepath: string): Promise<string | null> {
  // PPTX uses the same docProps/core.xml structure as DOCX
  return extractDocxTitle(filepath);
}

/**
 * Extract document title based on file extension.
 * Returns null if extraction fails or format is unsupported.
 */
export async function extractDocTitle(
  filepath: string,
  extension: string,
): Promise<string | null> {
  switch (extension) {
    case "pdf":
      return extractPdfTitle(filepath);
    case "docx":
      return extractDocxTitle(filepath);
    case "xlsx":
      return extractXlsxTitle(filepath);
    case "pptx":
      return extractPptxTitle(filepath);
    default:
      return null;
  }
}
