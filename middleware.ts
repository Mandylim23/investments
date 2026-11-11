import { NextResponse, type NextRequest } from "next/server";
import { createServerClient, type CookieOptions } from "@supabase/ssr";

const isProtected=(pathname:string)=>pathname==="/"||pathname.startsWith("/api/statements");
export async function middleware(request:NextRequest){
 const url=process.env.NEXT_PUBLIC_SUPABASE_URL,anonKey=process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
 if(!url||!anonKey)return NextResponse.next();
 let response=NextResponse.next({request});
 try{
  const supabase=createServerClient(url,anonKey,{cookies:{
   getAll:()=>request.cookies.getAll(),
   setAll(cookies:{name:string;value:string;options:CookieOptions}[]){
    cookies.forEach(({name,value})=>request.cookies.set(name,value));
    response=NextResponse.next({request});
    cookies.forEach(({name,value,options})=>response.cookies.set(name,value,options));
   },
  }});
  const {data:{user}}=await supabase.auth.getUser();
  if(isProtected(request.nextUrl.pathname)&&!user){const target=request.nextUrl.clone();target.pathname="/auth/sign-in";target.searchParams.set("next",request.nextUrl.pathname);return NextResponse.redirect(target)}
  if(request.nextUrl.pathname==="/auth/sign-in"&&user){const target=request.nextUrl.clone();target.pathname="/";target.search="";return NextResponse.redirect(target)}
 }catch{return response}
 return response;
}
export const config={matcher:["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"]};
