import { NextResponse, type NextRequest } from "next/server";
import { createServerClient, type CookieOptions } from "@supabase/ssr";

export async function GET(request:NextRequest){
 const url=new URL(request.url),code=url.searchParams.get("code"),next=url.searchParams.get("next")??"/";
 if(!code)return NextResponse.redirect(new URL("/auth/sign-in?error=confirmation",url.origin));
 const response=NextResponse.redirect(new URL(next.startsWith("/")?next:"/",url.origin));
 const supabase=createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!,process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,{cookies:{getAll:()=>request.cookies.getAll(),setAll:(cookies:{name:string;value:string;options:CookieOptions}[])=>cookies.forEach(({name,value,options})=>response.cookies.set(name,value,options))}});
 const {error}=await supabase.auth.exchangeCodeForSession(code);if(error)return NextResponse.redirect(new URL(`/auth/sign-in?error=${encodeURIComponent(error.message)}`,url.origin));return response;
}
