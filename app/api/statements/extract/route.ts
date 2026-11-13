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
 if(/\bfx gain\s*\/\s*loss\b/.test(value))return "FX Gain/Loss";
 if(/\b(?:tax\s+(?:expense|expenses|payment|withholding|withheld)|withholding\s+tax|tax\s+wh)\b/.test(value))return "Tax WH";
 if(/\b(?:expenses?\s+(?:and|&)\s+fees(?:\s+payment)?|security\s+charges)\b/.test(value))return "Security charges";
 if(/\bfees\s+and\s+commissions\b|\b(?:bank\s+charges|bank\s+fees?)\b/.test(value))return "Bank charges";
 if(/\boutgoing\s+remittance\b/.test(value))return "Expenses";
 if(/\binterest\b/.test(value))return "Interest";
 if(/\bdividend\b/.test(value))return "Dividend";
 if(/\b(?:return\s+of\s+capital|capital\s+return|realized\s+gain|realised\s+gain)\b/.test(value))return "Sales";
 if(/\b(?:subscription|investments?|purchase|buy)\b/.test(value))return "Buy";
 return "unreviewed";
}
function isStatementFooter(value:string){return /\bgst\s*reg(?:istration)?\.?\s*no\b/i.test(value)||/\bregistered\s+for\b.{0,100}\b(?:goods\s*(?:and|&)\s*services\s*tax|gst)\b/i.test(value)||/\bpage\s*(?:\d+\s*)?of\s*(?:\d+)?\b/i.test(value)}
function currencyFromAccountLabel(value:string):string|null{
 const text=value.toLowerCase();
 const currencies:[RegExp,string][]=[[/\b(?:norwegian\s+krone|nok)\b/i,"NOK"],[/\b(?:japanese\s+yen|jpy)\b/i,"JPY"],[/\b(?:euro|eur)\b/i,"EUR"],[/\b(?:u\.?s\.?\s*dollar|us\s*dollar|usd)\b/i,"USD"],[/\b(?:swedish\s+krona|sek)\b/i,"SEK"],[/\b(?:danish\s+krone|dkk)\b/i,"DKK"],[/\b(?:swiss\s+franc|chf)\b/i,"CHF"],[/\b(?:british\s+pound|pound\s+sterling|gbp)\b/i,"GBP"],[/\b(?:singapore\s+dollar|sgd)\b/i,"SGD"],[/\b(?:australian\s+dollar|aud)\b/i,"AUD"],[/\b(?:canadian\s+dollar|cad)\b/i,"CAD"],[/\b(?:hong\s*kong\s+dollar|hkd)\b/i,"HKD"],[/\b(?:malaysian\s+ringgit|myr)\b/i,"MYR"]];
 return currencies.find(([pattern])=>pattern.test(text))?.[1]??null;
}
function extractCashLayoutRows(pages:LayoutLine[][]):Record<string,unknown>[]{
 const rows:Record<string,unknown>[]=[];let activeCurrency:string|null=null,inCashSection=false;
 const moneyPattern=/\(?-?\s*(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{2,6})?\)?(?:\s*(?:CR|DR))?/g;
 const datePattern=/\b(?:\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}|\d{4}-\d{2}-\d{2}|\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4})\b/g;
 for(const lines of pages)for(const line of lines){
  const rowText=line.items.map(item=>item.text).join(" ").replace(/\s+/g," ").trim();if(!rowText||isStatementFooter(rowText))continue;
  const sectionCurrency=rowText.match(/(?:cash\s+(?:accounts?|transactions?|activity|movements?)|account\s+currency|currency(?:\s+code)?)\s*(?:in\s+)?[:(\-]*\s*([A-Z]{3})\b/i)?.[1]?.toUpperCase();if(sectionCurrency)activeCurrency=sectionCurrency;
  if(/\bcash\s+(?:transactions?|accounts?|activity|movements?)\b/i.test(rowText))inCashSection=true;
  if(/\b(?:security|investment|portfolio)\s+(?:transactions?|holdings|activity)\b/i.test(rowText))inCashSection=false;
  if(!inCashSection)continue;
  const normalized=rowText.toLowerCase(),isOpening=/\b(opening balance|balance brought forward|brought forward|bal(?:ance)?\s+b\/?f)\b/.test(normalized),isCarried=/\b(month end balance|closing balance|balance carried forward|carried forward|bal(?:ance)?\s+c\/?f)\b/.test(normalized);
  const dates=[...rowText.matchAll(datePattern)];const parsedDates=dates.map(match=>({value:parseDate(match[0]),index:match.index??0,text:match[0]})).filter((item):item is {value:string;index:number;text:string}=>item.value!==null);
  const date=parsedDates[0]?.value??null;
  const parsedDateItems=line.items.filter(item=>new RegExp(datePattern.source).test(item.text));
  const dateEnd=Math.max(-1,...parsedDateItems.map(item=>item.x));
  const rightEdge=Math.max(...line.items.map(item=>item.x)),moneyItems=line.items.filter(item=>item.x>Math.max(dateEnd+120,rightEdge-450)&&new RegExp(moneyPattern.source).test(item.text));
  const moneyValues=moneyItems.flatMap(item=>[...item.text.matchAll(moneyPattern)].map(match=>match[0])).map(value=>parseMoney(value)).filter((value):value is number=>value!==null);
  if(!moneyValues.length)continue;
  const balance=moneyValues.length>=2?moneyValues.at(-1)!:(isOpening||isCarried?moneyValues.at(-1)!:null);
  const amount=(isOpening||isCarried)?balance!:moneyValues.length>=2?moneyValues.at(-2)!:moneyValues[0];
  const firstMoneyX=moneyItems[0]?.x??Infinity;
  let description=line.items.filter(item=>item.x>dateEnd+2&&item.x<firstMoneyX-2).map(item=>item.text).join(" ").replace(/\s+/g," ").trim();
  if(!description){description=rowText;for(const match of dates)description=description.replace(match[0]," ");for(const item of moneyValues)description=description.replace(item.toString()," ");description=description.replace(/(?:cash\s+(?:accounts?|transactions?|activity|movements?)|account\s+currency|currency(?:\s+code)?)\s*(?:in\s+)?[:(\-]*\s*[A-Z]{3}/ig," ").replace(/\s+/g," ").trim()}
  for(const match of dates)description=description.replace(match[0]," ");
  if(!description)continue;
  const txnDate=date??(isOpening||isCarried?parsedDates.at(-1)?.value:null);if(!txnDate&&!isOpening&&!isCarried)continue;
  const debit=!(isOpening||isCarried)&&amount>0?amount:0,credit=!(isOpening||isCarried)&&amount<0?Math.abs(amount):0;
  rows.push({txn_date:txnDate??"",description:isOpening?"Balance brought forward":isCarried?"Balance carried forward":description,amount,debit,credit,balance,currency_code:activeCurrency,category:isOpening||isCarried?"cash":categoryFor(description),_balanceKind:isOpening?"opening":isCarried?"carried":undefined});
 }
 return rows;
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
 const columnXs=(items:LayoutItem[],pattern:RegExp):number[]=>{
  const found:number[]=[];
  for(let i=0;i<items.length;i++){
   if(pattern.test(items[i].text))found.push(items[i].x);
   if(i+1<items.length&&pattern.test(`${items[i].text} ${items[i+1].text}`))found.push(items[i].x);
  }
  return [...new Set(found)].sort((a,b)=>a-b);
 };
 const moneyPattern=/\(?-?\s*(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{2,6})?\)?(?:\s*(?:CR|DR))?/g;
 const datePattern=/\b(?:\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}|\d{4}-\d{2}-\d{2}|\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4})\b/g;
 let activeCurrency:string|null=null;
 for(const lines of pages){
  let headerIndex=-1,dateX:number|null=null,orderX:number|null=null,descriptionX:number|null=null,amountX:number|null=null,currencyX:number|null=null,debitX:number|null=null,creditX:number|null=null,balanceX:number|null=null,forexX:number|null=null,baseAmountX:number|null=null,baseDebitX:number|null=null,baseCreditX:number|null=null,baseBalanceX:number|null=null;
  for(let i=0;i<lines.length;i++){
   const labels=textOf(lines[i]).toLowerCase();
   const hasDate=/\b(?:value|transaction|posting|booking|entry|effective)?\s*date\b/.test(labels),hasDescription=/\b(?:description|details|narrative|particulars|remarks|reference)\b/.test(labels),hasAmount=/\b(?:amount|debit|credit|credits\s*\/\s*debits|withdrawal|deposit|balance|paid\s+in|paid\s+out)\b/.test(labels);
   if(hasDescription&&hasDate&&hasAmount){
    headerIndex=i;const items=lines[i].items;const dates=columnXs(items,/^(?:(?:value|transaction|posting|booking|entry|effective|settlement)\s*)?date$/i);dateX=dates[0]??null;orderX=dates[1]??columnX(items,/^order\s*date$/i);descriptionX=columnX(items,/^(?:transaction\s*)?(?:description|details|narrative|particulars|remarks|reference)$/i);const amounts=columnXs(items,/^(?:amount|transaction\s+amount|transaction\s+value|value|debit\s*\/\s*credit|credits?\s*\/\s*debits?(?:\s+value)?(?:\s+in(?:\s+[A-Z]{3})?)?)$/i),currencies=columnXs(items,/^currency(?:\s+code)?$/i),debits=columnXs(items,/^(?:debit(?:\s+amount)?|withdrawal|paid\s+out|money\s+out)$/i),credits=columnXs(items,/^(?:credit(?:\s+amount)?|deposit|paid\s+in|money\s+in)$/i),balancesFound=columnXs(items,/^(?:(?:running|closing|current)\s+)?balance$/i);amountX=amounts[0]??null;baseAmountX=amounts[1]??null;currencyX=currencies[0]??null;debitX=debits[0]??null;baseDebitX=debits[1]??null;creditX=credits[0]??null;baseCreditX=credits[1]??null;balanceX=balancesFound[0]??null;baseBalanceX=balancesFound[1]??null;forexX=columnX(items,/^(?:forex|fx(?:\s+rate)?|exchange\s+rate)$/i);break;
   }
  }
  if(headerIndex<0)continue;
  foundHeader=true;
  for(const line of lines.slice(0,headerIndex)){const prefixCurrency=textOf(line).match(/(?:cash\s+(?:accounts?|transactions?|activity|movements?)|account\s+currency|currency(?:\s+code)?)\s*[:(\-]*\s*([A-Z]{3})\b/i)?.[1]?.toUpperCase();if(prefixCurrency)activeCurrency=prefixCurrency}
  if(descriptionX===null||(amountX===null&&(debitX===null||creditX===null)))continue;
  const typeX=columnX(lines[headerIndex].items,/^type$/i);
  const sortedColumns=[currencyX,debitX,creditX,balanceX,amountX,forexX,baseDebitX,baseCreditX,baseBalanceX,baseAmountX].filter((x):x is number=>x!==null&&x>descriptionX!).sort((a,b)=>a-b),numericStart=sortedColumns[0]??descriptionX+500;
  const rowLines:LayoutLine[]=[];
  for(const sourceLine of lines.slice(headerIndex+1)){
   const sourceText=textOf(sourceLine);if(!sourceText||isStatementFooter(sourceText))continue;
   const sourceAccountCurrency=currencyFromAccountLabel(sourceText),isSection=/^(?:settled\s+transactions|transactions\s+total|total\s+transactions)$/i.test(sourceText.trim());
   const sourceValueEnd=orderX!==null&&dateX!==null&&orderX>dateX?orderX:descriptionX;
   const hasBookingDate=dateX!==null&&sourceLine.items.some(item=>item.x>=dateX!-3&&item.x<sourceValueEnd-2&&parseDate(item.text)!==null);
   const hasAmountInValueColumns=sourceLine.items.some(item=>item.x>=numericStart-4&&parseMoney(item.text)!==null);
   if(!hasBookingDate&&!hasAmountInValueColumns&&!sourceAccountCurrency&&!isSection&&rowLines.length){
    const continuation=sourceLine.items.filter(item=>item.x>=descriptionX!-3&&item.x<numericStart-2);
    if(continuation.length){rowLines.at(-1)!.items.push(...continuation);continue}
   }
   rowLines.push({...sourceLine,items:[...sourceLine.items]});
  }
  for(const line of rowLines){
   const rowText=textOf(line);if(!rowText||isStatementFooter(rowText))continue;
   const accountCurrency=currencyFromAccountLabel(rowText);if(accountCurrency)activeCurrency=accountCurrency;
   const subtitleCurrency=rowText.match(/(?:cash\s+(?:accounts?|transactions?|activity|movements?)|account\s+currency|currency(?:\s+code)?)\s*[:(\-]*\s*([A-Z]{3})\b/i)?.[1]?.toUpperCase();if(subtitleCurrency)activeCurrency=subtitleCurrency;
   const sortedX=[currencyX,debitX,creditX,balanceX,amountX,forexX,baseDebitX,baseCreditX,baseBalanceX,baseAmountX].filter((x):x is number=>x!==null&&x>descriptionX!).sort((a,b)=>a-b)[0];
   const descEnd=sortedX??(line.items.at(-1)?.x??descriptionX+500)+1;
   const valueEnd=orderX!==null&&dateX!==null&&orderX>dateX?orderX:descriptionX;
   const dateText=dateX===null?"":line.items.filter(item=>item.x>=dateX-3&&item.x<valueEnd-2).map(item=>item.text).join(" ").trim();
   const descriptionItems=line.items.filter(item=>item.x>=descriptionX!-3&&item.x<descEnd-2);
   const columnAmount=(x:number|null,nextX:number|null)=>x===null?null:line.items.filter(item=>item.x>=x-4&&(nextX===null||item.x<nextX-2)).map(item=>item.text).join(" ").trim();
   let rowBaseAmountX=baseAmountX;
   if(rowBaseAmountX===null&&amountX!==null&&debitX===null&&creditX===null){const numericPositions=line.items.filter(item=>item.x>=amountX!-4&&parseMoney(item.text)!==null).map(item=>item.x).sort((a,b)=>a-b),separated:number[]=[];for(const x of numericPositions)if(!separated.length||x-separated.at(-1)!>40)separated.push(x);if(separated.length>=2)rowBaseAmountX=separated.at(-1)!}
   const amountText=columnAmount(amountX,rowBaseAmountX??forexX??baseDebitX??baseCreditX??baseBalanceX);
   const debitText=columnAmount(debitX,creditX??balanceX);
   const creditText=columnAmount(creditX,balanceX);
   const balanceText=columnAmount(balanceX,forexX??baseDebitX??baseCreditX??baseBalanceX??baseAmountX);
   const forexText=columnAmount(forexX,baseDebitX??baseCreditX??baseBalanceX??baseAmountX);
   const baseDebitText=columnAmount(baseDebitX,baseCreditX??baseBalanceX);
   const baseCreditText=columnAmount(baseCreditX,baseBalanceX);
   const baseBalanceText=columnAmount(baseBalanceX,baseAmountX);
   const baseAmountText=columnAmount(rowBaseAmountX,null);
   const currencyText=columnAmount(currencyX,debitX??creditX??balanceX);
   let description=descriptionItems.map(item=>item.text).join(" ").replace(/\s+/g," ").trim();
   if(!description){
    description=rowText;
    for(const match of rowText.matchAll(datePattern))description=description.replace(match[0]," ");
    const amounts=[...description.matchAll(moneyPattern)].reverse();for(const match of amounts)description=`${description.slice(0,match.index)} ${description.slice((match.index??0)+match[0].length)}`
    description=description.replace(/[|,:;]+/g," ").replace(/\s+/g," ").trim();
   }
   const typeText=typeX===null?"":columnAmount(typeX,descriptionX)??"";
   const normalizedDescription=description.toLowerCase();
   const normalizedType=typeText.toLowerCase();
   const isOpening=/\b(opening balance|balance brought forward|brought forward|bal(?:ance)?\s+b\/?f)\b/.test(`${normalizedDescription} ${normalizedType}`);
   const isCarried=/\b(closing balance|month end balance|balance carried forward|carried forward|bal(?:ance)?\s+c\/?f)\b/.test(`${normalizedDescription} ${normalizedType}`);
   const valueDate=parseDate(dateText)||((isOpening||isCarried)?[...description.matchAll(datePattern)].map(match=>parseDate(match[0])).find((value):value is string=>value!==null)??null:null);
   let debit=debitText?Math.abs(parseMoney([...debitText.matchAll(moneyPattern)].at(-1)?.[0])??0):0;
   let credit=creditText?Math.abs(parseMoney([...creditText.matchAll(moneyPattern)].at(-1)?.[0])??0):0;
   let amount=amountText?parseMoney([...amountText.matchAll(moneyPattern)].at(-1)?.[0]):null;
   if(amount===null){
    const amountMatches=[...rowText.matchAll(moneyPattern)];
    if(amountMatches.length)amount=parseMoney(amountMatches.at(-1)?.[0]);
   }
   if(debitX!==null||creditX!==null){if(!debit&&!credit&&!(isOpening||isCarried))continue;amount=debit-credit}else if(amount!==null){debit=amount>0?amount:0;credit=amount<0?Math.abs(amount):0}
   let balance=balanceText?parseMoney([...balanceText.matchAll(moneyPattern)].at(-1)?.[0]):null;
   let exchangeRate=forexText?parseMoney([...forexText.matchAll(moneyPattern)].at(-1)?.[0]):null;
   let baseDebit=baseDebitText?Math.abs(parseMoney([...baseDebitText.matchAll(moneyPattern)].at(-1)?.[0])??0):null;
   let baseCredit=baseCreditText?Math.abs(parseMoney([...baseCreditText.matchAll(moneyPattern)].at(-1)?.[0])??0):null;
   let baseBalance=baseBalanceText?parseMoney([...baseBalanceText.matchAll(moneyPattern)].at(-1)?.[0]):null;
   const baseAmount=baseAmountText?parseMoney([...baseAmountText.matchAll(moneyPattern)].at(-1)?.[0]):null;
   if(exchangeRate===null&&baseAmount!==null&&amount!==null&&amount!==0&&baseAmount!==0)exchangeRate=Math.round(Math.abs(baseAmount/amount)*1_000_000)/1_000_000;
   const exchangeRateSource=exchangeRate===null?null:forexText?"statement":baseAmount!==null?"calculated":"statement";
   if(baseAmount!==null){if(isOpening||isCarried)baseBalance=baseAmount;else if(amount!==null&&amount<0)baseCredit=Math.abs(baseAmount);else if(amount!==null&&amount>0)baseDebit=Math.abs(baseAmount);else if(baseAmount<0)baseCredit=Math.abs(baseAmount);else if(baseAmount>0)baseDebit=baseAmount}
   if((isOpening||isCarried)&&!debit&&!credit&&balance!==null)amount=balance;
   if(amount===null)continue;
   if(isOpening||isCarried){balance??=amount;debit=0;credit=0}
   if(!(isOpening||isCarried)&&!debit&&!credit){if(amount>0)debit=amount;else if(amount<0)credit=Math.abs(amount)}
   const rowCurrency=currencyText?.match(/\b[A-Z]{3}\b/)?.[0]??activeCurrency;
   if(!description&&typeText&&!/^(?:opening|closing) balance$/i.test(typeText))description=typeText;
   if(!description&&accountCurrency&&(isOpening||isCarried))description=typeText;
   if(typeText&&description&&!description.toLowerCase().startsWith(typeText.toLowerCase()))description=`${typeText} — ${description}`;
   if(/^(?:settled transactions|transactions total|total transactions)$/i.test(`${typeText} ${description}`.trim()))continue;
   if(isOpening||isCarried){
    allRows.push({txn_date:valueDate??"",description:isOpening?"Balance brought forward":"Balance carried forward",amount,debit,credit,balance,currency_code:rowCurrency,exchange_rate:exchangeRate,exchange_rate_source:exchangeRateSource,base_debit:baseDebit,base_credit:baseCredit,base_balance:baseBalance,base_debit_source:baseDebit===null?null:"statement",base_credit_source:baseCredit===null?null:"statement",base_balance_source:baseBalance===null?null:"statement",category:"cash",_balanceKind:isOpening?"opening":"carried"});
   }else if(description&&((valueDate!==null)||baseAmount!==null||amount!==null)){
    const category=categoryFor(`${description} ${typeText}`);
    allRows.push({txn_date:valueDate??"",description,amount,debit,credit,balance,currency_code:rowCurrency,exchange_rate:exchangeRate,exchange_rate_source:exchangeRateSource,base_debit:baseDebit,base_credit:baseCredit,base_balance:baseBalance,base_debit_source:baseDebit===null?null:"statement",base_credit_source:baseCredit===null?null:"statement",base_balance_source:baseBalance===null?null:"statement",category,_needsStatementDate:valueDate===null});
   }
  }
 }
 if(!allRows.length){const looseRows=extractCashLayoutRows(pages);if(looseRows.length){allRows.push(...looseRows);foundHeader=true}}
 if(!foundHeader)return null;
 const datedTransactions=allRows.filter(row=>!row._balanceKind&&typeof row.txn_date==="string"&&row.txn_date).map(row=>String(row.txn_date)).sort();
 const lastTxnDate=datedTransactions.at(-1)??"";
 const statementEndDate=lastTxnDate?new Date(Date.UTC(Number(lastTxnDate.slice(0,4)),Number(lastTxnDate.slice(5,7)),0)).toISOString().slice(0,10):"";
 if(statementEndDate)for(const row of allRows)if(row._needsStatementDate)row.txn_date=statementEndDate;
 const carried=allRows.find(row=>row._balanceKind==="carried");
 if(carried&&(!carried.txn_date||carried.txn_date==="")&&datedTransactions.length){const lastDate=datedTransactions.at(-1)!;carried.txn_date=new Date(Date.UTC(Number(lastDate.slice(0,4)),Number(lastDate.slice(5,7)),0)).toISOString().slice(0,10)}
 const opening=allRows.find(row=>row._balanceKind==="opening");
 if(opening&&(!opening.txn_date||opening.txn_date==="")){const carriedDate=typeof carried?.txn_date==="string"&&carried.txn_date?carried.txn_date:null;const firstDate=datedTransactions[0];const inferred=carriedDate?previousMonthEnd(carriedDate):firstDate?previousMonthEnd(firstDate):null;if(inferred)opening.txn_date=inferred}
 const balances=new Map<string,number>();
 for(const row of allRows){const code=typeof row.currency_code==="string"?row.currency_code:"USD";const sourceBalance=typeof row.balance==="number"?row.balance:null;
  if(row._balanceKind==="opening"){balances.set(code,sourceBalance??Number(row.amount));continue}
  if(row._balanceKind==="carried"){const ending=sourceBalance??balances.get(code)??Number(row.amount);row.balance=ending;balances.set(code,ending);continue}
  const prior=balances.get(code);if(prior!==undefined){const calculated=Math.round((prior+Number(row.amount))*100)/100;row.balance=sourceBalance??calculated;balances.set(code,row.balance as number)}
 }
 return allRows.map(({_balanceKind,_needsStatementDate,...row})=>row);
}
function extractRows(text:string,pages:LayoutLine[][]=[]){
 const tableRows=extractTableRows(pages);if(tableRows!==null&&tableRows.length)return tableRows;
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
  let text="",layout:LayoutLine[][]=[];
  if(request.headers.get("content-type")?.includes("application/json")){
   const body=await request.json() as {pages?:unknown};
   if(!Array.isArray(body.pages)||body.pages.length>250)return NextResponse.json({error:"Invalid extracted PDF data."},{status:400});
   layout=body.pages.map((page)=>{
    if(!Array.isArray(page))throw new Error("Invalid PDF page layout.");
    return page.slice(0,20_000).flatMap((line)=>{
     if(!line||typeof line!=="object")return [];
     const value=line as {y?:unknown;items?:unknown};if(!Array.isArray(value.items))return [];
     const y=Number(value.y);if(!Number.isFinite(y))return [];
     const items=value.items.slice(0,2_000).flatMap((item)=>{
      if(!item||typeof item!=="object")return [];
      const entry=item as {text?:unknown;x?:unknown;y?:unknown};const x=Number(entry.x),itemY=Number(entry.y);
      return typeof entry.text==="string"&&entry.text.length<=2_000&&Number.isFinite(x)&&Number.isFinite(itemY)?[{text:entry.text,x,y:itemY}]:[];
     });
     return items.length?[{y,items}]:[];
    });
   });
   text=layout.map((page)=>page.map((line)=>line.items.map((item)=>item.text).join(" ")).join("\n")).join("\n");
  }else if(request.headers.get("content-type")?.includes("multipart/form-data")){
   const form=await request.formData(),file=form.get("file");if(!(file instanceof File))return NextResponse.json({error:"Upload a PDF statement."},{status:400});
   if(file.size>20*1024*1024)return NextResponse.json({error:"PDF must be 20 MB or smaller."},{status:413});if(file.type!=="application/pdf"&&!file.name.toLowerCase().endsWith(".pdf"))return NextResponse.json({error:"Only PDF statements are supported."},{status:415});
   const bytes=Buffer.from(await file.arrayBuffer());if(bytes.subarray(0,5).toString()!=="%PDF-")return NextResponse.json({error:"This file does not appear to be a valid PDF."},{status:400});
   try{const pdfjs=await import("pdfjs-dist/legacy/build/pdf.mjs");const worker=new pdfjs.PDFWorker();await worker.promise;const doc=await pdfjs.getDocument({data:new Uint8Array(bytes),useSystemFonts:true,disableFontFace:true,isEvalSupported:false,worker}).promise;const pages:string[]=[];for(let i=1;i<=doc.numPages;i++){const page=await doc.getPage(i),content=await page.getTextContent();pages.push(content.items.map((item)=>("str" in item?item.str:"")).join(" "));layout.push(layoutLines(content.items))}text=pages.join("\n")}catch(e){return NextResponse.json({error:`Could not read the PDF text layer. Use the browser OCR flow to process scanned PDFs. ${e instanceof Error?e.message:""}`},{status:422})}
  }else return NextResponse.json({error:"Send extracted PDF data or a PDF statement."},{status:400});
  if(text.trim().length<20)return NextResponse.json({error:"No readable text was found. This PDF may be scanned; use the browser OCR flow to read it."},{status:422});
  const transactions=extractRows(text,layout);if(!transactions.length)return NextResponse.json({error:"No transaction or balance rows were detected. Check that the statement pages are clear and include the cash transaction section."},{status:422});
  const dates=transactions.map(x=>String(x.txn_date)).filter(Boolean).sort();const periodMatch=text.match(/(?:statement period|period|from)\s*[:]?\s*(\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4})\s*(?:to|[-–])\s*(\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4})/i);const brought=transactions.find(x=>x.description==="Balance brought forward"),carried=transactions.find(x=>x.description==="Balance carried forward");
  const sectionCurrency=text.match(/(?:cash\s+(?:accounts?|transactions?|activity|movements?)|account\s+currency|currency(?:\s+code)?)\s*(?:in\s+)?[:(\-]*\s*([A-Z]{3})\b/i)?.[1]?.toUpperCase()??currencyFromAccountLabel(text);
  const currencyCode=sectionCurrency??(/\bNOK\b|norwegian\s+krone/i.test(text)?"NOK":/\bJPY\b|japanese\s+yen/i.test(text)?"JPY":/\bMYR\b|RM\s?\d/i.test(text)?"MYR":/\bSGD\b|S\$\s?\d/i.test(text)?"SGD":/\bGBP\b|£\s?\d/i.test(text)?"GBP":/\bEUR\b|€\s?\d/i.test(text)?"EUR":/\bAUD\b/i.test(text)?"AUD":/\bSEK\b/i.test(text)?"SEK":/\bUSD\b|US\$\s?\d|U\.?S\.?\s*dollar/i.test(text)?"USD":"USD");
  const normalizedTransactions=transactions.map(row=>({...row,currency_code:row.currency_code??currencyCode,base_currency_code:"USD"}));
  return NextResponse.json({transactions:normalizedTransactions,period_start:periodMatch?parseDate(periodMatch[1]):brought&&brought.txn_date?nextDay(String(brought.txn_date)):dates[0],period_end:periodMatch?parseDate(periodMatch[2]):carried?.txn_date||dates.at(-1),currency_code:currencyCode,base_currency_code:"USD",pages:transactions.length});
 }catch(e){return NextResponse.json({error:e instanceof Error?e.message:"Unexpected PDF extraction error."},{status:500})}
}
