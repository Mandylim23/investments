"use client";

type LayoutItem = { text: string; x: number; y: number };
type LayoutLine = { y: number; items: LayoutItem[] };
type Progress = (message: string) => void;

function groupTextItems(items: Array<{ str?: string; transform?: number[] }>): LayoutLine[] {
  const lines: LayoutLine[] = [];
  for (const item of items) {
    const text = item.str?.trim();
    const x = Number(item.transform?.[4]);
    const y = Number(item.transform?.[5]);
    if (!text || !Number.isFinite(x) || !Number.isFinite(y)) continue;
    let line = lines.find((candidate) => Math.abs(candidate.y - y) <= 2);
    if (!line) {
      line = { y, items: [] };
      lines.push(line);
    }
    line.items.push({ text, x, y });
  }
  return lines.sort((a, b) => b.y - a.y).map((line) => ({ ...line, items: line.items.sort((a, b) => a.x - b.x) }));
}

function groupOcrWords(words: Array<{ text?: string; bbox?: { x0: number; y0: number; x1: number; y1: number } }>, height: number): LayoutLine[] {
  const lines: LayoutLine[] = [];
  for (const word of words) {
    const text = word.text?.trim();
    const box = word.bbox;
    if (!text || !box) continue;
    const centerTop = (box.y0 + box.y1) / 2;
    const y = height - centerTop;
    const tolerance = Math.max(8, (box.y1 - box.y0) * 0.55);
    let line = lines.find((candidate) => Math.abs(candidate.y - y) <= tolerance);
    if (!line) {
      line = { y, items: [] };
      lines.push(line);
    }
    line.items.push({ text, x: box.x0, y });
  }
  return lines.sort((a, b) => b.y - a.y).map((line) => ({ ...line, items: line.items.sort((a, b) => a.x - b.x) }));
}

export async function extractPdfInBrowser(file: File, onProgress: Progress): Promise<{ text: string; pages: LayoutLine[][] }> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/legacy/build/pdf.worker.min.mjs", import.meta.url).toString();
  const document = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()), useSystemFonts: true }).promise;
  if (document.numPages > 250) throw new Error("This PDF has more than 250 pages. Split it into smaller statements and try again.");

  const pages: LayoutLine[][] = [];
  const scannedPages: number[] = [];
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    onProgress(`Reading PDF text: page ${pageNumber} of ${document.numPages}…`);
    const page = await document.getPage(pageNumber);
    const content = await page.getTextContent();
    const items = content.items.filter((item): item is typeof item & { str: string; transform: number[] } => "str" in item && Boolean(item.str?.trim()));
    const pageLines = groupTextItems(items);
    pages.push(pageLines);
    if (items.reduce((sum, item) => sum + item.str.length, 0) < 80) scannedPages.push(pageNumber - 1);
    page.cleanup();
  }

  if (scannedPages.length) {
    onProgress(`Preparing OCR for ${scannedPages.length} scanned page${scannedPages.length === 1 ? "" : "s"}…`);
    const { createWorker } = await import("tesseract.js");
    const worker = await createWorker("eng", 1, {
      logger: (event) => {
        if (event.status === "recognizing text") onProgress(`Reading scanned pages with OCR… ${Math.round((event.progress ?? 0) * 100)}%`);
      },
    });
    try {
      for (let index = 0; index < scannedPages.length; index += 1) {
        const pageNumber = scannedPages[index] + 1;
        onProgress(`Reading scanned page ${index + 1} of ${scannedPages.length}…`);
        const page = await document.getPage(pageNumber);
        const viewport = page.getViewport({ scale: 1.8 });
        const canvas = window.document.createElement("canvas");
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        const context = canvas.getContext("2d");
        if (!context) throw new Error("Your browser could not prepare a PDF page for OCR.");
        await page.render({ canvasContext: context, viewport }).promise;
        const { data } = await worker.recognize(canvas);
        const words = data.blocks?.flatMap((block) => block.paragraphs.flatMap((paragraph) => paragraph.lines.flatMap((line) => line.words))) ?? [];
        pages[pageNumber - 1] = groupOcrWords(words, canvas.height);
        canvas.width = 0;
        canvas.height = 0;
        page.cleanup();
      }
    } finally {
      await worker.terminate();
    }
  }

  await document.destroy();
  const text = pages.map((lines) => lines.map((line) => line.items.map((item) => item.text).join(" ")).join("\n")).join("\n");
  if (text.trim().length < 20) throw new Error("OCR could not read enough text from this PDF. Please use a clearer scan or a searchable PDF.");
  return { text, pages };
}
