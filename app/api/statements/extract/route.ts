import { NextResponse } from "next/server";
import { createHash } from "node:crypto";

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
  const s = value.trim(); let m: RegExpMatchArray | null;
  if ((m=s.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})$/))) {
    const [,a,b,c]=m; const year=c.length===2?Number(c)<70?2000+Number(c):1900+Number(c):Number(c);
    const day=Number(a)>12?Number(a):Number(b)>12?Number(b):Number(a),month=Number(a)>12?Number(b):Number(a);
    const d=new Date(Date.UTC(year,month-1,day)); if(d.getUTCFullYear()===year&&d.getUTCMonth()===month-1&&d.getUTCDate()===day)return `${year}-${String(month).padStart(2,"0")}-${String(day).padStart(2,"0")}`;
  }
  if ((m=s.match(/^(\d{4})-(\d{2})-(\d{2})$/)))return s;
  const d=new Date(s);return Number.isNaN(d.getTime())?null:d.toISOString().slice(0,10);
}
function classify(description:string){const d=description.toLowerCase();if(/interest|coupon/.test(d))return {transaction_type:"interest",category:"income"};if(/dividend|distribution/.test(d))return {transaction_type:"dividend",category:"income"};if(/fee|charge|commission/.test(d))return {transaction_type:"fee",category:"expense"};if(/buy|purchase|subscribe|subscription|allotment/.test(d))return {transaction_type:"buy",category:"investment"};if(/sell|sale|redeem|redemption|maturity|disposal/.test(d))return {transaction_type:"sale",category:"investment"};if(/transfer|sweep/.test(d))return {transaction_type:"transfer",category:"transfer"};return {transaction_type:"cash",category:"unreviewed"}}
function extractRows(text:string){
 const output=[] as Record<string,unknown>[],seen=new Set<string>();
 const lines=text.replace(/\r/g,"").split("\n").map(s=>s.replace(/\s+/g," ").trim()).filter(Boolean);
 const datePattern=/\b(\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}|\d{4}-\d{2}-\d{2}|\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4})\b/;
 const moneyPattern=/\(?-?\s*(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{2,6})?\)?(?:\s*(?:CR|DR))?/g;
 for(const [index,line] of lines.entries()){
  const dm=line.match(datePattern);if(!dm)continue;const txnDate=parseDate(dm[0]);if(!txnDate)continue;
  const rest=line.slice((dm.index??0)+dm[0].length);const matches=[...rest.matchAll(moneyPattern)];if(!matches.length)continue;
  const vals=matches.map(m=>parseMoney(m[0])).filter((v):v is number=>v!==null);if(!vals.length)continue;
  const description=rest.slice(0,matches[0].index).replace(/^[\s|,:;-]+|[\s|,:;-]+$/g,"").trim()||"Statement entry";
  const key=`${txnDate}|${description}|${vals.join("|")}`;if(seen.has(key))continue;seen.add(key);
  const amount=vals.length>=2?vals.at(-2)!:vals[0];const balance=vals.length>=2?vals.at(-1):null;
  const type=classify(description);const security=description.match(/(?:^|\s)([A-Z]{2,6}(?:\.[A-Z]{1,3})?)(?:\s|$)/)?.[1]??null;
  output.push({id:`row-${index}-${createHash("sha1").update(key).digest("hex").slice(0,8)}`,import_id:"pending",txn_date:txnDate,description,reference:null,...type,asset_class:/bond|note|coupon|maturity/i.test(description)?"bond":/private equity/i.test(description)?"private_equity":/fund|equity|share|stock/i.test(description)?"equity":null,security_name:security?description.replace(security,"").trim():null,ticker:security,units:null,unit_price:null,accrued_interest:0,amount,balance,cost_value:null,market_value:null,unrealized_pnl:null,confidence:vals.length>=2?.7:.45,is_reviewed:false});
 }
 return output;
}
export async function POST(request:Request){
 try{
  if(!request.headers.get("content-type")?.includes("multipart/form-data"))return NextResponse.json({error:"Send a PDF statement as multipart form data."},{status:400});
  const form=await request.formData(),file=form.get("file");if(!(file instanceof File))return NextResponse.json({error:"Upload a PDF statement."},{status:400});
  if(file.size>20*1024*1024)return NextResponse.json({error:"PDF must be 20 MB or smaller."},{status:413});if(file.type!=="application/pdf"&&!file.name.toLowerCase().endsWith(".pdf"))return NextResponse.json({error:"Only PDF statements are supported."},{status:415});
  const bytes=Buffer.from(await file.arrayBuffer());if(bytes.subarray(0,5).toString()!=="%PDF-")return NextResponse.json({error:"This file does not appear to be a valid PDF."},{status:400});
  let text="";
  try{const pdfjs=await import("pdfjs-dist/legacy/build/pdf.mjs");const doc=await pdfjs.getDocument({data:new Uint8Array(bytes),useSystemFonts:true,disableFontFace:true}).promise;const pages:string[]=[];for(let i=1;i<=doc.numPages;i++){const page=await doc.getPage(i),content=await page.getTextContent();pages.push(content.items.map((item)=>("str" in item?item.str:"")).join(" "))}text=pages.join("\n")}catch(e){return NextResponse.json({error:`Could not read the PDF text layer. It may be a scanned image; OCR is not yet available. ${e instanceof Error?e.message:""}`},{status:422})}
  if(text.trim().length<20)return NextResponse.json({error:"No readable text was found. This PDF may be scanned; OCR is not yet available."},{status:422});
  const transactions=extractRows(text);if(!transactions.length)return NextResponse.json({error:"The PDF text was readable, but no dated transaction rows were detected. Download a searchable PDF or enter rows manually."},{status:422});
  const dates=transactions.map(x=>String(x.txn_date)).sort();const periodMatch=text.match(/(?:statement period|period|from)\s*[:]?\s*(\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4})\s*(?:to|[-–])\s*(\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4})/i);
  return NextResponse.json({transactions,period_start:periodMatch?parseDate(periodMatch[1]):dates[0],period_end:periodMatch?parseDate(periodMatch[2]):dates.at(-1),currency_code:/\bMYR\b|RM\s?\d/i.test(text)?"MYR":/\bSGD\b|S\$\s?\d/i.test(text)?"SGD":/\bGBP\b|£\s?\d/i.test(text)?"GBP":/\bEUR\b|€\s?\d/i.test(text)?"EUR":"USD",pages:transactions.length,source_text:text.slice(0,100000)});
 }catch(e){return NextResponse.json({error:e instanceof Error?e.message:"Unexpected PDF extraction error."},{status:500})}
}
