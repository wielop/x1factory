import { NextResponse } from 'next/server'

export function middleware(request) {
  const { pathname } = request.nextUrl

  if (pathname === '/panel') {
    const url = request.nextUrl.clone()
    url.pathname = '/panel.html'
    return NextResponse.rewrite(url)
  }
}

export const config = {
  matcher: '/panel'
}
