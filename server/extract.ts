import puppeteer from 'puppeteer-core'

export interface ExtractedElement {
  selector: string
  text: string
  box: { x: number; y: number; width: number; height: number }
  style: { backgroundColor: string; color: string; fontSize: number; fontWeight: string; borderRadius: number }
  dataComponent?: string
  dataMockupId?: string
}

// puppeteer-core's executablePath requires an absolute, existing path — unlike
// this codebase's other chromium invocations (execFile, which resolves bare
// command names via PATH). This is where the snap wrapper actually lives.
const CHROMIUM_PATH = process.env.CHROMIUM_BIN || '/usr/bin/chromium-browser'

// Runs inside the page (evaluated as a string, not a typed function) so this
// file never needs "DOM" added to tsconfig's lib — that would leak browser
// globals into every other server file for the sake of this one call site.
// Filters to visually meaningful elements only (has direct text, a
// data-component/data-mockup-id marker, a real background, a visible
// border/shadow, or is media) — skipping pure structural wrapper divs, which
// would otherwise dominate the result on any real page.
const BROWSER_SCRIPT = `(function() {
  function shortSelector(el) {
    const parts = []
    let cur = el
    for (let i = 0; i < 3 && cur; i++) {
      let part = cur.tagName.toLowerCase()
      if (cur.id) part += '#' + cur.id
      else if (typeof cur.className === 'string' && cur.className.trim()) part += '.' + cur.className.trim().split(/\\s+/).slice(0, 2).join('.')
      parts.unshift(part)
      cur = cur.parentElement
    }
    return parts.join(' > ')
  }

  const results = []
  const all = document.querySelectorAll('*')
  for (let i = 0; i < all.length; i++) {
    const el = all[i]
    const rect = el.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) continue

    let directText = ''
    for (const node of el.childNodes) {
      if (node.nodeType === 3) directText += node.textContent || ''
    }
    directText = directText.trim()

    const dataComponent = el.getAttribute('data-component') || undefined
    const dataMockupId = el.getAttribute('data-mockup-id') || undefined
    const style = getComputedStyle(el)
    const hasBg = style.backgroundColor && style.backgroundColor !== 'rgba(0, 0, 0, 0)' && style.backgroundColor !== 'transparent'
    const hasBorder = (style.borderTopWidth !== '0px' && style.borderTopStyle !== 'none') || style.boxShadow !== 'none'
    const isMedia = el.tagName === 'IMG' || el.tagName === 'SVG'

    if (!directText && !dataComponent && !dataMockupId && !hasBg && !hasBorder && !isMedia) continue

    results.push({
      selector: shortSelector(el),
      text: directText,
      box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      style: {
        backgroundColor: style.backgroundColor,
        color: style.color,
        fontSize: parseFloat(style.fontSize) || 0,
        fontWeight: style.fontWeight,
        borderRadius: parseFloat(style.borderRadius) || 0,
      },
      dataComponent,
      dataMockupId,
    })
  }
  return results
})()`

async function withPage<T>(url: string, viewport: [number, number], fn: (page: import('puppeteer-core').Page) => Promise<T>): Promise<T> {
  const browser = await puppeteer.launch({
    executablePath: CHROMIUM_PATH,
    headless: true,
    args: ['--no-sandbox', '--disable-gpu'],
  })
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: viewport[0], height: viewport[1] })
    await page.goto(url, { waitUntil: 'networkidle0', timeout: 30_000 })
    return await fn(page)
  } finally {
    await browser.close()
  }
}

export async function extractElements(url: string, viewport: [number, number]): Promise<ExtractedElement[]> {
  return withPage(url, viewport, async (page) => (await page.evaluate(BROWSER_SCRIPT)) as ExtractedElement[])
}

// Same page load does both — a second, separate navigation for the
// screenshot risks drift between what got measured and what got pictured
// (the two are supposed to be the exact same rendered state).
export async function extractElementsAndScreenshot(
  url: string,
  viewport: [number, number],
  screenshotPath: string,
): Promise<ExtractedElement[]> {
  return withPage(url, viewport, async (page) => {
    await page.screenshot({ path: screenshotPath as `${string}.png` })
    return (await page.evaluate(BROWSER_SCRIPT)) as ExtractedElement[]
  })
}
