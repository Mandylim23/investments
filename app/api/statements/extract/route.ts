import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import "pdfjs-dist/legacy/build/pdf.worker.mjs";

export const runtime = "nodejs";
export const maxDuration = 60;

function parseMoney(value: string | undefined): number | null {
  if (!value) return null;
  const negative = /^\s*\(.*\)\s*$/.test(value) || /^\s*-/.test(value);
  const cleaned = value.replace(/[,$£€()\s]/g, "").replace(/^(?:CR|DR)/i, "");
  const n = Number(cleaned);
  return Number.isFinite(n) ? negative ? -Math.abs(n) : n : null;
}
function parseDate(value: string): string | null {
  const s=value.trim();let m:RegExpMatchArray|null;
  if((m=s.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})$/))){
    const [,a,b,c]=m;const year=c.length===2?Number(c)<70?2000+Number(c):1900+Number(c):Number(c);
    const month=Number(a)>12?Number(b):Number(a),day=Number(a)>12?Number(a):Number(b);
    const d=new Date(Date.UTC(year,month-1,day));if(d.getUTCFullYear()===year&&d.getUTCMonth()===month-1&&d.getUTCDate()===day)return `${year}-${String(month).padStart(2,"0")}-${String(day).padStart(2,"0")}`;
  }
  if((m=s.match(/^(\d{4})-(\d{2})-(\d{2})$/)))return s;
  if((m=s.match(/^(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})$/))){const month=new Date(`${m[2]} 1, 2000`).getMonth();if(month<0)return null;return `${m[3]}-${String(month+1).padStart(2,"0")}-${String(Number(m[1])).padStart(2,"0")}`}
  const d=new Date(s);return Number.isNaN(d.getTime())?null:d.toISOString().slice(0,10);
}
function extractRows(text:string){
 const output=[] as Record<string,unknown>[],seen=new Set<string>();
 const lines=text.replace(/\r/g,"").split("\n").map(s=>s.replace(/\s+/g," ").trim()).filter(Boolean);
 const datePattern=/\b(\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}|\d{4}-\d{2}-\d{2}|\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4})\b/g;
 const moneyPattern=/\(?-?\s*(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{2,6})?\)?(?:\s*(?:CR|DR))?/g;
 for(const line of lines){
  const dateMatches=[...line.matchAll(datePattern)];for(let dateIndex=0;dateIndex<dateMatches.length;dateIndex++){const dm=dateMatches[dateIndex];
   const txnDate=parseDate(dm[0]);if(!txnDate)continue;
   const rest=line.slice((dm.index??0)+dm[0].length,dateMatches[dateIndex+1]?.index??line.length);const matches=[...rest.matchAll(moneyPattern)];if(!matches.length)continue;
   const valueStart=matches.length>=2?(matches.at(-2)?.index??0):(matches[0].index??0);
   const detail=rest.slice(0,valueStart);const description=detail.replace(/\b\d+(?:,\d{3})*(?:\.\d+)?\s+(?:shares?|units?)\b/ig,"").replace(/\b(?:at|@)\s*\$?\s*\d+(?:\.\d+)?/ig,"").replace(/^[\s|,:;-]+|[\s|,:;-]+$/g,"").trim()||"Statement entry";
   const vals=matches.slice(matches.length>=2?-2:0).map(m=>parseMoney(m[0])).filter((v):v is number=>v!==null);if(!vals.length)continue;
   const key=`${txnDate}|${description}|${vals.join("|")}`;if(seen.has(key))continue;seen.add(key);
   const amount=vals[0];
   output.push({txn_date:txnDate,description,amount});
  }
 } return output;
}
export async function POST(request:Request){
 try{
  if(!request.headers.get("content-type")?.includes("multipart/form-data"))return NextResponse.json({error:"Send a PDF statement as multipart form data."},{status:400});
  const form=await request.formData(),file=form.get("file");if(!(file instanceof File))return NextResponse.json({error:"Upload a PDF statement."},{status:400});
  if(file.size>20*1024*1024)return NextResponse.json({error:"PDF must be 20 MB or smaller."},{status:413});if(file.type!=="application/pdf"&&!file.name.toLowerCase().endsWith(".pdf"))return NextResponse.json({error:"Only PDF statements are supported."},{status:415});
  const bytes=Buffer.from(await file.arrayBuffer());if(bytes.subarray(0,5).toString()!=="%PDF-")return NextResponse.json({error:"This file does not appear to be a valid PDF."},{status:400});
  let text="";
  try{const pdfjs=await import("pdfjs-dist/legacy/build/pdf.mjs");const worker=new pdfjs.PDFWorker();await worker.promise;const doc=await pdfjs.getDocument({data:new Uint8Array(bytes),useSystemFonts:true,disableFontFace:true,isEvalSupported:false,worker}).promise;const pages:string[]=[];for(let i=1;i<=doc.numPages;i++){const page=await doc.getPage(i),content=await page.getTextContent();pages.push(content.items.map((item)=>("str" in item?item.str:"")).join(" "))}text=pages.join("\n")}catch(e){return NextResponse.json({error:`Could not read the PDF text layer. It may be a scanned image; OCR is not yet available. ${e instanceof Error?e.message:""}`},{status:422})}
  if(text.trim().length<20)return NextResponse.json({error:"No readable text was found. This PDF may be scanned; OCR is not yet available."},{status:422});
  const transactions=extractRows(text);if(!transactions.length)return NextResponse.json({error:"The PDF text was readable, but no dated transaction rows were detected. Download a searchable PDF or enter rows manually."},{status:422});
  const dates=transactions.map(x=>String(x.txn_date)).sort();const periodMatch=text.match(/(?:statement period|period|from)\s*[:]?\s*(\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4})\s*(?:to|[-–])\s*(\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4})/i);
  return NextResponse.json({transactions,period_start:periodMatch?parseDate(periodMatch[1]):dates[0],period_end:periodMatch?parseDate(periodMatch[2]):dates.at(-1),currency_code:/\bMYR\b|RM\s?\d/i.test(text)?"MYR":/\bSGD\b|S\$\s?\d/i.test(text)?"SGD":/\bGBP\b|£\s?\d/i.test(text)?"GBP":/\bEUR\b|€\s?\d/i.test(text)?"EUR":"USD",pages:transactions.length});
 }catch(e){return NextResponse.json({error:e instanceof Error?e.message:"Unexpected PDF extraction error."},{status:500})}
}
