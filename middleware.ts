import { NextResponse, type NextRequest } from "next/server";
import { createServerClient, type CookieOptions } from "@supabase/ssr";

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
  if(!user){const target=request.nextUrl.clone();target.pathname="/auth/sign-in";target.searchParams.set("next",request.nextUrl.pathname);return NextResponse.redirect(target)}
 }catch{return response}
 return response;
}
export const config={matcher:["/api/statements/:path*"]};
