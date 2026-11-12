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
    const month=s.includes(".")?Number(b):Number(a)>12?Number(b):Number(a),day=s.includes(".")?Number(a):Number(a)>12?Number(a):Number(b);
    const d=new Date(Date.UTC(year,month-1,day));if(d.getUTCFullYear()===year&&d.getUTCMonth()===month-1&&d.getUTCDate()===day)return `${year}-${String(month).padStart(2,"0")}-${String(day).padStart(2,"0")}`;
  }
  if((m=s.match(/^(\d{4})-(\d{2})-(\d{2})$/)))return s;
  if((m=s.match(/^(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})$/))){const month=new Date(`${m[2]} 1, 2000`).getMonth();if(month<0)return null;return `${m[3]}-${String(month+1).padStart(2,"0")}-${String(Number(m[1])).padStart(2,"0")}`}
  const d=new Date(s);return Number.isNaN(d.getTime())?null:d.toISOString().slice(0,10);
}
type LayoutItem={text:string;x:number;y:number};
type LayoutLine={y:number;items:LayoutItem[]};
function layoutLines(items:readonly unknown[]):LayoutLine[]{
 const lines:LayoutLine[]=[];
 for(const item of items){
  const value=item as {str?:unknown;transform?:unknown};
  if(typeof value.str!=="string"||!value.str.trim()||!Array.isArray(value.transform))continue;
  const x=Number(value.transform[4]),y=Number(value.transform[5]);if(!Number.isFinite(x)||!Number.isFinite(y))continue;
  let line=lines.find(candidate=>Math.abs(candidate.y-y)<=2);
  if(!line){line={y,items:[]};lines.push(line)}
  line.items.push({text:value.str.trim(),x,y});
 }
 return lines.sort((a,b)=>b.y-a.y).map(line=>({...line,items:line.items.sort((a,b)=>a.x-b.x)}));
}
function previousMonthEnd(value:string){const date=new Date(`${value}T00:00:00Z`);date.setUTCDate(0);return date.toISOString().slice(0,10)}
function nextDay(value:string){const date=new Date(`${value}T00:00:00Z`);date.setUTCDate(date.getUTCDate()+1);return date.toISOString().slice(0,10)}
function categoryFor(description:string){
 const value=description.toLowerCase();
 if(/\b(reversal|refund|rebate)\b/.test(value))return "income";
 if(/\b(fee|charged|charge|commission|tax|levy|stamp duty)\b/.test(value))return "expense";
 if(/\b(dividend|interest|coupon|distribution|income)\b/.test(value))return "income";
 if(/\b(transfer|remittance|withdrawal|deposit|payment received|payment sent)\b/.test(value))return "transfer";
 if(/\b(capital call|subscription|purchase|buy|sale|sell|redemption|investment)\b/.test(value))return "investment";
 return "unreviewed";
}
function extractTableRows(pages:LayoutLine[][]):Record<string,unknown>[]|null{
 const allRows:Record<string,unknown>[]=[];let foundHeader=false;
 const textOf=(line:LayoutLine)=>line.items.map(item=>item.text).join(" ").replace(/\s+/g," ").trim();
 const columnX=(items:LayoutItem[],pattern:RegExp):number|null=>{
  for(let i=0;i<items.length;i++){
   if(pattern.test(items[i].text))return items[i].x;
   if(i+1<items.length&&pattern.test(`${items[i].text} ${items[i+1].text}`))return items[i].x;
  }
  return null;
 };
 const moneyPattern=/\(?-?\s*(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{2,6})?\)?(?:\s*(?:CR|DR))?/g;
 const datePattern=/\b(?:\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}|\d{4}-\d{2}-\d{2}|\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4})\b/g;
 for(const lines of pages){
  let headerIndex=-1,dateX:number|null=null,orderX:number|null=null,descriptionX:number|null=null,amountX:number|null=null,currencyX:number|null=null,debitX:number|null=null,creditX:number|null=null,balanceX:number|null=null;
  for(let i=0;i<lines.length;i++){
   const labels=textOf(lines[i]).toLowerCase();
   if(/description/.test(labels)&&(/value\s*date/.test(labels)||/\bdate\b/.test(labels))&&(/amount/.test(labels)||/debit/.test(labels)&&/credit/.test(labels))){
    headerIndex=i;const items=lines[i].items;dateX=columnX(items,/^(?:value\s*)?date$/i);orderX=columnX(items,/^order\s*date$/i);descriptionX=columnX(items,/^description$/i);amountX=columnX(items,/^amount$/i);currencyX=columnX(items,/^currency$/i);debitX=columnX(items,/^debit$/i);creditX=columnX(items,/^credit$/i);balanceX=columnX(items,/^balance$/i);break;
   }
  }
  if(headerIndex<0)continue;
  foundHeader=true;
  if(dateX===null||descriptionX===null||(amountX===null&&(debitX===null||creditX===null)))continue;
  for(const line of lines.slice(headerIndex+1)){
   const rowText=textOf(line);if(!rowText)continue;
   const sortedX=[currencyX,debitX,creditX,balanceX,amountX].filter((x):x is number=>x!==null&&x>descriptionX!).sort((a,b)=>a-b)[0];
   const descEnd=sortedX??(line.items.at(-1)?.x??descriptionX+500)+1;
   const valueEnd=orderX!==null&&orderX>dateX?orderX:descriptionX;
   const dateText=line.items.filter(item=>item.x>=dateX!-3&&item.x<valueEnd-2).map(item=>item.text).join(" ").trim();
   const descriptionItems=line.items.filter(item=>item.x>=descriptionX!-3&&item.x<descEnd-2);
   const columnAmount=(x:number|null,nextX:number|null)=>x===null?null:line.items.filter(item=>item.x>=x-4&&(nextX===null||item.x<nextX-2)).map(item=>item.text).join(" ").trim();
   const amountText=columnAmount(amountX,null);
   const debitText=columnAmount(debitX,creditX??balanceX);
   const creditText=columnAmount(creditX,balanceX);
   const balanceText=columnAmount(balanceX,null);
   const currencyText=columnAmount(currencyX,debitX??creditX??balanceX);
   let description=descriptionItems.map(item=>item.text).join(" ").replace(/\s+/g," ").trim();
   if(!description){
    description=rowText;
    for(const match of rowText.matchAll(datePattern))description=description.replace(match[0]," ");
    const amounts=[...description.matchAll(moneyPattern)];if(amounts.length){const last=amounts.at(-1)!;description=`${description.slice(0,last.index)} ${description.slice((last.index??0)+last[0].length)}`}
    description=description.replace(/[|,:;]+/g," ").replace(/\s+/g," ").trim();
   }
   const normalizedDescription=description.toLowerCase();
   const isOpening=/\b(opening balance|balance brought forward|brought forward|bal(?:ance)?\s+b\/?f)\b/.test(normalizedDescription);
   const isCarried=/\b(month end balance|closing balance|balance carried forward|carried forward|bal(?:ance)?\s+c\/?f)\b/.test(normalizedDescription);
   const valueDate=parseDate(dateText)||((isOpening||isCarried)?[...description.matchAll(datePattern)].map(match=>parseDate(match[0])).find((value):value is string=>value!==null)??null:null);
   let debit=debitText?Math.abs(parseMoney([...debitText.matchAll(moneyPattern)].at(-1)?.[0])??0):0;
   let credit=creditText?Math.abs(parseMoney([...creditText.matchAll(moneyPattern)].at(-1)?.[0])??0):0;
   let amount=amountText?parseMoney([...amountText.matchAll(moneyPattern)].at(-1)?.[0]):null;
   if(amount===null){
    const amountMatches=[...rowText.matchAll(moneyPattern)];
    if(amountMatches.length)amount=parseMoney(amountMatches.at(-1)?.[0]);
   }
   if(debitX!==null||creditX!==null){if(!debit&&!credit&&!(isOpening||isCarried))continue;amount=debit-credit}
   let balance=balanceText?parseMoney([...balanceText.matchAll(moneyPattern)].at(-1)?.[0]):null;
   if((isOpening||isCarried)&&!debit&&!credit&&balance!==null)amount=balance;
   if(amount===null)continue;
   if(isOpening||isCarried){balance??=amount;debit=0;credit=0}
   if(!(isOpening||isCarried)&&!debit&&!credit){if(amount>0)debit=amount;else if(amount<0)credit=Math.abs(amount)}
   const rowCurrency=currencyText?.match(/\b[A-Z]{3}\b/)?.[0]??null;
   if(isOpening||isCarried){
    allRows.push({txn_date:valueDate??"",description:isOpening?"Balance brought forward":"Balance carried forward",amount,debit,credit,balance,currency_code:rowCurrency,category:"cash",_balanceKind:isOpening?"opening":"carried"});
   }else if(valueDate&&description){
    allRows.push({txn_date:valueDate,description,amount,debit,credit,balance,currency_code:rowCurrency,category:categoryFor(description)});
   }
  }
 }
 if(!foundHeader)return null;
 const datedTransactions=allRows.filter(row=>!row._balanceKind&&typeof row.txn_date==="string"&&row.txn_date).map(row=>String(row.txn_date)).sort();
 const carried=allRows.find(row=>row._balanceKind==="carried");
 if(carried&&(!carried.txn_date||carried.txn_date==="")&&datedTransactions.length){const lastDate=datedTransactions.at(-1)!;carried.txn_date=new Date(Date.UTC(Number(lastDate.slice(0,4)),Number(lastDate.slice(5,7)),0)).toISOString().slice(0,10)}
 const opening=allRows.find(row=>row._balanceKind==="opening");
 if(opening&&(!opening.txn_date||opening.txn_date==="")){const carriedDate=typeof carried?.txn_date==="string"&&carried.txn_date?carried.txn_date:null;const firstDate=datedTransactions[0];const inferred=carriedDate?previousMonthEnd(carriedDate):firstDate?previousMonthEnd(firstDate):null;if(inferred)opening.txn_date=inferred}
 return allRows.map(({_balanceKind,...row})=>row);
}
function extractRows(text:string,pages:LayoutLine[][]=[]){
 const tableRows=extractTableRows(pages);if(tableRows!==null)return tableRows;
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
   const debit=amount>0?amount:0,credit=amount<0?Math.abs(amount):0;
   output.push({txn_date:txnDate,description,amount,debit,credit,balance:null,currency_code:null,category:categoryFor(description)});
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
  let layout:LayoutLine[][]=[];
  try{const pdfjs=await import("pdfjs-dist/legacy/build/pdf.mjs");const worker=new pdfjs.PDFWorker();await worker.promise;const doc=await pdfjs.getDocument({data:new Uint8Array(bytes),useSystemFonts:true,disableFontFace:true,isEvalSupported:false,worker}).promise;const pages:string[]=[];for(let i=1;i<=doc.numPages;i++){const page=await doc.getPage(i),content=await page.getTextContent();pages.push(content.items.map((item)=>("str" in item?item.str:"")).join(" "));layout.push(layoutLines(content.items))}text=pages.join("\n")}catch(e){return NextResponse.json({error:`Could not read the PDF text layer. It may be a scanned image; OCR is not yet available. ${e instanceof Error?e.message:""}`},{status:422})}
  if(text.trim().length<20)return NextResponse.json({error:"No readable text was found. This PDF may be scanned; OCR is not yet available."},{status:422});
  const transactions=extractRows(text,layout);if(!transactions.length)return NextResponse.json({error:"The PDF text was readable, but no transaction or balance rows were detected. Download a searchable PDF or enter rows manually."},{status:422});
  const dates=transactions.map(x=>String(x.txn_date)).sort();const periodMatch=text.match(/(?:statement period|period|from)\s*[:]?\s*(\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4})\s*(?:to|[-–])\s*(\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4})/i);const brought=transactions.find(x=>x.description==="Balance brought forward"),carried=transactions.find(x=>x.description==="Balance carried forward");
  const currencyCode=/\bMYR\b|RM\s?\d/i.test(text)?"MYR":/\bSGD\b|S\$\s?\d/i.test(text)?"SGD":/\bGBP\b|£\s?\d/i.test(text)?"GBP":/\bEUR\b|€\s?\d/i.test(text)?"EUR":"USD";
  const normalizedTransactions=transactions.map(row=>({...row,currency_code:row.currency_code??currencyCode}));
  return NextResponse.json({transactions:normalizedTransactions,period_start:periodMatch?parseDate(periodMatch[1]):brought?nextDay(String(brought.txn_date)):dates[0],period_end:periodMatch?parseDate(periodMatch[2]):carried?String(carried.txn_date):dates.at(-1),currency_code:currencyCode,pages:transactions.length});
 }catch(e){return NextResponse.json({error:e instanceof Error?e.message:"Unexpected PDF extraction error."},{status:500})}
}
