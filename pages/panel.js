import { readFileSync } from 'fs'
import { join } from 'path'

export async function getServerSideProps(ctx) {
  const html = readFileSync(join(process.cwd(), 'public', 'panel.html'), 'utf8')
  ctx.res.setHeader('Content-Type', 'text/html; charset=utf-8')
  ctx.res.write(html)
  ctx.res.end()
  return { props: {} }
}

export default function Panel() {
  return null
}
